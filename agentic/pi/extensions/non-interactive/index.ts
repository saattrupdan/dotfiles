/**
 * `/non-interactive <prompt>` — run a single user request without ever
 * stopping to ask a question.
 *
 * Two effects, both scoped to the resulting agent run:
 *
 *  1. Sets `PI_NON_INTERACTIVE=1` in this process's env. The `question`
 *     tool's dispatch checks this on every call and refuses with a nudge
 *     telling the model to pick a sensible default. Subagents spawned by
 *     this run inherit the env var (the subagent extension passes
 *     `...process.env` when spawning) so the gag applies to them too.
 *
 *  2. Prepends an explicit instruction to the user's prompt so the
 *     orchestrator (and any subagent it briefs) is told upfront not to
 *     ask anything — even before it would have considered calling
 *     `question`. The model is much better at obeying an explicit
 *     in-prompt instruction than at recovering from a denied tool call.
 *
 * Cleanup is deliberately aggressive — the flag is cleared at every
 * boundary where a new turn or a new user message could begin:
 *
 *   - `agent_end`:    normal finish of the agent loop.
 *   - `agent_start`:  belt-and-braces, before the next loop kicks off, in
 *                     case agent_end was skipped (abort / crash / interrupt).
 *   - `input`:        any new user input that is *not* a `/non-interactive`
 *                     command clears the flag before the orchestrator sees
 *                     the message, so the gag doesn't silently survive
 *                     across consecutive user messages.
 *
 * Net effect: the flag lives precisely from the moment the command handler
 * sends the augmented user message until the run produced by that message
 * finishes — never longer.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const ENV_FLAG = "PI_NON_INTERACTIVE";

const BANNER =
	"NON-INTERACTIVE MODE: do not call the `question` tool, and do not stop " +
	"to ask the user for clarification. If anything is ambiguous, pick the " +
	"approach you think is best and state your assumption explicitly. When " +
	"you delegate to a subagent, tell it the same — no questions, best-guess " +
	"defaults with stated assumptions.";

function clearFlag() {
	if (process.env[ENV_FLAG] !== undefined) {
		delete process.env[ENV_FLAG];
	}
}

export default function (pi: ExtensionAPI) {
	// True while the command handler is in the middle of arming the flag
	// and dispatching the augmented user message. Without this guard the
	// `input` listener (which clears the flag on any new user input) would
	// undo the flag the command just set, since `sendUserMessage` fires an
	// input event.
	let arming = false;

	pi.registerCommand("non-interactive", {
		description: "Run the given request without any user questions. Subagents inherit the gag.",
		async handler(args, _ctx) {
			const trimmed = args.trim();
			if (!trimmed) {
				pi.sendMessage({
					customType: "non-interactive:error",
					content: "Usage: /non-interactive <prompt>",
					display: true,
				});
				return;
			}
			arming = true;
			try {
				process.env[ENV_FLAG] = "1";
				pi.sendUserMessage(`${BANNER}\n\n${trimmed}`);
			} finally {
				// Release on the next tick so the input event for the message
				// we just sent has already passed the listener.
				setImmediate(() => {
					arming = false;
				});
			}
		},
	});

	pi.on("agent_end", async () => {
		clearFlag();
	});
	pi.on("agent_start", async () => {
		if (!arming) clearFlag();
	});
	pi.on("input", async () => {
		if (!arming) clearFlag();
	});
}
