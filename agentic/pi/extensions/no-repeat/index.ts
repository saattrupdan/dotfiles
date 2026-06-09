/**
 * Block consecutive duplicate and alternating-pair tool calls.
 *
 * Catches two failure modes:
 * 1. **Consecutive duplicates** (A, A → block) — the agent re-calls the same
 *    tool with identical arguments.
 * 2. **Two-stage alternating loops** (A, B, A, B → block the second A and B)
 *    — the agent alternates between two different argument sets forever,
 *    e.g. `search kind="def"` / `search kind="ref"` / `search kind="def"` / …
 *
 * For most tools the nudge says "do something different". For `read` it hands
 * back the exact next move (see `blockReason`). This saves tokens and prevents
 * infinite loops.
 *
 * Runs in both the orchestrator and subagent processes (per-process state).
 *
 * "Consecutive" means: not separated by any other tool call. Two `read` calls
 * on the same file with a different `search` in between are fine; two
 * identical `read` calls in a row are not. Alternating detection requires the
 * same tool — different tools interleaving don't count.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { canonicalInput, clearAutoloadRetry, consumeAutoloadRetry, toolCallFingerprint } from "./retry.ts";

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

const HISTORY_WINDOW = 10; // keep this many recent fingerprints per tool

/**
 * Check if the history ends with a two-stage alternating pattern (A, B, A, B, …).
 * The new call is already appended to `history`. If the last 4+ calls form an
 * alternating pattern, the latest call is continuing the loop — return true to
 * signal that it should be blocked.
 */
function detectAlternatingPair(history: string[]): boolean {
	if (history.length < 4) return false;

	// Check for the longest alternating suffix of even length ≥ 4.
	// Pattern: A, B, A, B, A, B, …
	const len = history.length;
	// Try suffix lengths 4, 6, 8, … up to the full buffer.
	for (let suffixLen = 4; suffixLen <= len; suffixLen += 2) {
		const suffix = history.slice(len - suffixLen);
		const a = suffix[0];
		const b = suffix[1];
		if (a === b) break; // can't alternate if first two are equal
		let consistent = true;
		for (let i = 0; i < suffix.length; i++) {
			if (i % 2 === 0 && suffix[i] !== a) { consistent = false; break; }
			if (i % 2 === 1 && suffix[i] !== b) { consistent = false; break; }
		}
		if (!consistent) break;
		// The last element is the new call. It's at index suffixLen-1.
		// If suffixLen is even, the last element is 'b' (the second member).
		// If suffixLen is odd, the last element is 'a' (the first member).
		// Either way, the new call is continuing the alternating loop → block.
		return true;
	}
	return false;
}

export default function (pi: ExtensionAPI) {
	let last: string | null = null;
	let currentSessionId: string | undefined;
	// Per-tool history buffers for alternating-pair detection.
	const history: Map<string, string[]> = new Map();

	pi.on("session_start", async (_event, ctx) => {
		last = null;
		currentSessionId = undefined;
		clearAutoloadRetry(sessionId(ctx));
		history.clear();
	});

	pi.on("tool_call", async (event, ctx) => {
		const session = sessionId(ctx);
		if (currentSessionId && currentSessionId !== session) {
			last = null;
			history.clear();
		}
		currentSessionId = session;

		// If the input canonicalizes to nothing (non-enumerable shape, empty
		// args), don't risk a false collision — treat it as never matching.
		const canonical = canonicalInput(event.input);
		if (!canonical) {
			last = null;
			history.clear();
			return;
		}

		const fp = toolCallFingerprint(event.toolName, event.input);
		if (consumeAutoloadRetry(session, event.toolName, event.input)) {
			last = fp;
			return;
		}

		// --- Consecutive-duplicate check (existing) ---
		if (last === fp) {
			last = null;
			return {
				block: true,
				reason: blockReason(event.toolName, event.input),
			};
		}

		// --- Alternating-pair check (new) ---
		// Maintain a rolling history per tool name.
		let buf = history.get(event.toolName);
		if (!buf) { buf = []; history.set(event.toolName, buf); }
		buf.push(fp);
		if (buf.length > HISTORY_WINDOW) buf.shift();

		// Check if the latest call continues a two-stage alternating loop.
		if (detectAlternatingPair(buf)) {
			return {
				block: true,
				reason: `Alternating loop detected: you've been switching back and forth between two argument sets for \`${event.toolName}\`. Pick one and report what you have — don't keep alternating.`,
			};
		}

		last = fp;
	});
}
