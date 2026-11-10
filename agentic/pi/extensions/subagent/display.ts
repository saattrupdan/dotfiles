/** Pure subagent display, shared without starting agents or loading profiles. */
import * as os from "node:os";
import type { Message } from "@earendil-works/pi-ai";
import type { DisplayRenderers } from "../_tool-display/types.ts";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { renderExpandedCall } from "../_tool-display/expanded-call.ts";
import { safeCommandPreview } from "../web-browse/command.ts";
import { normalizeSubagentTaskName } from "./session-label.ts";
import type { AgentScope } from "./agents.ts";
import type { WorktreeCleanupResult } from "./worktree.ts";

export const COLLAPSED_ITEM_COUNT = 10;

export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

export function formatUsageStats(
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens?: number;
		turns?: number;
	},
	model?: string,
): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) {
		parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	}
	if (model) parts.push(model);
	return parts.join(" ");
}

export function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: any, text: string) => string,
): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};

	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const symbol = args.symbol as string | undefined;
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let text = themeFg("accent", filePath);
			if (symbol) {
				text += themeFg("warning", `::${symbol}`);
			} else if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}
			return themeFg("muted", "read ") + text;
		}
		case "search": {
			const query = (args.query || "") as string;
			const kind = args.kind as string | undefined;
			const previewed = query.length > 80 ? `${query.slice(0, 80)}...` : query;
			let text = themeFg("muted", "search ") + themeFg("accent", `/${previewed}/`);
			if (kind && kind !== "any") text += themeFg("dim", ` [${kind}]`);
			return text;
		}
		case "code_tree": {
			const rawPath = (args.path || ".") as string;
			const depth = args.depth as number | undefined;
			let text = themeFg("muted", "code_tree ") + themeFg("accent", shortenPath(rawPath));
			if (depth !== undefined) text += themeFg("dim", ` depth=${depth}`);
			return text;
		}
		case "web_search": {
			const query = (args.query || "") as string;
			const preview = query.length > 80 ? `${query.slice(0, 80)}...` : query;
			return themeFg("muted", "web_search ") + themeFg("accent", `"${preview}"`);
		}
		case "web_browse": {
			return (
				themeFg("muted", "web_browse ") +
				themeFg("accent", safeCommandPreview((args.command || "...") as string))
			);
		}
		case "subagent": {
			const agent = (args.agent || "?") as string;
			const taskName = normalizeSubagentTaskName((args.taskName || "...") as string);
			return (
				themeFg("muted", "subagent ") + themeFg("accent", agent) + themeFg("dim", `: ${taskName}`)
			);
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = themeFg("muted", "write ") + themeFg("accent", filePath);
			if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
		}
		case "ls": {
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "find ") +
				themeFg("accent", pattern) +
				themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "grep ") +
				themeFg("accent", `/${pattern}/`) +
				themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 120 ? `${argsStr.slice(0, 120)}...` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export interface ModelAttempt {
	model?: string;
	exitCode: number;
	succeeded: boolean;
	stopReason?: string;
	errorMessage?: string;
}

export interface SingleResult {
	agent: string;
	agentSource: "user" | "project" | "unknown";
	/**
	 * Label this child was spawned with, e.g. `builder2: Fix the parser`. Same
	 * string the child receives in PI_SUBAGENT_SESSION_NAME and applies as its
	 * own session name; see session-label.ts.
	 */
	sessionLabel?: string;
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	finalOutput?: string;
	modelAttempts?: ModelAttempt[];
	stopReason?: string;
	errorMessage?: string;
	worktreePath?: string;
	worktreeBranch?: string;
	worktreeCleanup?: WorktreeCleanupResult;
	/**
	 * Live tool-execution partials, keyed by the assistant's toolCallId. Pi
	 * emits `tool_execution_update` events with a `partialResult` while a
	 * tool is still running; we stash the latest one per call so the renderer
	 * can show in-progress state for nested subagent invocations *before* the
	 * final `tool_result_end` arrives. Cleared once the real result lands.
	 */
	partialResults?: Record<string, { content?: any[]; details?: any; isError?: boolean }>;
}

export function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

