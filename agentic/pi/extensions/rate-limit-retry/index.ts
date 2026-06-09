/**
 * Indefinite retry for 429 (rate limit) errors.
 *
 * The built-in retry in pi-coding-agent handles transient errors (including 429s)
 * with exponential backoff, but caps out at maxRetries: 3. This extension extends
 * that to indefinite retries for rate limits specifically — since 429s are bound
 * to clear eventually, there's no point giving up.
 *
 * When agent_end fires with a 429 error, we inject a hidden prompt asking the model
 * to continue. The model picks up where it left off and retries the request. This
 * repeats until the rate limit clears.
 *
 * Invisibility & the assistant-role gotcha:
 *   The nudge is a `display: false` custom message sent with `{ triggerTurn: true }`
 *   (same mechanism as the double-check extension) — it reaches the LLM as a user
 *   turn but never renders in the chat. This also sidesteps a runtime crash:
 *   `sendUserMessage` routes through pi's `prompt()`, which runs a compaction check
 *   against the *errored assistant message* the 429 leaves as the transcript tail
 *   and then calls `agent.continue()` on it — throwing
 *   "Cannot continue from message role: assistant". `sendMessage(..., { triggerTurn })`
 *   goes straight to the agent prompt and skips that path.
 *
 * Loop safety:
 *   - `retrying429` is true for the lifetime of an injected retry loop, preventing
 *     re-triggering on the injected turn's own agent_end.
 *   - Each user turn gets at most one 429-retry injection, but if that injection
 *     also hits 429 and exhausts the built-in retry, it triggers another injection,
 *     and so on indefinitely.
 *
 * Non-interactive mode: suppressed in print/headless mode (-p) to avoid delaying
 * scripted/CI contexts.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * Minimal view of an agent message — just the fields we read.
 */
interface MessageLike {
	role?: string;
	stopReason?: string;
	errorMessage?: string;
	content?: string | Array<{ type?: string; text?: string }>;
}

const CUSTOM_TYPE = "rate-limit-retry:continue";

/** The hidden prompt. Asks the model to retry the rate-limited request. */
const PROMPT =
	"You hit a rate limit (HTTP 429) while making a request. The rate limit is temporary and will\n" +
	"clear shortly. Please retry the request that failed and continue with your task. You do not\n" +
	"need to mention the rate limit to the user — just proceed with the work.\n\n" +
	"(This is an automated retry trigger, not a message from the user.)";

/** True when we're inside an injected 429-retry loop. */
let retrying429 = false;
/** User-facing kill switch for the session. Defaults on. */
let sessionEnabled = true;
/** Track whether the current turn already had a 429 retry injected. */
let armed = false;

/** Check if the last assistant message indicates a 429 error. */
function is429Error(messages: readonly MessageLike[]): boolean {
	if (messages.length === 0) return false;

	// Find the last assistant message
	let lastAssistant: MessageLike | undefined;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === "assistant") {
			lastAssistant = messages[i];
			break;
		}
	}

	if (!lastAssistant) return false;

	// Check stopReason
	if (lastAssistant.stopReason !== "error") return false;

	// Check errorMessage for 429 indicators
	const errorText = (lastAssistant.errorMessage || "").toLowerCase();
	return (
		errorText.includes("429") ||
		errorText.includes("rate limit") ||
		errorText.includes("rate-limited") ||
		errorText.includes("rate_limited") ||
		errorText.includes("too many requests")
	);
}

let hasUI = false;

export default function (pi: ExtensionAPI) {
	// Detect if we're in interactive mode (has a UI)
	pi.on("session_start", (_event, ctx) => {
		hasUI = !!ctx.ui;
	});

	// Arm on the start of a genuine run; the injected loop's own start is
	// skipped so it can never re-arm.
	pi.on("agent_start", async () => {
		if (!retrying429) armed = true;
	});

	pi.on("agent_end", async (event, ctx: ExtensionContext) => {
		// End of the injected loop: clear the flag and stop. Never re-inject.
		if (retrying429) {
			retrying429 = false;
			return;
		}

		// Only the first end of a genuine run is eligible, and only once.
		if (!armed) return;
		armed = false;

		if (!sessionEnabled) return;
		if (!hasUI) return;

		// Only trigger when the run ended with a 429 error.
		if (!is429Error((event.messages ?? []) as MessageLike[])) return;

		// Enter the retry loop. Set the flag now so the injected loop's
		// agent_start is recognised and doesn't re-arm.
		retrying429 = true;

		// Defer the trigger so the current agent_end fully settles and the
		// session is idle before we start a fresh loop.
		setImmediate(() => {
			if (!ctx.isIdle()) {
				retrying429 = false;
				return;
			}
			pi.sendMessage(
				{ customType: CUSTOM_TYPE, content: PROMPT, display: false },
				{ triggerTurn: true },
			);
		});
	});

	pi.registerCommand("rate-limit-retry", {
		description: "Toggle indefinite 429 retry for this session",
		handler: async (args, _ctx) => {
			const arg = args.trim().toLowerCase();
			if (arg === "off") {
				sessionEnabled = false;
			} else if (arg === "on") {
				sessionEnabled = true;
			} else if (arg !== "" && arg !== "status") {
				pi.sendMessage({
					customType: "rate-limit-retry:error",
					content: "Usage: /rate-limit-retry [on|off|status]",
					display: true,
				});
				return;
			}

			pi.sendMessage({
				customType: "rate-limit-retry:status",
				content: sessionEnabled
					? "Rate-limit retry: armed — 429 errors trigger indefinite retry."
					: "Rate-limit retry: off for this session (`/rate-limit-retry on` to re-enable).",
				display: true,
			});
		},
	});
}
