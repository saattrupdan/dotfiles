/**
 * `/solo <prompt>` — run a single user request with the orchestrator
 * lockdown disabled, allowing direct tool calls (bash, read, write, edit,
 * etc.) without delegating to a subagent.
 *
 * Effect: sets `PI_SOLO_MODE=1` in this process's env and sends a banner
 * to the user explaining that the orchestrator lockdown is lifted.
 *
 * Cleanup is deliberately aggressive — the flag is cleared at every
 * boundary where a new turn or a new user message could begin:
 *
 *   - `agent_end`:    normal finish of the agent loop.
 *   - `agent_start`:  belt-and-braces, before the next loop kicks off, in
 *                     case agent_end was skipped (abort / crash / interrupt).
 *   - `input`:        any new user input that is *not* a `/solo` command
 *                     clears the flag before the orchestrator sees the
 *                     message, so the lockout doesn't silently survive
 *                     across consecutive user messages.
 *
 * Net effect: the flag lives precisely from the moment the command handler
 * sends the augmented user message until the run produced by that message
 * finishes — never longer.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const ENV_FLAG = "PI_SOLO_MODE";

const BANNER =
	"SOLO MODE: the orchestrator lockdown is disabled. You may call any tool " +
	"directly (bash, read, write, edit, etc.) without delegating to a " +
	"subagent. Run the user's request directly — do not wrap it in a " +
	"planner → builder flow unless the user specifically asks for one.";

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

	pi.registerCommand("solo", {
		description:
			"Run the given prompt with the orchestrator unlocked (no subagent delegation required).",
		async handler(args, _ctx) {
			const trimmed = args.trim();
			if (!trimmed) {
				pi.sendMessage({
					customType: "solo:error",
					content: "Usage: /solo <prompt>",
					display: "inline",
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
