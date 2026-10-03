/**
 * Indefinite retry for 429 (rate limit) errors.
 *
 * The built-in retry in pi-coding-agent handles transient errors (including 429s)
 * with exponential backoff, but caps out at maxRetries: 3. This extension extends
 * that to indefinite retries for rate limits specifically — since 429s are bound
 * to clear eventually, there's no point giving up.
 *
 * After Pi finishes its built-in retries and the agent fully settles with a 429,
 * we inject a hidden prompt asking the model to continue. This repeats until the
 * rate limit clears.
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
 * Pi emits agent_end for each built-in retry attempt, while the session is still
 * busy. Remember only the latest outcome, confirm it before final settlement,
 * then act on agent_settled after retries and queued continuations have finished.
 * Aborted runs never reach the pre-settlement boundary and are not restarted.
 * A new hidden turn gets the same treatment until it succeeds or stops for a
 * reason other than a rate limit. This applies to interactive and print modes;
 * the session switch /rate-limit-retry off cancels further retries.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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

export default function (pi: ExtensionAPI) {
	let sessionEnabled = true;
	let lastOutcomeWas429 = false;
	let readyToRetry = false;

	pi.on("agent_start", () => {
		lastOutcomeWas429 = false;
		readyToRetry = false;
	});

	pi.on("agent_end", (event) => {
		// Pi emits this once per built-in retry attempt. Only the final
		// agent_end before settlement determines whether to continue.
		lastOutcomeWas429 = is429Error((event.messages ?? []) as MessageLike[]);
	});

	pi.on("agent_before_settle", (event) => {
		// Not emitted when the user aborts during Pi's own retry wait.
		readyToRetry = event.outcome === "error" && lastOutcomeWas429;
	});

	pi.on("agent_settled", () => {
		if (!sessionEnabled || !readyToRetry) return;
		readyToRetry = false;
		// Pi defers triggerTurn messages sent during agent_settled until after
		// settlement, so this cannot race with its own built-in retries.
		pi.sendMessage(
			{ customType: CUSTOM_TYPE, content: PROMPT, display: false },
			{ triggerTurn: true },
		);
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
