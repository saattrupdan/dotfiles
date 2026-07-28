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
 * ONE deliberate exception: for the three Understory `memory_*` tools we also wrap
 * `execute` to neutralize the internal source paths the librarian cites (e.g.
 * `[/users/dan-smart.md](/users/dan-smart.md)`). A weak local client reads those as real
 * files, prepends a guessed knowledge-base root, and tries to `read`/`bash` them — bypassing
 * the MCP entirely and 404ing (observed in the wild). We rewrite each internal `/…․md` path
 * into an inert backticked concept label (`users/dan-smart`, no link, no leading slash, no
 * extension) so it no longer reads as an openable filesystem path. This DOES mutate the
 * model-facing content, but only cosmetically and only for the memory tools — the answer
 * text is untouched, and only the path *affordance* is removed. The transformed result also
 * feeds the display, so the expanded (Ctrl+O) view shows the same neutralized labels.
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
// The adapter announces itself on every session start with a splash-screen notification
// (`ui.notify("MCP: N servers connected (M tools)", "info")` in pi-mcp-adapter's init).
// The footer already shows connection status, so this line is pure noise. We drop exactly
// that message and nothing else — matched by a tight anchored pattern so no other MCP
// notification (errors, "tools skipped", auth prompts) is ever suppressed.
const MCP_STARTUP_BANNER = /^MCP: \d+(?:\/\d+)? servers connected \(\d+ tools?\)$/;
const MCP_DIRECT_TOOL_LABEL = "MCP: ";
// Understory memory tools whose results cite the librarian's internal virtual paths. We
// neutralize those paths in their execute() output (see file header for the why).
const MEMORY_TOOLS = new Set(["memory_query", "memory_add", "memory_update"]);
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

