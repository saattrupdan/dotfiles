/**
 * Heuristic fallback outliner for unsupported languages.
 *
 * Splits the source on blank lines and emits one entry per non-empty
 * block whose first line begins with an ASCII letter or underscore.
 * Never throws.
 */

import type { OutlineEntry } from "./outliner.ts";

const IDENT_START = /^[A-Za-z_]/;

export function fallbackOutline(source: string): OutlineEntry[] {
	const out: OutlineEntry[] = [];
	const lines = source.split("\n");
	let blockStart = -1;
	let blockFirst = "";
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";
		const trimmed = line.trim();
		if (trimmed === "") {
			if (blockStart >= 0) {
				pushBlock(out, blockStart, blockFirst);
				blockStart = -1;
				blockFirst = "";
			}
			continue;
		}
		if (blockStart < 0) {
			blockStart = i;
			blockFirst = trimmed;
		}
	}
	if (blockStart >= 0) {
		pushBlock(out, blockStart, blockFirst);
	}
	return out;
}

function pushBlock(out: OutlineEntry[], startRow: number, firstLine: string): void {
	if (!IDENT_START.test(firstLine)) return;
	const name = firstLine.length > 80 ? `${firstLine.slice(0, 79)}\u2026` : firstLine;
	out.push({
		line: startRow + 1,
		lineEnd: startRow + 1,
		kind: "block",
		name,
	});
}
