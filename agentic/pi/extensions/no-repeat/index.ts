/**
 * Block consecutive duplicate tool calls.
 *
 * If the agent calls the same tool with the same arguments twice in a row,
 * the second call is blocked with a nudge. For most tools the nudge just says
 * "do something different"; for `read` it hands back the exact next move (see
 * `blockReason`), because a blocked re-read is the moment agents otherwise give
 * up and reach for `cat`. This catches the common "loop forever on the same
 * failing call" failure mode and saves tokens.
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

function canonicalize(value: unknown): unknown {
	if (value === null || typeof value !== "object") return value;
	if (Array.isArray(value)) return value.map(canonicalize);
	const out: Record<string, unknown> = {};
	for (const key of Object.keys(value as object).sort()) {
		out[key] = canonicalize((value as Record<string, unknown>)[key]);
	}
	return out;
}

function fingerprint(toolName: string, input: unknown): string {
	let json: string;
	try {
		json = JSON.stringify(canonicalize(input));
	} catch {
		json = String(input);
	}
	return `${toolName}\0${crypto.createHash("sha1").update(json).digest("hex")}`;
}

/**
 * The nudge shown when an identical call is blocked. For `read` this is the
 * single biggest frustration point: an agent reads a large file, gets an
 * outline, and immediately re-reads the same path hoping for more — only to be
 * blocked. A generic "do something different" message sends them to `cat`,
 * which defeats the whole point. So for `read` we hand back the exact next
 * move instead.
 */
function blockReason(toolName: string, input: unknown): string {
	if (toolName === "read") {
		const symbol = (input as { symbol?: unknown } | null)?.symbol;
		if (!symbol) {
			return (
				"Re-reading the same path won't show more — the outline you already have IS the whole-file view. " +
				"To see actual content, drill in instead of re-reading:\n" +
				'  • `read` with symbol="<name>" → the body of a function/class/section (names are in the outline)\n' +
				'  • `read` with symbol="__preamble__" → imports/constants before the first definition\n' +
				"  • `search` → locate a specific string or symbol if it isn't in the outline\n" +
				"Don't fall back to `cat`/`sed` — they dump the whole file and waste context; the outline + symbol reads exist precisely to avoid that."
			);
		}
		return (
			`You already have the body of \`${String(symbol)}\` above. To get more, ` +
			'pick a different symbol from the outline, `read` symbol="__preamble__" for imports/constants, ' +
			"or use `search` to find what you need."
		);
	}
	return (
		`You just called \`${toolName}\` with identical arguments. ` +
		"Try something different: change the arguments, use a different tool, or report what you have found so far."
	);
}

export default function (pi: ExtensionAPI) {
	let last: string | null = null;

	pi.on("tool_call", async (event) => {
		// If the input canonicalizes to nothing (non-enumerable shape, empty
		// args), don't risk a false collision — treat it as never matching.
		const canonical = JSON.stringify(canonicalize(event.input));
		if (!canonical || canonical === "{}" || canonical === "null") {
			last = null;
			return;
		}
		const fp = fingerprint(event.toolName, event.input);
		if (last === fp) {
			// Reset so a third identical attempt does not stay permanently blocked;
			// after the nudge the model usually changes its arguments.
			last = null;
			return {
				block: true,
				reason: blockReason(event.toolName, event.input),
			};
		}
		last = fp;
	});
}
