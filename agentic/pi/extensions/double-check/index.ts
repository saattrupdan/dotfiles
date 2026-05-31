/**
 * Nudge the agent to double-check its work before it goes idle.
 *
 * Agents have a habit of stopping a beat too early — they answer most of a
 * request, then end the turn with a step still unfinished, a test unrun, or an
 * edge case unhandled. This extension catches that: when the orchestrator's
 * agent loop ends normally, it injects one hidden prompt asking the agent to
 * re-read the original request, verify nothing was missed, and finish the job
 * if something was. The agent gets exactly one extra shot per user turn.
 *
 * Two things stay out of the transcript so the meta-exchange is invisible:
 *
 *   1. The double-check prompt itself is a `display: false` custom message —
 *      it reaches the LLM (custom messages convert to a user turn in context)
 *      but is never rendered in the chat.
 *
 *   2. If the agent decides nothing was missed it replies with the single word
 *      `done`. We blank that assistant message on `message_end` so it renders
 *      as nothing. Any *real* follow-up work the agent does (tool calls, a
 *      substantive summary) is left fully visible — only a bare "done" is
 *      hidden.
 *
 * Loop safety is the whole game here, since the nudge triggers a fresh agent
 * loop from inside `agent_end`:
 *
 *   - `armed` is set on `agent_start` for a genuine run and consumed on the
 *     first `agent_end`, so each user turn is checked at most once.
 *   - `checking` is true for the lifetime of the injected loop. Its own
 *     `agent_start` is ignored (won't re-arm) and its own `agent_end` just
 *     clears the flag and returns (won't re-inject).
 *
 * Orchestrator-only: a subagent reports back to its parent rather than going
 * idle in front of the user, so a self-nudge there is just wasted tokens — and
 * the parent's own run already brackets the subagent's work.
 *
 * Thinking is suppressed for the check turn: a bookkeeping pass over work the
 * agent just did doesn't need reasoning tokens, and skipping them keeps the
 * nudge cheap and fast. We can't lower the thinking *level* — the local vLLM
 * models are `openai-completions` with no reasoning flag, so Pi's thinking
 * level never reaches them. Instead we set `PI_DISABLE_THINKING=1` for the
 * duration of the turn; the `vllm-thinking` extension honours that flag and
 * injects `thinking_token_budget: 0` into the request. If `vllm-thinking` isn't
 * loaded the flag is simply inert — no harm.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * Minimal structural view of an agent message. We avoid importing the full
 * `AgentMessage` type from `@earendil-works/pi-agent-core` (it doesn't resolve
 * cleanly here — see the `subagent` extension's `@ts-expect-error` dance) and
 * only read the few fields we actually touch.
 */
interface MessageLike {
	role?: string;
	stopReason?: string;
	content?: string | Array<{ type?: string; text?: string }>;
}

const CUSTOM_TYPE = "double-check:nudge";

/** Generic "skip reasoning for the current request" signal, honoured by vllm-thinking. */
const DISABLE_THINKING_ENV = "PI_DISABLE_THINKING";

/** The hidden nudge. Kept terse — it's prepended to a full context window. */
const PROMPT =
	"Before this turn ends: re-read the original request and check your work against it. " +
	"Did you actually finish everything that was asked — every step, every file, every edge " +
	"case — or did you stop early? Look for unfinished steps, TODOs you left behind, checks or " +
	"tests you meant to run, and claims you haven't verified.\n\n" +
	"If anything is missing or incomplete, finish it now without asking. If — and only if — the " +
	"work is genuinely complete, reply with exactly the single word `done` and nothing else.\n\n" +
	"(This is an automated self-check, not a message from the user.)";

/** True while a genuine user run is in flight and still owes a double-check. */
let armed = false;
/** True for the entire lifetime of the injected double-check loop. */
let checking = false;
/** User-facing kill switch for the session (`/double-check off`). Defaults on. */
let sessionEnabled = true;

/** Suppress reasoning for the check turn; vllm-thinking turns this into budget 0. */
function disableThinking(): void {
	process.env[DISABLE_THINKING_ENV] = "1";
}