export function isFailedResult(result: SingleResult): boolean {
	return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

export function isModelAttemptFailure(result: SingleResult): boolean {
	return result.exitCode !== 0 || result.stopReason === "error";
}

export function isRetryableModelAttemptFailure(result: SingleResult): boolean {
	if (
		result.stopReason === "aborted" ||
		result.stopReason === "refused" ||
		result.stopReason === "validation"
	) {
		return false;
	}
	return isModelAttemptFailure(result);
}

export function getResultOutput(result: SingleResult): string {
	if (isFailedResult(result)) {
		return (
			result.errorMessage ||
			result.stderr ||
			result.finalOutput ||
			getFinalOutput(result.messages) ||
			"(no output)"
		);
	}
	return result.finalOutput || getFinalOutput(result.messages) || "(no output)";
}

export type DisplayItem =
	| { type: "text"; text: string }
	| {
			type: "toolCall";
			id: string;
			name: string;
			args: Record<string, any>;
			/**
			 * The matching tool-result message, if it has arrived. For nested
			 * `subagent` calls, `result.details` is a `SingleResult` and
			 * carries the full child transcript — so we can render what the
			 * child (and its children, recursively) did inline under this call.
			 */
			result?: { content: any[]; details?: any; isError: boolean };
	  };

export function getDisplayItems(
	messages: Message[],
	partialResults?: Record<string, { content?: any[]; details?: any; isError?: boolean }>,
): DisplayItem[] {
	const items: DisplayItem[] = [];
	const resultById = new Map<string, { content: any[]; details?: any; isError: boolean }>();
	for (const msg of messages) {
		if ((msg as any).role === "toolResult") {
			const tr = msg as any;
			resultById.set(tr.toolCallId, {
				content: tr.content,
				details: tr.details,
				isError: tr.isError,
			});
		}
	}
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall") {
					const id = (part as any).id;
					const real = resultById.get(id);
					const partial = partialResults?.[id];
					const result = real
						? real
						: partial
							? {
									content: partial.content ?? [],
									details: partial.details,
									isError: !!partial.isError,
								}
							: undefined;
					items.push({
						type: "toolCall",
						id,
						name: part.name,
						args: part.arguments,
						result,
					});
				}
			}
		}
	}
	return items;
}

export function formatAttemptModel(model: string | undefined): string {
	return model ?? "(default)";
}

