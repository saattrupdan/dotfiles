/**
 * Orchestrator lockdown.
 *
 * The main agent is an orchestrator and has *no* permissions of its own —
 * only `subagent` (and the user-facing `question` tool, if present). This
 * extension enforces that by blocking every other tool call at the
 * `tool_call` event boundary, regardless of how pi was launched.
 *
 * Subagents are spawned in separate `pi` processes by the `subagent`
 * extension, each with their own `--tools` allowlist, so they are
 * unaffected by this block.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const ALLOWED = new Set(["subagent", "question"]);

export default function (pi: ExtensionAPI) {
	// Subagents run in their own pi child processes (spawned by the
	// `subagent` extension) and need full access to their declared tools.
	// The parent sets PI_SUBAGENT_CHILD=1 in the child env to opt out of
	// orchestrator-level lockdown.
	if (process.env.PI_SUBAGENT_CHILD === "1") return;

	pi.on("tool_call", async (event) => {
		if (!ALLOWED.has(event.toolName)) {
			return {
				block: true,
				reason:
					`Orchestrator is not permitted to call '${event.toolName}'. ` +
					`Delegate this work to a subagent instead (planner, builder, code-explorer, web-explorer, or reviewer).`,
			};
		}
	});
}
