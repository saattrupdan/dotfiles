/** Render-only exports shared by native tool registration and Pi Remote. No extension factories are loaded here. */
import type {
	AgentToolResult,
	Theme,
	ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import type { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import type { DisplayRenderers } from "./types.ts";
import { Text } from "@earendil-works/pi-tui";
import { renderExpandedCall } from "./expanded-call.ts";
import { safeCommandPreview } from "../web-browse/command.ts";
const DEFAULT_DEPTH = 2;
type SearchStatus = string;
function textContent(content: Array<{ type: string; text?: string }>): string {
	return content
		.filter((item) => item.type === "text" && item.text)
		.map((item) => item.text)
		.join("\n");
}
function firstLine(text: string) {
	return text.split("\n")[0] || "(no output)";
}
function resultText(result: AgentToolResult<unknown>) {
	return textContent(result.content) || "(no output)";
}

export const skillRenderers: DisplayRenderers = {
	renderCall(args, theme) {
		const name = args?.name ? String(args.name) : "...";
		return new Text(
			`${theme.fg("toolTitle", theme.bold("skill"))} ${theme.fg("accent", name)}`,
			0,
			0,
		);
	},
	renderResult(result, { expanded }, theme, _context) {
		const text = textContent(result.content);
		if (expanded) return new Text(text, 0, 0);

		const details = result.details as { name?: string } | undefined;
		if (!details?.name) return new Text(firstLine(text), 0, 0);

		return new Text(theme.fg("success", `✓ loaded skill "${details.name}"`), 0, 0);
	},
};

export const codeTreeRenderers: DisplayRenderers = {
	renderCall(args, theme, context) {
		if (context?.expanded) return renderExpandedCall("code_tree", args, theme);
		const p = (args?.path as string | undefined) ?? ".";
		const d = (args?.depth as number | undefined) ?? DEFAULT_DEPTH;
		return new Text(
			`${theme.fg("toolTitle", theme.bold("code_tree "))}${theme.fg("accent", p)}${theme.fg("warning", ` d=${d}`)}`,
			0,
			0,
		);
	},
	renderResult(result, options, theme, context) {
		// If collapsed (not expanded), show only a summary line
		if (!options.expanded) {
			const text = (result.content ?? [])
				.filter((c) => c.type === "text")
				.map((c) => c.text ?? "")
				.join("\n");
			// Extract summary from header line: "# tree <path> (<N> files, depth <d>)"
			const headerMatch = text.match(/^# tree (.+) \((\d+) files, depth (\d+)\)/);
			if (headerMatch) {
				const [, treePath, fileCount] = headerMatch;
				return new Text(
					theme.fg("muted", `code_tree `) +
						theme.fg("accent", treePath) +
						theme.fg("success", ` ✓ ${fileCount} files`),
					0,
					0,
				);
			}
			// Fallback for errors or unexpected output
			if (context.isError) {
				return new Text(theme.fg("error", "✗ code_tree failed"), 0, 0);
			}
			return new Text(theme.fg("success", "✓ code_tree executed"), 0, 0);
		}

		// Expanded: show full tree output
		const text = (result.content ?? [])
			.filter((c) => c.type === "text")
			.map((c) => c.text ?? "")
			.join("\n");
		return new Text(text || "(no output)", 0, 0);
	},
};

export const generateImageRenderers: DisplayRenderers = {
	renderCall(args, theme, context) {
		if (context?.expanded) return renderExpandedCall("generate_image", args, theme);
		return new Text(theme.fg("toolTitle", theme.bold("generate_image")), 0, 0);
	},
	renderResult(result, options, theme, context) {
		if (options.isPartial)
			return new Text(
				theme.fg(
					"warning",
					(context.args?.num ?? 1) > 1 ? "⋯ Generating images" : "⋯ Generating image",
				),
				0,
				0,
			);
		const text = result.content
			.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join("\n");
		if (options.expanded) return new Text(text, 0, 0);
		if (context.isError) return new Text(theme.fg("error", "✗ image generation failed"), 0, 0);
		const count = (result.details as { count?: number } | undefined)?.count ?? 1;
		return new Text(
			theme.fg("success", count === 1 ? "✓ Generated image" : `✓ Generated ${count} images`),
			0,
			0,
		);
	},
};

export const generateVideoRenderers: DisplayRenderers = {
	renderCall(args, theme, context) {
		if (context?.expanded) return renderExpandedCall("generate_video", args, theme);
		return new Text(theme.fg("toolTitle", theme.bold("generate_video")), 0, 0);
	},
	renderResult(result, options, theme, context) {
		if (options.isPartial) return new Text(theme.fg("warning", "⋯ Generating video"), 0, 0);
		const text = result.content
			.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join("\n");
		if (options.expanded) return new Text(text, 0, 0);
		return new Text(
			context.isError
				? theme.fg("error", "✗ video generation failed")
				: theme.fg("success", "✓ Generated video"),
			0,
			0,
		);
	},
};

export const searchRenderers: DisplayRenderers = {
	renderCall(args, theme, context) {
		if (context?.expanded) return renderExpandedCall("search", args, theme);
		const query = args?.query ?? "...";
		const kind = args?.kind;
		return new Text(
			`${theme.fg("toolTitle", theme.bold("search"))} ${theme.fg("accent", String(query))}${kind ? theme.fg("warning", ` [${kind}]`) : ""}`,
			0,
			0,
		);
	},
	renderResult(result, options, theme) {
		// Collapsed: show only the summary from details.collapsed
		if (!options.expanded) {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const details = result.details as any;
			const summary = details?.collapsed;
			if (summary) {
				// Status indicators:
				// ✓ search succeeded (results found or completed normally)
				// ⚠ search used fallback engine (grep instead of ripgrep) or had partial issues
				// ✗ search failed (outliner missing or no engine available)
				if (summary.includes("[⚠")) {
					return new Text(theme.fg("warning", `⚠ ${summary}`), 0, 0);
				}
				return new Text(theme.fg("success", `✓ ${summary}`), 0, 0);
			}
			// Fallback if no summary available
			return new Text(theme.fg("success", "✓ search completed"), 0, 0);
		}

		// Expanded: show full output as normal
		const text = (result.content ?? [])
			.filter((c) => c.type === "text")
			.map((c) => c.text ?? "")
			.join("\n");
		return new Text(text || "(no results)", 0, 0);
	},
};

export const webSearchRenderers: DisplayRenderers = {
	renderCall(args, theme, context) {
		if (context?.expanded) return renderExpandedCall("web_search", args, theme);
		const query = String(args?.query ?? "...");
		return new Text(
			`${theme.fg("toolTitle", theme.bold("web_search "))}${theme.fg("accent", query.slice(0, 80))}`,
			0,
			0,
		);
	},
	renderResult(result: AgentToolResult<unknown>, options: ToolRenderResultOptions, theme: Theme) {
		const details = result.details as { status?: SearchStatus; resultCount?: number } | undefined;
		if (options.expanded) {
			return new Text(
				result.content
					.filter((item) => item.type === "text")
					.map((item) => item.text ?? "")
					.join("\n") || "(no output)",
				0,
				0,
			);
		}
		const status = details?.status ?? "ok";
		if (status === "ok" || status === "partial_failure") {
			const marker = status === "partial_failure" ? "⚠" : "✓";
			const count = details?.resultCount ?? 0;
			return new Text(
				theme.fg(
					status === "partial_failure" ? "warning" : "success",
					`${marker} web search (${count} ${count === 1 ? "result" : "results"}${status === "partial_failure" ? "; partial" : ""})`,
				),
				0,
				0,
			);
		}
		return new Text(theme.fg("error", `✗ web search ${status}`), 0, 0);
	},
};

export const webBrowseRenderers: DisplayRenderers = {
	renderCall(args, theme, context) {
		if (context?.expanded)
			return renderExpandedCall(
				"web_browse",
				{
					...args,
					command: safeCommandPreview(args?.command ?? "", Infinity),
				},
				theme,
			);
		return new Text(
			`${theme.fg("toolTitle", theme.bold("web_browse "))}${theme.fg("accent", safeCommandPreview((args?.command as string) || ""))}`,
			0,
			0,
		);
	},
	renderResult(
		result: AgentToolResult<unknown>,
		{ expanded }: ToolRenderResultOptions,
		theme: Theme,
		context: { isError: boolean },
	) {
		if (expanded) return new Text(resultText(result), 0, 0);
		const details = result.details as { error?: string } | undefined;
		if (context.isError || details?.error) {
			return new Text(theme.fg("error", "✗ Firefox action failed"), 0, 0);
		}
		return new Text(theme.fg("success", "✓ Firefox action completed"), 0, 0);
	},
};

export const questionRenderers: DisplayRenderers = {
	renderCall(args, theme, context) {
		if (context?.expanded) return renderExpandedCall("question", args, theme);
		const q = typeof args?.question === "string" ? args.question : "...";
		const preview = q.length > 50 ? q.slice(0, 47) + "..." : q;
		return new Text(
			theme.fg("toolTitle", theme.bold("question")) + " " + theme.fg("accent", preview),
			0,
			0,
		);
	},
};

export const readCallRenderers: DisplayRenderers = {
	renderCall(args, theme, context) {
		if (context?.expanded) return renderExpandedCall("read", args, theme);
		const rawPath = args?.path;
		const pathStr = rawPath ? String(rawPath) : "...";
		const symbol = args?.symbol;
		const suffix = symbol ? `::${String(symbol)}` : "";
		return new Text(
			`${theme.fg("toolTitle", theme.bold("read"))} ${theme.fg("accent", pathStr)}${theme.fg("warning", suffix)}`,
			0,
			0,
		);
	},
};

export function renderMemoryResult(kind: "store" | "recall") {
	return (
		result: AgentToolResult<unknown>,
		options: ToolRenderResultOptions,
		theme: Theme,
		context: { isError: boolean },
	) => {
		const text = result.content
			.filter((item) => item.type === "text")
			.map((item) => item.text)
			.join("\n");
		if (options.isPartial)
			return new Text(
				theme.fg("muted", kind === "store" ? "… Storing to memory" : "… Recalling from memory"),
				0,
				0,
			);
		if (options.expanded || context.isError) return new Text(text || "(no output)", 0, 0);
		return new Text(
			theme.fg("success", kind === "store" ? "✓ Queued a memory" : "✓ Recalled a memory"),
			0,
			0,
		);
	};
}

export const storeMemoryRenderers: DisplayRenderers = {
	renderCall(args, theme, context) {
		const title = theme.fg("toolTitle", theme.bold("store_memory"));
		return new Text(context.expanded ? `${title}\n${args.text}` : title, 0, 0);
	},
	renderResult: renderMemoryResult("store"),
};

export const recallMemoryRenderers: DisplayRenderers = {
	renderCall(args, theme, context) {
		const title = theme.fg("toolTitle", theme.bold("recall_memory"));
		return new Text(context.expanded ? `${title}\n${args.text}` : title, 0, 0);
	},
	renderResult: renderMemoryResult("recall"),
};

export function createBashResultRenderer(
	bashState: ReadonlyMap<string, { status: "running" | "completed" | "failed" }>,
	baseRenderResult?: ReturnType<typeof createBashToolDefinition>["renderResult"],
): NonNullable<ReturnType<typeof createBashToolDefinition>["renderResult"]> {
	return (result, options, theme, context) => {
		// If collapsed (not expanded), show only a status indicator
		if (!options.expanded) {
			// Check context for error state (available even if state map lookup fails)
			const isError = context.isError;

			// Try to get state for this tool call from our tracked map
			const toolCallId = context.toolCallId;
			const state = toolCallId ? bashState.get(toolCallId) : undefined;

			// If we have tracked state and it's not running, use it
			if (state && state.status !== "running") {
				if (state.status === "failed") {
					return new Text(theme.fg("error", "✗ bash failed"), 0, 0);
				}
				return new Text(theme.fg("success", "✓ bash executed"), 0, 0);
			}

			// Fallback: use context.isError if state lookup failed
			if (isError) {
				return new Text(theme.fg("error", "✗ bash failed"), 0, 0);
			}
			if (state?.status === "running") {
				return new Text(theme.fg("warning", "⋯ bash running"), 0, 0);
			}

			// Default: assume success if we got here (renderResult means execution completed)
			return new Text(theme.fg("success", "✓ bash executed"), 0, 0);
		}

		// Expanded: delegate to the built-in renderer for full output
		if (baseRenderResult) {
			return baseRenderResult(result, options, theme, context);
		}

		// Fallback: show raw text content
		const text = (result.content ?? [])
			.filter((c) => c.type === "text")
			.map((c) => c.text ?? "")
			.join("\n");
		return new Text(text || "(no output)", 0, 0);
	};
}

export const codemodeRenderers: DisplayRenderers = {
	renderCall(_args, theme) {
		return new Text(theme.fg("toolTitle", theme.bold("codemode")), 0, 0);
	},
	renderResult(_result, options, theme, context) {
		if (options.isPartial) return new Text(theme.fg("warning", "⋯ codemode running"), 0, 0);
		if (context.isError) return new Text(theme.fg("error", "✗ codemode failed"), 0, 0);
		return new Text(theme.fg("success", "✓ codemode executed"), 0, 0);
	},
};
