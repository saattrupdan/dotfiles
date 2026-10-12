/**
 * `/non-interactive <prompt>` — run a single user request without questions.
 * Bare `/non-interactive` enables the mode for subsequent requests until
 * `/non-interactive off`; `/loop` enables it for the loop's lifetime.
 *
 * Two effects, scoped to one run or to bare mode's lifetime:
 *
 *  1. Sets `PI_NON_INTERACTIVE=1` in this process's env. The `question`
 *     tool's dispatch checks this on every call and refuses with a nudge
 *     telling the model to pick a sensible default. Subagents spawned by
 *     this run inherit the env var (the subagent extension passes
 *     `...process.env` when spawning) so the gag applies to them too.
 *
 *  2. Prepends an explicit instruction to the user's prompt (including
 *     subsequent turns when bare mode is enabled) so the orchestrator
 *     and its subagents know not to ask anything.
 *
 * For a prompted command, cleanup is deliberately aggressive — the flag
 * is cleared at every boundary where a new turn or user message could begin:
 *
 *   - `agent_end`:    normal finish of the agent loop.
 *   - `agent_start`:  belt-and-braces, before the next loop kicks off, in
 *                     case agent_end was skipped (abort / crash / interrupt).
 *   - `input`:        any new user input that is *not* a `/non-interactive`
 *                     command clears the flag before the orchestrator sees
 *                     the message, so the gag doesn't silently survive
 *                     across consecutive user messages.
 *
 * Bare mode instead lasts until `off` or a session change. For a loop, the
 * shared loop signal holds the flag across runs and delays; stopping the loop
 * clears it. Every iteration carries the same prompt banner.
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
	let persistent = false;

	onLoopChange("non-interactive", (active, ctx) => {
		if (active || persistent) process.env[ENV_FLAG] = "1";
		else clearFlag();
		showStatus(ctx);
	});

	pi.registerCommand("non-interactive", {
		description: "Disable questions until 'off', or run one request without questions.",
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
				persistent = false;
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
			if (!trimmed) persistent = true;
			const sending = Boolean(trimmed) || !ctx.isIdle();
			arming = sending;
			try {
				process.env[ENV_FLAG] = "1";
				showStatus(ctx);
				// At idle, bare mode waits for the next request rather than starting
				// a turn just to repeat the instruction. During a run, steer it now.
				if (sending) {
					pi.sendUserMessage(trimmed ? `${NON_INTERACTIVE_BANNER}\n\n${trimmed}` : NON_INTERACTIVE_BANNER, { deliverAs: "steer" });
				}
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
		if (!persistent && !isLoopActive()) clearFlag();
		showStatus(ctx);
	});
	pi.on("agent_start", async (_event, ctx) => {
		if (!arming && !persistent && !isLoopActive()) clearFlag();
		showStatus(ctx);
	});
	pi.on("input", async (event, ctx) => {
		if (!arming && !persistent && (!isLoopActive() || event.source !== "extension")) clearFlag();
		showStatus(ctx);
		if (persistent && !arming && !event.text.startsWith(NON_INTERACTIVE_BANNER)) {
			return { action: "transform", text: `${NON_INTERACTIVE_BANNER}\n\n${event.text}`, images: event.images };
		}
	});
	pi.on("session_start", (_event, ctx) => {
		persistent = false;
		if (!isLoopActive()) clearFlag();
		showStatus(ctx);
	});
}
