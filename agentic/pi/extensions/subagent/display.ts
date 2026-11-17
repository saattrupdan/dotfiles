/** Pure subagent display, shared without starting agents or loading profiles. */
import type { Message } from "@earendil-works/pi-ai";
import { ActivityView } from "../_tool-display/activity.ts";
import { toolRenderers } from "../_tool-display/catalog.ts";
import { activityItems, transcripts, type ToolOutput, type ActivityItem } from "./transcript.ts";
import type { DisplayRenderers } from "../_tool-display/types.ts";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { renderExpandedCall } from "../_tool-display/expanded-call.ts";
import { normalizeSubagentTaskName } from "./session-label.ts";
import type { AgentScope } from "./agents.ts";
import type { WorktreeCleanupResult } from "./worktree.ts";

export const COLLAPSED_ITEM_COUNT = 5;

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
	/** Lossless local history, separate from the compact result sent to the model. */
	transcriptId?: string;
	cwd?: string;
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
	partialResults?: Record<string, ToolOutput>;
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
export interface SubagentRenderers extends DisplayRenderers { dispose(): void }

export function createSubagentRenderers(
	labelsByToolCallId: ReadonlyMap<string, string> = new Map(),
	archive = transcripts,
): SubagentRenderers {
	const activeViews = new Set<ActivityView>();
	const views = new WeakMap<object, ActivityView>();
	return {
		dispose() {
			for (const view of activeViews) view.dispose();
			activeViews.clear();
		},
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
		renderResult(result, { expanded, isPartial }, theme, context) {
			const details = result.details as SingleResult | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}
			const key = context.state && typeof context.state === "object" ? context.state : undefined;
			let view = key ? views.get(key) : undefined;
			if (!isPartial && !expanded) {
				view?.dispose();
				if (view) activeViews.delete(view);
				if (key) views.delete(key);
				return new Text(isFailedResult(details)
					? theme.fg("error", "✗ done with errors (Ctrl+O to expand)")
					: theme.fg("success", "✓ All done"), 0, 0);
			}
			view ??= new ActivityView();
			if (key) views.set(key, view);
			if (isPartial) activeViews.add(view);
			else activeViews.delete(view);
			let items: ActivityItem[];
			let historyError: string | undefined;
			try {
				items = details.transcriptId ? archive.read(details.transcriptId, expanded)
					: activityItems(details.messages, details.partialResults);
			} catch (error) {
				historyError = `History unavailable: ${(error as Error).message}`;
				items = activityItems(details.messages, details.partialResults);
			}
			if (!expanded) items = items.slice(-COLLAPSED_ITEM_COUNT);
			if (!isPartial) items = items.map((item) => item.type === "toolCall" && item.isPartial
				? { ...item, isPartial: false, result: {
					...item.result,
					content: [...(item.result?.content ?? []), { type: "text", text: "Tool interrupted when the subagent stopped." }],
					details: item.result?.details,
					isError: true,
				} } : item);
			view.update(items, {
				theme, expanded, cwd: details.cwd ?? context.cwd ?? process.cwd(),
				showImages: context.showImages ?? false, outputPad: context.outputPad ?? 1,
				invalidate: context.invalidate,
				resolve(name, item) {
					if (name !== "subagent") return toolRenderers(name);
					const label = item.type === "toolCall"
						? (item.result?.details as SingleResult | undefined)?.sessionLabel : undefined;
					return createSubagentRenderers(typeof label === "string" && item.type === "toolCall"
						? new Map([[item.id, label]]) : undefined) as import("@earendil-works/pi-coding-agent").ToolRenderers;
				},
			});
			const container = new Container();
			if (isFailedResult(details)) container.addChild(new Text(theme.fg("error", "✗ failed"), 0, 0));
			const attempts = formatModelAttempts(details.modelAttempts);
			if (attempts) container.addChild(new Text(theme.fg("dim", `Models: ${attempts}`), 0, 0));
			if (isFailedResult(details) && details.errorMessage)
				container.addChild(new Text(theme.fg("error", `Error: ${details.errorMessage}`), 0, 0));
			if (expanded) {
				container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
				container.addChild(new Text(theme.fg("dim", details.task), 0, 0));
				container.addChild(new Spacer(1));
				container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
				if (historyError) container.addChild(new Text(theme.fg("error", historyError), 0, 0));
			}
			container.addChild(view);
			const finalOutput = result.content.find((part) => part.type === "text");
			const output = !isPartial && finalOutput?.type === "text" ? finalOutput.text : "";
			if (expanded && output && !items.some((item) => item.type === "text" && item.text.trim() === output.trim()))
				container.addChild(new Markdown(output.trim(), 0, 0, getMarkdownTheme()));
			if (!items.length && !output)
				container.addChild(new Text(theme.fg("muted", isPartial ? "(no output yet)" : "(no output)"), 0, 0));
			const usage = formatUsageStats(details.usage, details.model);
			if (usage) container.addChild(new Text(theme.fg("dim", usage), 0, 0));
			return container;
		},
	};
}
