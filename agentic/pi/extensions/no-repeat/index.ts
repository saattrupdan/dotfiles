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

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { canonicalInput, clearAutoloadRetry, consumeAutoloadRetry, toolCallFingerprint } from "../_tool_call_retry/index.ts";

function sessionId(ctx: ExtensionContext): string {
	return ctx.sessionManager?.getSessionId() ?? "runtime";
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
			'read a different symbol from the outline, `read` symbol="__preamble__" for imports/constants, ' +
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
	let currentSessionId: string | undefined;

	pi.on("session_start", async (_event, ctx) => {
		last = null;
		currentSessionId = undefined;
		clearAutoloadRetry(sessionId(ctx));
	});

	pi.on("tool_call", async (event, ctx) => {
		const session = sessionId(ctx);
		if (currentSessionId && currentSessionId !== session) {
			last = null;
		}
		currentSessionId = session;

		// If the input canonicalizes to nothing (non-enumerable shape, empty
		// args), don't risk a false collision — treat it as never matching.
		const canonical = canonicalInput(event.input);
		if (!canonical) {
			last = null;
			return;
		}

		const fp = toolCallFingerprint(event.toolName, event.input);
		if (consumeAutoloadRetry(session, event.toolName, event.input)) {
			last = fp;
			return;
		}

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