/** `/users/dan-smart.md` → `users/dan-smart` (drop leading slash + `.md` extension). */
function pathToConcept(path: string): string {
	return path.replace(/^\//, "").replace(/\.md$/i, "");
}

/**
 * Rewrite Understory's internal source paths so they no longer read as openable files.
 * Handles both markdown links (`[…](/users/dan-smart.md)`) and any bare `/…․md` paths that
 * aren't part of a URL (guarded by a lookbehind for `:`/word-char/backtick), turning each
 * into an inert backticked concept label. External http(s) links and the prose answer are
 * left untouched.
 */
function neutralizeMemoryPaths(text: string): string {
	const linked = text.replace(/\[[^\]]*\]\((\/[^)\s]+?\.md)\)/g, (_m, target: string) => `\`${pathToConcept(target)}\``);
	return linked.replace(/(?<![:\w`(/])\/(?:[\w.-]+\/)*[\w.-]+\.md\b/g, (match) => `\`${pathToConcept(match)}\``);
}

function neutralizeMemoryResult(result: ToolResult): ToolResult {
	if (!result || !Array.isArray(result.content)) return result;
	return {
		...result,
		content: result.content.map((block) =>
			block.type === "text" ? { ...block, text: neutralizeMemoryPaths(block.text) } : block,
		),
	};
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
function colourPrefix(line: string, theme: Theme): string {
	if (line.startsWith("✓")) {
		return theme.fg("success", line);
	}
	if (line.startsWith("✗")) {
		return theme.fg("error", line);
	}
	return theme.fg("toolOutput", line);
}

function makeRenderResult(name: string) {
	return (result: ToolResult, options: ResultOptions, theme: Theme, ctx: RenderContext): Component => {
		if (options.isPartial) {
			return new Text(theme.fg("warning", "…"), 0, 0);
		}
		const text = resultText(result);
		const isError = ctx.isError || Boolean(result.details?.error);
		if (options.expanded || isError) {
			const lines = prettyText(text).split("\n").map((line) => colourPrefix(line, theme));
			return new Text(lines.join("\n"), 0, 0);
		}
		const summary = FIXED_RESULT_SUMMARY[name] ?? summarize(text);
		return new Text(colourPrefix(`✓ ${summary}`, theme), 0, 0);
	};
}

// Condense the verbose footer status. The adapter sets the "mcp" status slot to
// `🔌 MCP: N servers enabled (M connected)` (init.ts updateStatusBar); we replace it with
// one 🔌 per connected server (2 connected → "🔌🔌"), keeping the adapter's accent colour.
// Non-"connected" states (e.g. "connecting to N servers…") fall back to a single plug so
// the slot still signals activity. `undefined` (slot cleared) passes straight through.
function condenseMcpStatus(value: unknown, theme: { fg?(name: string, text: string): string } | undefined): unknown {
	if (typeof value !== "string") return value;
	const connected = value.match(/\((\d+)\s+connected\)/);
	const count = connected ? Number(connected[1]) : 1;
	const plugs = "🔌".repeat(Math.max(count, 1));
	return theme?.fg ? theme.fg("accent", plugs) : plugs;
}

// Wrap a UI object so the startup banner notification is swallowed and the footer status is
// condensed; every other call (and property) passes through with its original binding intact.
function filterUi(ui: unknown): unknown {
	if (!ui || typeof (ui as { notify?: unknown }).notify !== "function") return ui;
	return new Proxy(ui as Record<string, unknown>, {
		get(target, prop) {
			if (prop === "notify") {
				return (message: unknown, level?: unknown) => {
					if (typeof message === "string" && MCP_STARTUP_BANNER.test(message.trim())) return;
					return (target.notify as (...a: unknown[]) => unknown)(message, level);
				};
			}
			if (prop === "setStatus") {
				return (key: unknown, value: unknown) => {
					const next = key === "mcp"
						? condenseMcpStatus(value, (target as { theme?: { fg?(name: string, text: string): string } }).theme)
						: value;
					return (target.setStatus as (...a: unknown[]) => unknown)(key, next);
				};
			}
			return Reflect.get(target, prop, target);
		},
	});
}

// Wrap the ExtensionContext (handler 2nd arg) so its `ui` is the filtered one above.
function filterCtx(ctx: unknown): unknown {
	if (!ctx || typeof ctx !== "object" || !("ui" in ctx) && !("hasUI" in ctx)) return ctx;
	return new Proxy(ctx as Record<string, unknown>, {
		get(target, prop) {
			if (prop === "ui") return filterUi(Reflect.get(target, prop, target));
			return Reflect.get(target, prop, target);
		},
	});
}

export default function (pi: ExtensionAPI) {
	// Install the adapter against a Proxy that injects our renderers into every MCP direct
	// tool as it is registered. Everything else passes straight through to the real API.
	const wrapped = new Proxy(pi, {
		get(target, prop) {
			if (prop === "on") {
				// Event handlers receive ctx as their 2nd arg. Substitute a ctx whose `ui.notify`
				// filters the startup banner, so the adapter never emits it on the splash screen.
				return (event: unknown, handler: (...args: unknown[]) => unknown) => {
					const wrappedHandler = (evt: unknown, ctx: unknown, ...rest: unknown[]) =>
						handler(evt, filterCtx(ctx), ...rest);
					return (target.on as (e: unknown, h: unknown) => unknown)(event, wrappedHandler);
				};
			}
			if (prop === "registerTool") {
				return (tool: {
					name: string;
					label?: string;
					renderCall?: unknown;
					renderResult?: unknown;
					execute?: (...args: unknown[]) => Promise<ToolResult>;
				}) => {
					if (typeof tool.label === "string" && tool.label.startsWith(MCP_DIRECT_TOOL_LABEL)) {
						tool.renderCall = makeRenderCall(tool.name);
						tool.renderResult = makeRenderResult(tool.name);
						// For memory tools, strip the internal source-path affordance from the
						// model-facing result (see file header). Everything else is display-only.
						if (MEMORY_TOOLS.has(tool.name) && typeof tool.execute === "function") {
							const original = tool.execute;
							tool.execute = async (...args: unknown[]) => neutralizeMemoryResult(await original(...args));
						}
					}
					// Wrap the MCP proxy tool to suppress stale context errors in its result content
					if (tool.name === "mcp" && typeof tool.execute === "function") {
						const original = tool.execute;
						tool.execute = async (...args: unknown[]) => {
							const result = await original(...args);
							// If the result content contains the stale context error, return empty content
							if (
								result?.content?.[0]?.type === "text" &&
								typeof result.content[0].text === "string" &&
								MCP_STALE_CTX_ERROR.test(result.content[0].text)
							) {
								return { ...result, content: [] };
							}
							return result;
						};
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
