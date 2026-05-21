/**
 * Block consecutive duplicate tool calls.
 *
 * If the agent calls the same tool with the same arguments twice in a row,
 * the second call is blocked with a short nudge telling it to do something
 * different. This catches the common "loop forever on the same failing call"
 * failure mode and saves tokens.
 *
 * Runs in both the orchestrator and subagent processes (per-process state,
 * which is what we want — each subagent has its own loop).
 *
 * "Consecutive" means: not separated by any other tool call. Two `read` calls
 * on the same file with a different `search` in between are fine; two
 * identical `read` calls in a row are not.
 */

import * as crypto from "node:crypto";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function fingerprint(toolName: string, input: unknown): string {
	let json: string;
	try {
		json = JSON.stringify(input, Object.keys((input as object) ?? {}).sort());
	} catch {
		json = String(input);
	}
	return `${toolName}\0${crypto.createHash("sha1").update(json).digest("hex")}`;
}

export default function (pi: ExtensionAPI) {
	let last: string | null = null;

	pi.on("tool_call", async (event) => {
		const fp = fingerprint(event.toolName, event.input);
		if (last === fp) {
			// Reset so a third identical attempt does not stay permanently blocked;
			// after the nudge the model usually changes its arguments.
			last = null;
			return {
				block: true,
				reason:
					`You just called \`${event.toolName}\` with identical arguments. ` +
					`Try something different: change the arguments, use a different tool, or report what you have found so far.`,
			};
		}
		last = fp;
	});
}
