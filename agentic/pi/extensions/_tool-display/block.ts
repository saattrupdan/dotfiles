import { stripVTControlCharacters } from "node:util";

import type { ToolLineStyle, ToolBlock } from "./block-types.ts";
export type { ToolLineStyle, ToolBlock } from "./block-types.ts";

/** Preserve native semantic colours without transporting ANSI or executable markup. */
export function displayBlock(
	lines: string[],
	name: string,
	colors: Partial<Record<Exclude<ToolLineStyle, "plain">, string>>,
): ToolBlock {
	const plain = lines.map((line) => stripVTControlCharacters(line).trimEnd());
	const first = plain.findIndex((line) => line.trim());
	if (first < 0) return { text: "", styles: [] };
	let end = plain.length;
	while (end > first && !plain[end - 1]!.trim()) end--;
	const text = plain.slice(first, end).join("\n").trim().slice(0, 16384);
	const styles = lines
		.slice(first, first + text.split("\n").length)
		.map((line, index): ToolLineStyle => {
			// Only native styling before the first printable character defines the line.
			// eslint-disable-next-line no-control-regex -- Parse terminal SGR styling, never payload markup.
			const prefix = line.match(/^(?:[\t ]|\x1b\[[\d;:]*m)*/)?.[0] ?? "";
			if (
				["bash", "powershell"].includes(name) &&
				colors.command &&
				prefix.includes(colors.command)
			)
				return "command";
			if (name === "edit" && index > 0) {
				if (colors.added && prefix.includes(colors.added)) return "added";
				if (colors.removed && prefix.includes(colors.removed)) return "removed";
			}
			return "plain";
		});
	return { text, styles };
}