/** Restore normal thinking once the check turn is over (or never started). */
function restoreThinking(): void {
	if (process.env[DISABLE_THINKING_ENV] !== undefined) {
		delete process.env[DISABLE_THINKING_ENV];
	}
}

/** Flatten an assistant message's text blocks into one string. */
function messageText(message: MessageLike): string {
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((c) => c?.type === "text" && typeof c.text === "string")
		.map((c) => c.text)
		.join("");
}

/** Is this assistant reply a bare "done" acknowledgement and nothing else? */
function isBareDone(message: MessageLike): boolean {
	const text = messageText(message).trim().toLowerCase().replace(/[.!]+$/, "");
	return text === "done" || text === "`done`";
}

/** Did the just-ended loop finish cleanly (vs. error / user abort)? */
function endedCleanly(messages: readonly MessageLike[]): boolean {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m?.role === "assistant") {
			return m.stopReason !== "error" && m.stopReason !== "aborted";
		}
	}
	// No assistant message at all → nothing was really done; don't nudge.
	return false;
}

export default function (pi: ExtensionAPI) {
	// Subagents report back to the parent instead of idling in front of the
	// user; the parent's run already covers their work.
	if (process.env.PI_SUBAGENT_CHILD === "1") return;

	// Arm on the start of a genuine run; the injected loop's own start is
	// skipped so it can never re-arm itself. A genuine run also clears any
	// thinking-disable flag that somehow leaked from a prior interrupted check.
	pi.on("agent_start", async () => {
		if (!checking) {
			armed = true;
			restoreThinking();
		}
	});

	pi.on("agent_end", async (event, ctx: ExtensionContext) => {
		// End of the injected loop: clear the flags and stop. Never re-inject.
		if (checking) {
			checking = false;
			restoreThinking();
			return;
		}

		// Only the first end of a genuine run is eligible, and only once.
		if (!armed) return;
		armed = false;

		if (!sessionEnabled) return;
		if (!endedCleanly((event.messages ?? []) as MessageLike[])) return;

		// Enter the double-check loop. Set the flag now so the injected loop's
		// agent_start (which fires before the deferred send completes) is
		// recognised and doesn't re-arm.
		checking = true;

		// Suppress reasoning for the upcoming check turn (see header). Set before
		// the trigger so the turn's very first provider request already sees it.
		disableThinking();

		// Defer the trigger so the current agent_end fully settles and the
		// session is idle before we start a fresh loop from underneath it.
		setImmediate(() => {
			if (!ctx.isIdle()) {
				checking = false;
				restoreThinking();
				return;
			}
			pi.sendMessage(
				{ customType: CUSTOM_TYPE, content: PROMPT, display: false },
				{ triggerTurn: true },
			);
		});
	});

	// Suppress a bare "done" reply so the self-check leaves no trace. Real
	// follow-up work (anything that isn't just "done") is left untouched.
	pi.on("message_end", async (event) => {
		if (!checking) return;
		const message = event.message as MessageLike;
		if (message.role !== "assistant") return;
		if (!isBareDone(message)) return;
		// Keep the assistant role (required) but blank the text so it renders as
		// nothing — the "done" never reaches the chat.
		return { message: { ...event.message, content: [{ type: "text", text: "" }] } };
	});

	pi.registerCommand("double-check", {
		description: "Self-review-before-idle control: on | off | status.",
		async handler(args, _ctx) {
			const arg = args.trim().toLowerCase();
			if (arg === "off") {
				sessionEnabled = false;
			} else if (arg === "on") {
				sessionEnabled = true;
			} else if (arg !== "" && arg !== "status") {
				pi.sendMessage({
					customType: "double-check:error",
					content: "Usage: /double-check [on|off|status]",
					display: true,
				});
				return;
			}

			pi.sendMessage({
				customType: "double-check:status",
				content: sessionEnabled
					? "Double-check: armed — the agent self-reviews once before going idle."
					: "Double-check: off for this session (`/double-check on` to re-arm).",
				display: true,
			});
		},
	});
}
