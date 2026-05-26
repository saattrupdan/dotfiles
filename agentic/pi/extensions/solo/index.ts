/**
 * `/solo <prompt>` — enable direct tool mode for the rest of the session,
 * allowing direct tool calls (bash, read, write, edit, etc.) without
 * delegating to a subagent.
 *
 * Effect: sets `PI_SOLO_MODE=1` in this process's env and dispatches
 * the prompt prefixed with a banner explaining the new mode. The flag
 * persists across subsequent turns until the user invokes `/no-solo`
 * (or the pi process exits). No lifecycle hooks auto-clear it — the
 * mode is sticky by design, so follow-up messages without `/solo`
 * continue with direct tool access.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const ENV_FLAG = "PI_SOLO_MODE";

const BANNER =
	"SOLO MODE: you may call any tool directly (bash, read, " +
	"write, edit, etc.) for the rest of this session (until `/no-solo`). " +
	"Run the user's request directly — do not wrap it in a planner → builder " +
	"flow unless the user specifically asks for one.";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("solo", {
		description:
			"Enable direct tool mode for the rest of the session (until /no-solo).",
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
			process.env[ENV_FLAG] = "1";
			pi.sendUserMessage(`${BANNER}\n\n${trimmed}`);
		},
	});
}
