/**
 * Collapse MCP tool call + result display to a one-line summary, expandable with Ctrl+O.
 *
 * Problem: pi-mcp-adapter renders every MCP tool call with its full argument JSON and
 * dumps the raw result (first three lines + "(Ctrl+O to expand)"). For chatty tools like
 * `tavily_search` or the Understory `memory_*` tools this floods the transcript.
 *
 * We never edit node_modules, and a *separate* extension cannot reach another extension's
 * registered tool definitions — pi keeps each extension's tool registry siloed, so there
 * is no hook to restyle a tool someone else registered. So instead we *own* the adapter:
 * this extension imports pi-mcp-adapter's factory and installs it against a Proxy of `pi`
 * that intercepts `registerTool`. For every MCP direct tool (label "MCP: …") we swap in
 * our own `renderCall`/`renderResult`.
 *
 * These renderers are DISPLAY ONLY — the model still receives the full, untouched result,
 * and Ctrl+O (which flips `context.expanded` / `options.expanded`) reveals the raw
 * arguments and complete output. That is the crucial difference from mutating the result
 * content in a `tool_result` / `tool_execution_end` handler, which would lie to the model
 * and make the full output unrecoverable.
 *
 * Because we install the adapter ourselves, "npm:pi-mcp-adapter" MUST be removed from
 * settings.json `packages` — otherwise it loads a second time and every tool name
 * conflicts ("Tool \"…\" conflicts with …"). Instead, pi-mcp-adapter is a declared
 * dependency of this extensions bundle (see ../package.json), so it is version-locked and
 * reinstalled alongside the other extension deps, and we import it by bare specifier.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import mcpAdapter from "pi-mcp-adapter";

// Minimal shapes for the pieces of the render API we touch (the full types live in pi-tui).
interface Theme {
	fg(name: string, text: string): string;
	bold(text: string): string;
}
interface RenderContext {
	expanded: boolean;
	isError: boolean;
}
interface ResultOptions {
	expanded: boolean;
	isPartial: boolean;
}
type ContentBlock = { type: "text"; text: string } | { type: "image"; mimeType?: string };
interface ToolResult {
	content: ContentBlock[];
	details?: { error?: unknown };
}

const MAX_SUMMARY_CHARS = 80;
const MCP_DIRECT_TOOL_LABEL = "MCP: ";
// Tools whose payload isn't worth surfacing get a fixed collapsed summary instead of a
// snippet of their (often long) result text.
const FIXED_RESULT_SUMMARY: Record<string, string> = {
	memory_query: "Remembered a thing",
	memory_add: "Stored a memory",
	memory_update: "Updated a memory",
};
// The copy-paste extension prepends a standalone `[toolCallId: <id>]` text block to every
// tool result so the model can reference it. It is noise in the display, so we drop it
// before summarizing or pretty-printing.
const TOOLCALLID_MARKER = /^\[toolCallId:[^\]]*\]$/;

function oneLine(text: string): string {
	const collapsed = text.replace(/\s+/g, " ").trim();
	return collapsed.length > MAX_SUMMARY_CHARS ? `${collapsed.slice(0, MAX_SUMMARY_CHARS - 1)}…` : collapsed;
}

function count(n: number, noun: string): string {
	return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** Best-effort one-line summary of a tool result for the collapsed view. */
function summarize(text: string): string {
	const trimmed = text.trim();
	if (!trimmed) return "Done";
	try {
		const parsed: unknown = JSON.parse(trimmed);
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
	} catch {
		// Not JSON — fall through to the first non-empty line of raw text.
	}
	const firstLine = trimmed.split("\n").map((line) => line.trim()).find(Boolean);
	return firstLine ? oneLine(firstLine) : "Done";
}

function resultText(result: ToolResult): string {
	return result.content
		.filter((block) => !(block.type === "text" && TOOLCALLID_MARKER.test(block.text.trim())))
		.map((block) => (block.type === "text" ? block.text : `[image: ${block.mimeType ?? "?"}]`))
		.join("\n");
}

function prettyText(text: string): string {
	try {
		return JSON.stringify(JSON.parse(text.trim()), null, 2);
	} catch {
		return text;
	}
}

/** renderCall: just the tool title. Raw arguments appear only when expanded (Ctrl+O). */
function makeRenderCall(name: string) {
	return (args: Record<string, unknown>, theme: Theme, ctx: RenderContext): Component => {
		const title = theme.fg("toolTitle", theme.bold(name));
		if (!ctx.expanded || !args || Object.keys(args).length === 0) {
			return new Text(title, 0, 0);
		}
		return new Text(`${title}\n${theme.fg("muted", JSON.stringify(args, null, 2))}`, 0, 0);
	};
}

/** renderResult: one-line "✓ summary" when collapsed; full output when expanded or on error. */
function makeRenderResult(name: string) {
	return (result: ToolResult, options: ResultOptions, theme: Theme, ctx: RenderContext): Component => {
		if (options.isPartial) {
			return new Text(theme.fg("warning", "…"), 0, 0);
		}
		const text = resultText(result);
		const isError = ctx.isError || Boolean(result.details?.error);
		if (options.expanded || isError) {
			const lines = prettyText(text).split("\n").map((line) => theme.fg("toolOutput", line));
			return new Text(lines.join("\n"), 0, 0);
		}
		const summary = FIXED_RESULT_SUMMARY[name] ?? summarize(text);
		return new Text(theme.fg("toolOutput", `✓ ${summary}`), 0, 0);
	};
}

export default function (pi: ExtensionAPI) {
	// Install the adapter against a Proxy that injects our renderers into every MCP direct
	// tool as it is registered. Everything else passes straight through to the real API.
	const wrapped = new Proxy(pi, {
		get(target, prop) {
			if (prop === "registerTool") {
				return (tool: { name: string; label?: string; renderCall?: unknown; renderResult?: unknown }) => {
					if (typeof tool.label === "string" && tool.label.startsWith(MCP_DIRECT_TOOL_LABEL)) {
						tool.renderCall = makeRenderCall(tool.name);
						tool.renderResult = makeRenderResult(tool.name);
					}
					return (target.registerTool as (t: unknown) => unknown)(tool);
				};
			}
			// Use `target` as the receiver so getters/methods keep their original binding.
			return Reflect.get(target, prop, target);
		},
	});

	mcpAdapter(wrapped);
}
