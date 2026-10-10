/**
 * `/non-interactive <prompt>` — run a single user request without ever
 * stopping to ask a question. `/non-interactive off` restores interactive
 * questions; `/loop` enables non-interactive mode for its lifetime.
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
 * Outside a loop, cleanup is deliberately aggressive — the flag is cleared
 * at every boundary where a new turn or a new user message could begin:
 *
 *   - `agent_end`:    normal finish of the agent loop.
 *   - `agent_start`:  belt-and-braces, before the next loop kicks off, in
 *                     case agent_end was skipped (abort / crash / interrupt).
 *   - `input`:        any new user input that is *not* a `/non-interactive`
 *                     command clears the flag before the orchestrator sees
 *                     the message, so the gag doesn't silently survive
 *                     across consecutive user messages.
 *
 * For a loop, the shared loop signal holds the flag across runs and delays;
 * stopping the loop clears it. Every iteration carries the same prompt banner.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isLoopActive, onLoopChange } from "../_loop_state/state.ts";
import { NON_INTERACTIVE_BANNER } from "./prompt.ts";

const ENV_FLAG = "PI_NON_INTERACTIVE";
const STATUS_KEY = "non-interactive";

function showStatus(ctx: ExtensionContext) {
	ctx.ui.setStatus(STATUS_KEY, process.env[ENV_FLAG] === "1" ? "🙊" : undefined);
}

function clearFlag() {
	if (process.env[ENV_FLAG] !== undefined) {
		delete process.env[ENV_FLAG];
	}
}

export default function (pi: ExtensionAPI) {
	// Child processes inherit the parent's flag; never clear it at agent_start.
	if (process.env.PI_SUBAGENT_CHILD === "1") return;

	// True while the command handler is in the middle of arming the flag
	// and dispatching the augmented user message. Without this guard the
	// `input` listener (which clears the flag on any new user input) would
	// undo the flag the command just set, since `sendUserMessage` fires an
	// input event.
	let arming = false;

	onLoopChange("non-interactive", (active, ctx) => {
		if (active) process.env[ENV_FLAG] = "1";
		else clearFlag();
		showStatus(ctx);
	});

	pi.registerCommand("non-interactive", {
		description: "Run a request without questions, or use 'off' to restore interactive questions.",
		async handler(args, ctx) {
			const trimmed = args.trim();
			if (trimmed === "off") {
				if (isLoopActive()) {
					pi.sendMessage({
						customType: "non-interactive:error",
						content: "Stop the active loop with /loop stop before enabling interactive mode.",
						display: true,
					});
					return;
				}
				arming = false;
				clearFlag();
				showStatus(ctx);
				pi.sendMessage({
					customType: "non-interactive:status",
					content: "Interactive mode enabled; questions are available again.",
					display: true,
				});
				// Override the earlier banner if this command arrives while the agent
				// is still working; avoid creating an unnecessary turn when idle.
				if (!ctx.isIdle()) {
					pi.sendUserMessage("Interactive mode is enabled again. You may use the question tool when needed.", { deliverAs: "steer" });
				}
				return;
			}
			if (!trimmed) {
				pi.sendMessage({
					customType: "non-interactive:error",
					content: "Usage: /non-interactive <prompt> | /non-interactive off",
					display: true,
				});
				return;
			}
			arming = true;
			try {
				process.env[ENV_FLAG] = "1";
				showStatus(ctx);
				// Enter during streaming queues a steering message; without deliverAs,
				// Pi rejects extension-sent messages while the agent is working.
				pi.sendUserMessage(`${NON_INTERACTIVE_BANNER}\n\n${trimmed}`, { deliverAs: "steer" });
			} finally {
				// Release on the next tick so the input event for the message
				// we just sent has already passed the listener.
				setImmediate(() => {
					arming = false;
				});
			}
		},
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (!isLoopActive()) clearFlag();
		showStatus(ctx);
	});
	pi.on("agent_start", async (_event, ctx) => {
		if (!arming && !isLoopActive()) clearFlag();
		showStatus(ctx);
	});
	pi.on("input", async (event, ctx) => {
		if (!arming && (!isLoopActive() || event.source !== "extension")) clearFlag();
		showStatus(ctx);
	});
	pi.on("session_start", (_event, ctx) => {
		if (!isLoopActive()) clearFlag();
		showStatus(ctx);
	});
}
