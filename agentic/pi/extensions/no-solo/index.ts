/**
 * `/no-solo [prompt]` — disable solo mode and return to subagent-delegate mode
 * by clearing the `PI_SOLO_MODE` environment variable.
 *
 * After clearing the flag, dispatches a user message announcing the mode
 * change to the agent so it doesn't get confused about losing access to
 * tools it had a moment ago. If a prompt is supplied, it's appended after
 * the banner; otherwise the banner is sent on its own and the agent will
 * briefly acknowledge.
 *
 * No lifecycle hooks here — the `solo` extension owns the flag's
 * lifecycle, and earlier always-on `input` listeners here were the cause
 * of solo mode being wiped on the very turn it was armed.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const ENV_FLAG = "PI_SOLO_MODE";

const BANNER =
	"NORMAL MODE RESTORED: solo mode is now disabled. You should delegate " +
	"any work that needs direct tool access to a subagent (planner, builder, " +
	"explorer, or reviewer).";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("no-solo", {
		description:
			"Disable solo mode and return to subagent-delegate mode (until /solo).",
		async handler(args, _ctx) {
			const wasActive = process.env[ENV_FLAG] === "1";
			if (wasActive) delete process.env[ENV_FLAG];

			if (!wasActive) {
				pi.sendMessage({
					customType: "no-solo:result",
					content: "Solo mode was not active.",
					display: "inline",
				});
				return;
			}

			const trimmed = args.trim();
			const message = trimmed ? `${BANNER}\n\n${trimmed}` : BANNER;
			pi.sendUserMessage(message);
		},
	});
}
