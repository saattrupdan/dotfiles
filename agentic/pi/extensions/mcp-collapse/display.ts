/** Render-only MCP presentation. Never imports or starts the adapter. */
import { Text, type Component } from "@earendil-works/pi-tui";
export interface Theme {
	fg(name: string, text: string): string;
	bold(text: string): string;
}

export interface RenderContext {
	expanded: boolean;
	isError: boolean;
}

export interface ResultOptions {
	expanded: boolean;
	isPartial: boolean;
}

export type ContentBlock = { type: "text"; text: string } | { type: "image"; mimeType?: string };

export interface ToolResult {
	content: ContentBlock[];
	details?: {
		error?: unknown;
		outputGuard?: { truncated?: boolean };
		[key: string]: unknown;
	};
}

export const MAX_SUMMARY_CHARS = 80;

export const FIXED_RESULT_SUMMARY: Record<string, string> = {
	memory_query: "remembered a thing",
	memory_add: "Stored a memory",
	memory_update: "Updated a memory",
};

export const TOOLCALLID_MARKER = /^\[toolCallId:[^\]]*\]$/;

export function oneLine(text: string): string {
	const collapsed = text.replace(/\s+/g, " ").trim();
	return collapsed.length > MAX_SUMMARY_CHARS
		? `${collapsed.slice(0, MAX_SUMMARY_CHARS - 1)}…`
		: collapsed;
}

export function count(n: number, noun: string): string {
	return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

export function summarizeParsed(parsed: unknown): string | undefined {
	if (Array.isArray(parsed)) return count(parsed.length, "item");
	if (parsed && typeof parsed === "object") {
		const obj = parsed as Record<string, unknown>;
		if (Array.isArray(obj.results)) return `Found ${count(obj.results.length, "result")}`;
		for (const key of ["answer", "message", "summary", "content", "text"]) {
			const value = obj[key];
			if (typeof value === "string" && value.trim()) return oneLine(value);
		}
		return "Done";
	}
	if (typeof parsed === "string" && parsed.trim()) return oneLine(parsed);
	return undefined;
}

export function summarizeJson(text: string): string | undefined {
	try {
		return summarizeParsed(JSON.parse(text.trim()));
	} catch {
		return undefined;
	}
}

export function summarize(text: string): string {
	const trimmed = text.trim();
	if (!trimmed) return "Done";
	const parsedSummary = summarizeJson(trimmed);
	if (parsedSummary !== undefined) return parsedSummary;

	// Not JSON — fall through to the first non-empty line of raw text.
	const firstLine = trimmed
		.split("\n")
		.map((line) => line.trim())
		.find(Boolean);
	return firstLine ? oneLine(firstLine) : "Done";
}

export function resultText(result: ToolResult): string {
	return result.content
		.filter((block) => !(block.type === "text" && TOOLCALLID_MARKER.test(block.text.trim())))
		.map((block) => (block.type === "text" ? block.text : `[image: ${block.mimeType ?? "?"}]`))
		.join("\n");
}

export function summarizeResult(result: ToolResult): string {
	if (result.details?.outputGuard?.truncated) return "Completed (output truncated)";

	const textBlocks = result.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.filter((block) => !TOOLCALLID_MARKER.test(block.text.trim()));
	const text = textBlocks.map((block) => block.text).join("\n");
	if (!text.trim()) return summarize(resultText(result));
	for (const block of textBlocks) {
		const parsedSummary = summarizeJson(block.text);
		if (parsedSummary !== undefined) return parsedSummary;
	}
	return summarize(text);
}

export function prettyText(text: string): string {
	try {
		return JSON.stringify(JSON.parse(text.trim()), null, 2);
	} catch {
		return text;
	}
}

export function makeRenderCall(name: string) {
	return (args: Record<string, unknown>, theme: Theme, ctx: RenderContext): Component => {
		const title = theme.fg("toolTitle", theme.bold(name));
		if (!ctx.expanded || !args || Object.keys(args).length === 0) {
			return new Text(title, 0, 0);
		}
		return new Text(`${title}\n${theme.fg("muted", JSON.stringify(args, null, 2))}`, 0, 0);
	};
}

export function collapsedSummary(name: string, result: ToolResult): string {
	return (
		FIXED_RESULT_SUMMARY[name] ??
		(result.details?.outputGuard?.truncated
			? "Completed (output truncated)"
			: summarizeResult(result))
	);
}

export function colourPrefix(line: string, theme: Theme): string {
	if (line.startsWith("✓")) {
		return theme.fg("success", line);
	}
	if (line.startsWith("✗")) {
		return theme.fg("error", line);
	}
	return theme.fg("toolOutput", line);
}

export function makeRenderResult(name: string) {
	return (
		result: ToolResult,
		options: ResultOptions,
		theme: Theme,
		ctx: RenderContext,
	): Component => {
		if (options.isPartial) {
			return new Text(theme.fg("warning", "…"), 0, 0);
		}
		const text = resultText(result);
		const isError = ctx.isError || Boolean(result.details?.error);
		if (options.expanded || isError) {
			const lines = prettyText(text)
				.split("\n")
				.map((line) => colourPrefix(line, theme));
			return new Text(lines.join("\n"), 0, 0);
		}
		const summary = collapsedSummary(name, result);
		return new Text(colourPrefix(`✓ ${summary}`, theme), 0, 0);
	};
}