export function formatModelAttempts(attempts: ModelAttempt[] | undefined): string | undefined {
	if (!attempts || attempts.length <= 1) return undefined;
	return attempts
		.map((a) => {
			const status = a.succeeded ? "ok" : `failed${a.stopReason ? `/${a.stopReason}` : ""}`;
			return `${formatAttemptModel(a.model)}: ${status}`;
		})
		.join(", ");
}
export function createSubagentRenderers(
	labelsByToolCallId: ReadonlyMap<string, string> = new Map(),
): DisplayRenderers {
	return {
		renderCall(args, theme, context) {
			const scope = (args.agentScope as AgentScope | undefined) ?? "user";
			// The ordinal is handed out in execute(), so the first paint omits only
			// that number; it can still show the concrete task name immediately.
			const taskName = normalizeSubagentTaskName(args.taskName || "...");
			const agentName =
				labelsByToolCallId.get(context.toolCallId) ?? `${args.agent || "..."}: ${taskName}`;
			const preview = args.task
				? args.task.length > 60
					? `${args.task.slice(0, 60)}...`
					: args.task
				: "...";
			let text =
				theme.fg("toolTitle", theme.bold("subagent ")) +
				theme.fg("accent", agentName) +
				theme.fg("muted", ` [${scope}]`);
			if (context.expanded)
				return renderExpandedCall(`subagent ${agentName} [${scope}]`, args, theme);
			if (context.isPartial) text += `\n  ${theme.fg("dim", preview)}`;
			return new Text(text, 0, 0);
		},
		renderResult(result, { expanded, isPartial }, theme, _context) {
			const details = result.details as SingleResult | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			// While the tool is still running (isPartial) we show live progress.
			// Once finished, the collapsed view only reports completion; full output
			// remains available via Ctrl+O.
			if (!isPartial && !expanded) {
				const anyFailed = isFailedResult(details);
				if (anyFailed)
					return new Text(theme.fg("error", "✗ done with errors (Ctrl+O to expand)"), 0, 0);
				return new Text(theme.fg("success", "✓ All done"), 0, 0);
			}

			const mdTheme = getMarkdownTheme();

			// Strip blank/whitespace-only text items, and collapse internal blank
			// lines inside the text we do show. Otherwise streamed assistant
			// "thinking" text introduces random gaps in the per-subagent log.
			const cleanTextItem = (raw: string): string => {
				const lines = raw.split("\n").map((l) => l.replace(/\s+$/, ""));
				const kept: string[] = [];
				for (const line of lines) {
					if (line.trim() === "") continue;
					kept.push(line);
				}
				return kept.join("\n");
			};

			// Per-nested-block cap so a chatty grandchild doesn't drown the view.
			const NESTED_ITEM_LIMIT = 12;

			// Recursively render the tool calls a nested subagent made. We walk
			// the child's full message stream, dedupe blank text, and only show
			// tool calls + non-blank text. Each level is indented two spaces.
			const renderNested = (
				messages: Message[],
				depth: number,
				partials?: Record<string, any>,
			): string[] => {
				const items = getDisplayItems(messages, partials);
				const cleaned: DisplayItem[] = [];
				for (const item of items) {
					if (item.type === "text") {
						const text = cleanTextItem(item.text);
						if (!text) continue;
						cleaned.push({ type: "text", text });
					} else {
						cleaned.push(item);
					}
				}
				const skipped = cleaned.length > NESTED_ITEM_LIMIT ? cleaned.length - NESTED_ITEM_LIMIT : 0;
				const toShow = skipped > 0 ? cleaned.slice(-NESTED_ITEM_LIMIT) : cleaned;
				const indent = "  ".repeat(depth);
				const lines: string[] = [];
				if (skipped > 0)
					lines.push(`${indent}${theme.fg("muted", `... ${skipped} earlier items`)}`);
				for (const item of toShow) {
					lines.push(...renderItem(item, depth));
				}
				return lines;
			};

			// Render a single item, recursing into nested subagent results.
			const renderItem = (item: DisplayItem, depth: number): string[] => {
				const indent = "  ".repeat(depth);
				if (item.type === "text") {
					// Only show the first line at depth >= 1 — nested text is
					// usually the child's intermediate narration and clutters
					// the parent's view.
					const text =
						depth > 0
							? item.text.split("\n")[0]
							: expanded
								? item.text
								: item.text.split("\n").slice(0, 3).join("\n");
					return [`${indent}${theme.fg("toolOutput", text)}`];
				}
				const head = `${indent}${theme.fg("muted", "→ ")}${formatToolCall(item.name, item.args, theme.fg.bind(theme))}`;
				if (item.name !== "subagent" || !item.result) return [head];

				const nestedResult = item.result.details as SingleResult | undefined;
				if (!nestedResult) return [head];

				return [
					head,
					...renderNested(nestedResult.messages, depth + 1, nestedResult.partialResults),
				];
			};

			const renderDisplayItems = (items: DisplayItem[], limit?: number) => {
				const normalized: DisplayItem[] = [];
				for (const item of items) {
					if (item.type === "text") {
						const cleaned = cleanTextItem(item.text);
						if (!cleaned) continue;
						normalized.push({ type: "text", text: cleaned });
					} else {
						normalized.push(item);
					}
				}
				const toShow = limit ? normalized.slice(-limit) : normalized;
				const skipped = limit && normalized.length > limit ? normalized.length - limit : 0;
				const lines: string[] = [];
				if (skipped > 0) lines.push(theme.fg("muted", `... ${skipped} earlier items`));
				for (const item of toShow) {
					lines.push(...renderItem(item, 0));
				}
				return lines.join("\n");
			};

			// Pi stacks renderCall and renderResult inside one box, and the call row
			// above us already names the child (`subagent builder1: <task name> [user]`),
			// so the result must not repeat that identity line. It adds only what the
			// call row cannot know yet: failures, model attempts, and the output.
			const r = details;
			const isError = isFailedResult(r);
			const displayItems = getDisplayItems(r.messages, (r as any).partialResults);
			const output = result.content.find((part) => part.type === "text");
			const finalOutput =
				!isPartial && output?.type === "text" && !isFailedResult(r)
					? output.text
					: getFinalOutput(r.messages);
			const modelAttemptSummary = formatModelAttempts(r.modelAttempts);
			const failureLine = `${theme.fg("error", "✗ failed")}${
				r.stopReason ? ` ${theme.fg("error", `[${r.stopReason}]`)}` : ""
			}`;

			if (expanded) {
				const container = new Container();
				if (isError) container.addChild(new Text(failureLine, 0, 0));
				if (modelAttemptSummary)
					container.addChild(new Text(theme.fg("dim", `Models: ${modelAttemptSummary}`), 0, 0));
				if (isError && r.errorMessage)
					container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
				container.addChild(new Spacer(1));
				container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
				container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
				container.addChild(new Spacer(1));
				container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
				if (displayItems.length === 0 && !finalOutput) {
					container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
				} else {
					for (const item of displayItems) {
						if (item.type === "toolCall")
							container.addChild(
								new Text(
									theme.fg("muted", "→ ") +
										formatToolCall(item.name, item.args, theme.fg.bind(theme)),
									0,
									0,
								),
							);
					}
					if (finalOutput) {
						container.addChild(new Spacer(1));
						container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
					}
				}
				const usageStr = formatUsageStats(r.usage, r.model);
				if (usageStr) {
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
				}
				return container;
			}

			// Live view while the child is still running. Pi tints the box with the
			// pending background for us, so no "running" marker is needed here —
			// just the tail of what the child has done so far. (A green ✓ here was
			// both a duplicate of the call row and a promise the run had not kept.)
			let text = "";
			if (isError) text += `${failureLine}\n`;
			if (modelAttemptSummary) text += `${theme.fg("dim", `Models: ${modelAttemptSummary}`)}\n`;
			if (isError && r.errorMessage) text += `${theme.fg("error", `Error: ${r.errorMessage}`)}\n`;
			if (displayItems.length === 0) text += theme.fg("muted", "(no output yet)");
			else {
				text += renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT);
				if (displayItems.length > COLLAPSED_ITEM_COUNT)
					text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
			}
			const usageStr = formatUsageStats(r.usage, r.model);
			if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
			return new Text(text, 0, 0);
		},
	};
}
