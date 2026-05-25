/**
 * `/no-solo` — disable solo mode and restore normal orchestrator lockdown.
 *
 * Clears the `PI_SOLO_MODE` environment variable so that the next agent
 * loop starts with the orchestrator lockdown re-enabled.
 *
 * Cleanup hooks ensure the flag is always cleared at every boundary where
 * a new turn or a new user message could begin:
 *
 *   - `agent_end`:    normal finish of the agent loop.
 *   - `agent_start`:  belt-and-braces, before the next loop kicks off, in
 *                     case agent_end was skipped (abort / crash / interrupt).
 *   - `input`:        any new user input clears the flag before the
 *                     orchestrator sees the message, so solo mode doesn't
 *                     silently survive across consecutive user messages.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const ENV_FLAG = "PI_SOLO_MODE";

function clearFlag() {
	if (process.env[ENV_FLAG] !== undefined) {
		delete process.env[ENV_FLAG];
	}
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("no-solo", {
		description:
			"Disable solo mode and restore normal orchestrator lockdown.",
		async handler(_args, _ctx) {
			const wasActive = process.env[ENV_FLAG] === "1";
			clearFlag();
			pi.sendMessage({
				customType: "no-solo:result",
				content: wasActive
					? "Solo mode disabled. Normal orchestrator lockdown restored."
					: "Solo mode was not active.",
				display: "inline",
			});
		},
	});

	pi.on("agent_end", async () => {
		clearFlag();
	});
	pi.on("agent_start", async () => {
		clearFlag();
	});
	pi.on("input", async () => {
		clearFlag();
	});
}
