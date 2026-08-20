/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 *
 * Each invocation runs one specialized subagent with an isolated context window.
 *
 * Uses JSON mode to capture structured output from subagents.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
// @ts-expect-error - module not installed but types are used
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
// @ts-expect-error - module not installed but types are used
import type { Message } from "@earendil-works/pi-ai";
// @ts-expect-error - module not installed but types are used
import { StringEnum } from "@earendil-works/pi-ai";
import { type ExtensionAPI, getAgentDir, getMarkdownTheme, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type AgentConfig, type AgentScope, discoverAgents, findNearestProjectAgentsDir } from "./agents.ts";
import {
	createWorktree,
	findRepoRoot,
	mergeAndCleanup,
	sweepOrphanedSubagentArtifacts,
	type WorktreeCleanupResult,
	type WorktreeHandle,
} from "./worktree.ts";
import {
	encodeResponse,
	tryParseRequest,
	type QuestionItem,
	type QuestionResponse,
} from "../_question_protocol/protocol.ts";
import { dispatchAsk } from "../question/index.ts";

const COLLAPSED_ITEM_COUNT = 10;

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsageStats(
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

function formatToolCall(
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
		case "tavily_search": {
			const query = (args.query || "") as string;
			const preview = query.length > 80 ? `${query.slice(0, 80)}...` : query;
			return themeFg("muted", "tavily_search ") + themeFg("accent", `"${preview}"`);
		}
		case "web_browse": {
			const command = (args.command || "...") as string;
			const preview = command.length > 80 ? `${command.slice(0, 80)}...` : command;
			return themeFg("muted", "web_browse ") + themeFg("accent", preview);
		}
		case "subagent": {
			const agent = (args.agent || "?") as string;
			const task = (args.task || "") as string;
			const preview = task.length > 80 ? `${task.slice(0, 80)}...` : task;
			return themeFg("muted", "subagent ") + themeFg("accent", agent) + themeFg("dim", ` ${preview}`);
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
			return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
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

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

interface ModelAttempt {
	model?: string;
	exitCode: number;
	succeeded: boolean;
	stopReason?: string;
	errorMessage?: string;
}

interface SingleResult {
	agent: string;
	agentSource: "user" | "project" | "unknown";
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
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

function getFinalOutput(messages: Message[]): string {
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

function isFailedResult(result: SingleResult): boolean {
	return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

function isModelAttemptFailure(result: SingleResult): boolean {
	return result.exitCode !== 0 || result.stopReason === "error";
}

function isRetryableModelAttemptFailure(result: SingleResult): boolean {
	if (
		result.stopReason === "aborted" ||
		result.stopReason === "refused" ||
		result.stopReason === "validation"
	) {
		return false;
	}
	return isModelAttemptFailure(result);
}

function getResultOutput(result: SingleResult): string {
	if (isFailedResult(result)) {
		return result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
	}
	return getFinalOutput(result.messages) || "(no output)";
}

type DisplayItem =
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

function getDisplayItems(
	messages: Message[],
	partialResults?: Record<string, { content?: any[]; details?: any; isError?: boolean }>,
): DisplayItem[] {
	const items: DisplayItem[] = [];
	const resultById = new Map<string, { content: any[]; details?: any; isError: boolean }>();
	for (const msg of messages) {
		if ((msg as any).role === "toolResult") {
			const tr = msg as any;
			resultById.set(tr.toolCallId, { content: tr.content, details: tr.details, isError: tr.isError });
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
							? { content: partial.content ?? [], details: partial.details, isError: !!partial.isError }
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

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir: tmpDir, filePath };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

interface CurrentModel {
	provider: string;
	id: string;
}

function modelToCliPattern(model: CurrentModel | undefined): string | undefined {
	if (!model) return undefined;
	return `${model.provider}/${model.id}`;
}

function normalizeRequestedModel(model: string | undefined): string | undefined {
	const trimmed = model?.trim();
	return trimmed ? trimmed : undefined;
}

function buildModelFallbacks(
	requestedModel: string | undefined,
	agentModels: string[] | undefined,
	sessionModel: string | undefined,
): (string | undefined)[] {
	const candidates: string[] = [];
	const requested = normalizeRequestedModel(requestedModel);
	if (requested) candidates.push(requested);
	if (agentModels && agentModels.length > 0) candidates.push(...agentModels);

	// Always add session model as final fallback (deduped below)
	if (sessionModel) candidates.push(sessionModel);

	const seen = new Set<string>();
	const models: string[] = [];
	for (const model of candidates) {
		const trimmed = model.trim();
		if (!trimmed || seen.has(trimmed)) continue;
		seen.add(trimmed);
		models.push(trimmed);
	}
	return models.length > 0 ? models : [undefined];
}

function formatAttemptModel(model: string | undefined): string {
	return model ?? "(default)";
}

function formatModelAttempts(attempts: ModelAttempt[] | undefined): string | undefined {
	if (!attempts || attempts.length <= 1) return undefined;
	return attempts
		.map((a) => {
			const status = a.succeeded ? "ok" : `failed${a.stopReason ? `/${a.stopReason}` : ""}`;
			return `${formatAttemptModel(a.model)}: ${status}`;
		})
		.join(", ");
}

interface GitCommandResult {
	code: number;
	stdout: string;
	stderr: string;
}

function runGitForDiscard(cwd: string, args: string[]): Promise<GitCommandResult> {
	return new Promise((resolve) => {
		const proc = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		proc.stdout.on("data", (d: Buffer) => {
			stdout += d.toString();
		});
		proc.stderr.on("data", (d: Buffer) => {
			stderr += d.toString();
		});
		proc.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
		proc.on("error", (err) => resolve({ code: 1, stdout, stderr: stderr + err.message }));
	});
}

async function discardWorktreeAttempt(
	handle: WorktreeHandle,
	reason: string,
): Promise<WorktreeCleanupResult> {
	const messages = [reason];
	const rmRes = await runGitForDiscard(handle.parentRepoRoot, [
		"worktree",
		"remove",
		"--force",
		handle.worktreePath,
	]);
	if (rmRes.code !== 0) {
		try {
			await fs.promises.rm(handle.worktreePath, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
		const pruneRes = await runGitForDiscard(handle.parentRepoRoot, ["worktree", "prune"]);
		if (pruneRes.code !== 0) {
			messages.push(`Failed to prune worktree records: ${pruneRes.stderr.trim() || pruneRes.stdout.trim()}`);
		}
	}

	const brRes = await runGitForDiscard(handle.parentRepoRoot, ["branch", "-D", handle.branchName]);
	if (brRes.code !== 0 && !brRes.stderr.includes("not found")) {
		messages.push(`Failed to delete branch ${handle.branchName}: ${brRes.stderr.trim() || brRes.stdout.trim()}`);
	}

	try {
		await fs.promises.rm(path.dirname(handle.worktreePath), { recursive: true, force: true });
	} catch {
		/* ignore */
	}

	return { merged: false, skipped: true, message: messages.join(" ") };
}

type OnUpdateCallback = (partial: AgentToolResult<SingleResult>) => void;

/**
 * Fulfil a question request coming up from a child subagent. The caller
 * decides where the answer comes from (orchestrator's ctx.ui, or forwarded
 * further up through this process's own stdin/stderr).
 */
export type QuestionFulfiller = (
	questions: QuestionItem[],
	signal: AbortSignal | undefined,
) => Promise<{ answers?: string[]; error?: string }>;

async function runSingleAgent(
	defaultCwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	cwd: string | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	fulfillQuestion: QuestionFulfiller | undefined,
	sessionModel: string | undefined,
	requestedModel?: string,
	taskSkills?: string[],
	agentScope?: AgentScope,
): Promise<SingleResult> {
	const agent = agents.find((a) => a.name === agentName);

	if (!agent) {
		const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		return {
			agent: agentName,
			agentSource: "unknown",
			task,
			exitCode: 1,
			messages: [],
			stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		};
	}

	// Frontmatter-defined refusal patterns: a cheap, deterministic guardrail
	// that runs before we spawn the child process. The agent decides what it
	// will not accept (e.g. "don't ask me for full file contents") and we
	// short-circuit with the configured explanation rather than burning a
	// subagent turn just to have the child reject the request.
	if (agent.refuse && agent.refuse.length > 0) {
		for (const rule of agent.refuse) {
			let regex: RegExp;
			try {
				regex = new RegExp(rule.pattern, rule.flags ?? "i");
			} catch {
				continue; // already warned at load time
			}
			if (regex.test(task)) {
				const refusal = `[${agentName}] refused: ${rule.message}`;
				return {
					agent: agentName,
					agentSource: agent.source,
					task,
					exitCode: 1,
					messages: [],
					stderr: refusal,
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
					stopReason: "refused",
					errorMessage: refusal,
				};
			}
		}
	}

	if (signal?.aborted) {
		return {
			agent: agentName,
			agentSource: agent.source,
			task,
			exitCode: 1,
			messages: [],
			stderr: "Subagent was aborted before launch.",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			stopReason: "aborted",
			errorMessage: "Subagent was aborted before launch.",
		};
	}

	const modelFallbacks = buildModelFallbacks(requestedModel, agent.model, sessionModel);
	const baseArgs: string[] = ["--mode", "json", "-p", "--no-session"];
	if (agent.tools && agent.tools.length > 0) baseArgs.push("--tools", agent.tools.join(","));

	// Skill scoping.
	//
	// Child pi accepts `--skill <path>` (repeatable; takes a path to either a
	// SKILL.md file or a directory containing one) plus `--no-skills` to
	// disable default discovery from `~/.pi/agent/skills` and `./.pi/skills`.
	// There is no `PI_SKILL_PATHS` env var; the CLI flags are the supported
	// surface. See $PI/dist/core/skills.js (`loadSkills`) and
	// $PI/dist/core/resource-loader.js (`reload`/`updateSkillsFromPaths`).
	//
	// Allow-list semantics (see agents.ts AgentConfig.skills):
	//   undefined  → no restriction; let the child discover skills normally.
	//   []         → strict empty allow-list; child sees no skills.
	//   ["a","b"]  → only those skills (plus any per-task additions).
	const hasAllowList = agent.skills !== undefined || (taskSkills && taskSkills.length > 0);
	if (hasAllowList) {
		const effectiveSkills = Array.from(new Set([...(agent.skills ?? []), ...(taskSkills ?? [])]));
		baseArgs.push("--no-skills");
		const skillsRoot = path.join(getAgentDir(), "skills");
		for (const name of effectiveSkills) {
			const skillDir = path.join(skillsRoot, name);
			const skillFile = path.join(skillDir, "SKILL.md");
			if (fs.existsSync(skillFile)) {
				baseArgs.push("--skill", skillDir);
			} else {
				console.error(`subagent: skill "${name}" not found at ${skillFile}; skipping for agent "${agent.name}".`);
			}
		}
	}

	// Extension scoping.
	//
	// Child pi accepts `--extension <path>` (repeatable) plus `--no-extensions`
	// to disable its own native discovery from `~/.pi/agent/extensions` (and the
	// project `.pi/extensions`).
	//
	// Allow-list semantics (see agents.ts AgentConfig.extensions):
	//   undefined  → no flags; let the child discover extensions natively, exactly
	//                like a normal pi session. We must NOT enumerate every dir and
	//                pass it via --extension while leaving native discovery on —
	//                that double-registers every tool and the child aborts at
	//                startup ("Tool <x> conflicts").
	//   []         → strict empty allow-list; `--no-extensions`, child sees none.
	//   ["a","b"]  → `--no-extensions`, then load only those via --extension.
	const hasExtAllowList = agent.extensions !== undefined;
	if (hasExtAllowList) {
		baseArgs.push("--no-extensions");

		const scope = agentScope ?? "user";
		const userExtensionsRoot = path.join(getAgentDir(), "extensions");
		const projectAgentsDir = findNearestProjectAgentsDir(defaultCwd);
		const projectExtensionsRoot =
			scope === "project" || scope === "both" ? projectAgentsDir?.replace(/\/agents$/, "/extensions") ?? null : null;

		for (const name of agent.extensions!) {
			let extensionPath: string | null = null;

			// Check user extensions dir first, then project dir.
			const userExtDir = path.join(userExtensionsRoot, name);
			if (fs.existsSync(path.join(userExtDir, "index.ts"))) {
				extensionPath = userExtDir;
			} else if (projectExtensionsRoot) {
				const projExtDir = path.join(projectExtensionsRoot, name);
				if (fs.existsSync(path.join(projExtDir, "index.ts"))) {
					extensionPath = projExtDir;
				}
			}

			if (extensionPath) {
				baseArgs.push("--extension", extensionPath);
			} else {
				console.error(
					`subagent: extension "${name}" not found (no index.ts in user or project dir); skipping for agent "${agent.name}".`,
				);
			}
		}
	}

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;
	const attempts: ModelAttempt[] = [];

	const appendAttemptSummary = (result: SingleResult): void => {
		const attemptedModels = attempts.map((a) => formatAttemptModel(a.model)).join(", ");
		const summary = `All model attempts failed. Attempted models: ${attemptedModels}.`;
		result.modelAttempts = [...attempts];
		result.errorMessage = result.errorMessage ? `${result.errorMessage}\n${summary}` : summary;
		result.stderr = `${result.stderr}\n${summary}`.trim();
	};

	try {
		if (agent.systemPrompt.trim()) {
			const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			baseArgs.push("--system-prompt", tmpPromptPath);
		}

		let lastResult: SingleResult | undefined;
		for (let attemptIndex = 0; attemptIndex < modelFallbacks.length; attemptIndex++) {
			const childModel = modelFallbacks[attemptIndex];
			let worktreeHandle: Awaited<ReturnType<typeof createWorktree>> | null = null;
			let effectiveCwd: string | undefined = cwd;
			const currentResult: SingleResult = {
				agent: agentName,
				agentSource: agent.source,
				task,
				exitCode: 0,
				messages: [],
				stderr: "",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
				model: childModel,
			};

			const emitUpdate = () => {
				if (onUpdate) {
					onUpdate({
						content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
						details: currentResult,
					});
				}
			};

			try {
				if (signal?.aborted) {
					currentResult.exitCode = 1;
					currentResult.stopReason = "aborted";
					currentResult.errorMessage = "Subagent was aborted before launch.";
					currentResult.stderr = currentResult.errorMessage;
					return currentResult;
				}

				// If the agent declares worktree: true, spin up a fresh git worktree on a
				// new branch for this model attempt. Failed attempts are discarded below;
				// only a successful child run is merged back into the parent worktree.
				if (agent.worktree) {
					const worktreeCwd = cwd ?? defaultCwd;
					const repoRoot = await findRepoRoot(worktreeCwd);
					if (!repoRoot) {
						console.error("subagent: worktree requested but cwd is not a git repo; running in-place.");
					} else {
						await sweepOrphanedSubagentArtifacts(repoRoot);
						try {
							worktreeHandle = await createWorktree(worktreeCwd, agent.name);
							effectiveCwd = worktreeHandle.worktreePath;
							currentResult.worktreePath = worktreeHandle.worktreePath;
							currentResult.worktreeBranch = worktreeHandle.branchName;
						} catch (err) {
							return {
								agent: agentName,
								agentSource: agent.source,
								task,
								exitCode: 1,
								messages: [],
								stderr: `Failed to create worktree: ${(err as Error).message}`,
								usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
								errorMessage: (err as Error).message,
							};
						}
					}
				}

				const args = [...baseArgs];
				if (childModel) args.push("--model", childModel);
				args.push(`Task: ${task}`);
				let wasAborted = false;
				let spawnErrorMessage: string | undefined;
				let exitTimeout: NodeJS.Timeout | undefined;

				// Exit timeout: after the last message, give the subagent N seconds to exit
				// cleanly, then force-kill. Prevents hanging when pi doesn't shut down cleanly
				// (e.g., extension cleanup deadlock, open handles, undisposed resources).
				// Default 30s, configurable via PI_SUBAGENT_EXIT_TIMEOUT_MS.
				const exitTimeoutMs = process.env.PI_SUBAGENT_EXIT_TIMEOUT_MS
					? parseInt(process.env.PI_SUBAGENT_EXIT_TIMEOUT_MS, 10)
					: 30 * 1000;

				const exitCode = await new Promise<number>((resolve) => {
					let resolved = false;
					const resolveOnce = (code: number) => {
						if (resolved) return;
						resolved = true;
						resolve(code);
					};
					const invocation = getPiInvocation(args);
					// stdin stays "ignore" (= /dev/null in the child) so the child
					// never blocks on a startup stdin read. The question bridge uses
					// an extra pipe on fd 3 for parent→child responses; the child
					// finds it via PI_QUESTION_RESPONSE_FD. Child→parent requests
					// still travel on stderr as tagged lines.
					const proc = spawn(invocation.command, invocation.args, {
						cwd: effectiveCwd ?? defaultCwd,
						shell: false,
						stdio: ["ignore", "pipe", "pipe", "pipe"],
						env: {
							...process.env,
							PI_SUBAGENT_CHILD: "1",
							PI_QUESTION_RESPONSE_FD: "3",
						},
					});

					// Exit timeout: start after last message, clear on process exit.
					const startExitTimeout = () => {
						if (exitTimeout) clearTimeout(exitTimeout);
						exitTimeout = setTimeout(() => {
							proc.kill("SIGTERM");
							setTimeout(() => {
								if (!proc.killed) proc.kill("SIGKILL");
							}, 5000);
						}, exitTimeoutMs);
					};
					const clearExitTimeout = () => {
						if (exitTimeout) {
							clearTimeout(exitTimeout);
							exitTimeout = undefined;
						}
					};
					const responseChannel = proc.stdio[3] as NodeJS.WritableStream | null;
					let buffer = "";

					const processLine = (line: string) => {
						if (!line.trim()) return;
						let event: any;
						try {
							event = JSON.parse(line);
						} catch {
							return;
						}

						// Start exit timeout after the final message (agent_end).
						// The subagent should exit shortly after this; if not, force-kill.
						if (event.type === "agent_end") {
							startExitTimeout();
						}

						if (event.type === "message_end" && event.message) {
							const msg = event.message as Message;
							currentResult.messages.push(msg);

							if (msg.role === "assistant") {
								currentResult.usage.turns++;
								const usage = msg.usage;
								if (usage) {
									currentResult.usage.input += usage.input || 0;
									currentResult.usage.output += usage.output || 0;
									currentResult.usage.cacheRead += usage.cacheRead || 0;
									currentResult.usage.cacheWrite += usage.cacheWrite || 0;
									currentResult.usage.cost += usage.cost?.total || 0;
									currentResult.usage.contextTokens = usage.totalTokens || 0;
								}
								if (!currentResult.model && msg.model) currentResult.model = msg.model;
								if (msg.stopReason) currentResult.stopReason = msg.stopReason;
								if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
							}
							emitUpdate();
						}

						if (event.type === "tool_execution_end" && event.toolCallId) {
							const tcid = event.toolCallId as string;
							if (currentResult.partialResults) {
								delete currentResult.partialResults[tcid];
							}
							emitUpdate();
						}

						// `tool_execution_update` carries the in-progress AgentToolResult
						// emitted by an extension via `onUpdate`. For nested subagent
						// calls, this is how we see the grandchild's live tool calls
						// before the parent's `subagent` tool returns. Stash by
						// toolCallId; the renderer falls back to this when the matching
						// tool_result_end hasn't arrived yet.
						if (event.type === "tool_execution_update" && event.toolCallId) {
							const partial = event.partialResult;
							if (partial) {
								if (!currentResult.partialResults) currentResult.partialResults = {};
								currentResult.partialResults[event.toolCallId] = {
									content: partial.content,
									details: partial.details,
									isError: partial.isError,
								};
							}
							emitUpdate();
						}
					};

					proc.stdout?.on("data", (data) => {
						buffer += data.toString();
						const lines = buffer.split("\n");
						buffer = lines.pop() || "";
						for (const line of lines) processLine(line);
					});

					// Stderr carries both real diagnostics and (when the child calls the
					// `question` tool) tagged protocol lines we must intercept. Buffer
					// by line; route protocol lines to fulfillQuestion, append the rest
					// to the visible stderr.
					let stderrBuffer = "";
					const handleStderrLine = (line: string) => {
						const req = tryParseRequest(line);
						if (!req) {
							currentResult.stderr += `${line}\n`;
							return;
						}
						if (!fulfillQuestion) {
							const res: QuestionResponse = {
								id: req.id,
								error: "No question handler available in this parent process.",
							};
							try {
								responseChannel?.write(encodeResponse(res));
							} catch {
								/* ignore */
							}
							return;
						}
						void (async () => {
							let out: { answers?: string[]; error?: string };
							try {
								out = await fulfillQuestion(req.questions, signal);
							} catch (err) {
								out = { error: `bridge failed: ${(err as Error).message}` };
							}
							const res: QuestionResponse = { id: req.id, ...out };
							try {
								responseChannel?.write(encodeResponse(res));
							} catch {
								/* child may have exited */
							}
						})();
					};
					proc.stderr?.on("data", (data) => {
						stderrBuffer += data.toString();
						let nl = stderrBuffer.indexOf("\n");
						while (nl !== -1) {
							handleStderrLine(stderrBuffer.slice(0, nl));
							stderrBuffer = stderrBuffer.slice(nl + 1);
							nl = stderrBuffer.indexOf("\n");
						}
					});

					// Track stream completion separately from process exit. The `close`
					// event fires when the process exits, but stdout/stderr may still
					// have buffered data that hasn't been emitted via "data" events yet.
					// We must wait for both streams to end before resolving.
					let stdoutEnded = false;
					let stderrEnded = false;
					let exitCodeValue: number | null = null;

					const tryResolve = () => {
						if (!stdoutEnded || !stderrEnded || exitCodeValue === null) return;
						// Process any remaining data in buffers
						if (buffer.trim()) processLine(buffer);
						if (stderrBuffer.trim()) handleStderrLine(stderrBuffer);
						clearExitTimeout();
						resolveOnce(exitCodeValue);
					};

					proc.stdout?.on("end", () => {
						stdoutEnded = true;
						tryResolve();
					});

					proc.stderr?.on("end", () => {
						stderrEnded = true;
						tryResolve();
					});

					proc.on("close", (code) => {
						exitCodeValue = code ?? 0;
						tryResolve();
					});

					proc.on("error", (err) => {
						spawnErrorMessage = err.message;
						currentResult.stderr += `${err.message}\n`;
						clearExitTimeout();
						resolveOnce(1);
					});

					if (signal) {
						const killProc = () => {
							wasAborted = true;
							clearExitTimeout();
							proc.kill("SIGTERM");
							setTimeout(() => {
								if (!proc.killed) proc.kill("SIGKILL");
							}, 5000);
						};
						if (signal.aborted) killProc();
						else signal.addEventListener("abort", killProc, { once: true });
					}
				});

				currentResult.exitCode = exitCode;
				if (spawnErrorMessage && !currentResult.errorMessage) currentResult.errorMessage = spawnErrorMessage;

				const parentAborted = wasAborted || signal?.aborted;
				const modelAttemptFailed = isModelAttemptFailure(currentResult);
				const retryModelAttempt = isRetryableModelAttemptFailure(currentResult);
				if (worktreeHandle) {
					try {
						const cleanup = modelAttemptFailed || parentAborted
							? await discardWorktreeAttempt(
								worktreeHandle,
								`Discarded worktree ${worktreeHandle.branchName} after failed model attempt.`,
							)
							: await mergeAndCleanup(worktreeHandle);
						currentResult.worktreeCleanup = cleanup;
						if (!modelAttemptFailed && !parentAborted && !cleanup.merged && !cleanup.skipped) {
							currentResult.stderr = `${currentResult.stderr}\n[worktree] ${cleanup.message}`.trim();
							if (currentResult.exitCode === 0) currentResult.exitCode = 1;
							if (!currentResult.errorMessage) currentResult.errorMessage = cleanup.message;
						}
					} catch (err) {
						currentResult.stderr = `${currentResult.stderr}\n[worktree] cleanup failed: ${(err as Error).message}`.trim();
						if (currentResult.exitCode === 0) currentResult.exitCode = 1;
					}
				}

				if (parentAborted) {
					currentResult.stopReason = "aborted";
					currentResult.errorMessage = currentResult.errorMessage || "Subagent was aborted";
					return currentResult;
				}

				const attemptFailed = isModelAttemptFailure(currentResult);
				const attempt: ModelAttempt = {
					model: childModel,
					exitCode: currentResult.exitCode,
					succeeded: !attemptFailed,
					stopReason: currentResult.stopReason,
					errorMessage: currentResult.errorMessage,
				};
				attempts.push(attempt);
				currentResult.modelAttempts = [...attempts];
				lastResult = currentResult;

				if (!retryModelAttempt) return currentResult;
			} catch (err) {
				if (worktreeHandle) {
					try {
						currentResult.worktreeCleanup = await discardWorktreeAttempt(
							worktreeHandle,
							`Discarded worktree ${worktreeHandle.branchName} after failed model attempt.`,
						);
					} catch {
						/* ignore; surface the original failure */
					}
				}
				currentResult.exitCode = 1;
				currentResult.errorMessage = (err as Error).message;
				currentResult.stderr = `${currentResult.stderr}\n${(err as Error).message}`.trim();
				const attempt: ModelAttempt = {
					model: childModel,
					exitCode: 1,
					succeeded: false,
					errorMessage: currentResult.errorMessage,
				};
				attempts.push(attempt);
				currentResult.modelAttempts = [...attempts];
				lastResult = currentResult;
			}
		}

		if (lastResult) {
			appendAttemptSummary(lastResult);
			return lastResult;
		}

		return {
			agent: agentName,
			agentSource: agent.source,
			task,
			exitCode: 1,
			messages: [],
			stderr: "No model attempts were run.",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			errorMessage: "No model attempts were run.",
		};
	} finally {
		if (tmpPromptPath)
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
		if (tmpPromptDir)
			try {
				fs.rmdirSync(tmpPromptDir);
			} catch {
				/* ignore */
			}
	}
}

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
	default: "user",
});

const SubagentParams = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true }),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	model: Type.Optional(Type.String({ description: "Preferred model for this call" })),
	skills: Type.Optional(Type.Array(Type.String(), { description: "Override skills for this call" })),
});

function buildSubagentDescription(): string {
	const base = [
		"Delegate one task to a specialized subagent with isolated context.",
		'Default agent scope is "user" (from ~/.pi/agent/agents).',
		'To enable project-local agents in .pi/agents, set agentScope: "both" (or "project").',
	].join(" ");

	// Enumerate user-scope agents at load time so the orchestrator can see
	// each agent's name, one-line description, and tool allow-list without
	// having to guess. Project-scope agents aren't included (cwd isn't known
	// at load time), but they're rare; the orchestrator still gets a list on
	// invocation errors.
	let agents: AgentConfig[];
	try {
		agents = discoverAgents(process.cwd(), "user").agents;
	} catch {
		return base;
	}
	if (agents.length === 0) return base;

	const lines = agents
		.slice()
		.sort((a, b) => a.name.localeCompare(b.name))
		.map((a) => {
			const tools = a.tools && a.tools.length > 0 ? a.tools.join(", ") : "(default)";
			return `- ${a.name}: ${a.description} Tools: ${tools}.`;
		});

	return `${base}\n\nAvailable agents (user scope):\n${lines.join("\n")}`;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: buildSubagentDescription(),
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const agentScope: AgentScope = params.agentScope ?? "user";
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = discovery.agents;
			const confirmProjectAgents = params.confirmProjectAgents ?? true;
			const sessionModel = modelToCliPattern(ctx.model);

			// A child question is answered by the orchestrator, including when this
			// process is itself a subagent and the request must travel up to its parent.
			const fulfillQuestion: QuestionFulfiller = (questions, sig) =>
				dispatchAsk(ctx, questions, sig);

			if ((agentScope === "project" || agentScope === "both") && confirmProjectAgents && ctx.hasUI) {
				const projectAgent = agents.find((a) => a.name === params.agent && a.source === "project");
				if (projectAgent) {
					const dir = discovery.projectAgentsDir ?? "(unknown)";
					const ok = await ctx.ui.confirm(
						"Run project-local agents?",
						`Agents: ${projectAgent.name}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
					);
					if (!ok) {
						return {
							content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
							details: {
								agent: params.agent,
								agentSource: projectAgent.source,
								task: params.task,
								exitCode: 1,
								messages: [],
								stderr: "Canceled: project-local agents not approved.",
								usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
								stopReason: "aborted",
								errorMessage: "Canceled: project-local agents not approved.",
							},
						};
					}
				}
			}

			const result = await runSingleAgent(
				ctx.cwd,
				agents,
				params.agent,
				params.task,
				params.cwd,
				signal,
				onUpdate,
				fulfillQuestion,
				sessionModel,
				params.model,
				params.skills,
				agentScope,
			);
			if (isFailedResult(result)) {
				const errorMsg = getResultOutput(result);
				return {
					content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${errorMsg}` }],
					details: result,
					isError: true,
				};
			}
			return {
				content: [{ type: "text", text: getFinalOutput(result.messages) || "(no output)" }],
				details: result,
			};
		},

		renderCall(args, theme, context) {
			const scope: AgentScope = args.agentScope ?? "user";
			const agentName = args.agent || "...";
			const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
			let text =
				theme.fg("toolTitle", theme.bold("subagent ")) +
				theme.fg("accent", agentName) +
				theme.fg("muted", ` [${scope}]`);
			if (context.isPartial) text += `\n  ${theme.fg("dim", preview)}`;
			return new Text(text, 0, 0);
		},		renderResult(result, { expanded, isPartial }, theme, _context) {
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
				if (skipped > 0) lines.push(`${indent}${theme.fg("muted", `... ${skipped} earlier items`)}`);
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
					const text = depth > 0 ? item.text.split("\n")[0] : (expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n"));
					return [`${indent}${theme.fg("toolOutput", text)}`];
				}
				const head = `${indent}${theme.fg("muted", "→ ")}${formatToolCall(item.name, item.args, theme.fg.bind(theme))}`;
				if (item.name !== "subagent" || !item.result) return [head];

				const nestedResult = item.result.details as SingleResult | undefined;
				if (!nestedResult) return [head];

				return [head, ...renderNested(nestedResult.messages, depth + 1, nestedResult.partialResults)];
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

			const r = details;
			const isError = isFailedResult(r);
			const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
			const displayItems = getDisplayItems(r.messages, (r as any).partialResults);
			const finalOutput = getFinalOutput(r.messages);

			if (expanded) {
				const container = new Container();
				let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
				if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
				container.addChild(new Text(header, 0, 0));
				const modelAttemptSummary = formatModelAttempts(r.modelAttempts);
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
									theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
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

			let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
			if (isError && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
			const modelAttemptSummary = formatModelAttempts(r.modelAttempts);
			if (modelAttemptSummary) text += `\n${theme.fg("dim", `Models: ${modelAttemptSummary}`)}`;
			if (isError && r.errorMessage) text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
			else if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
			else {
				text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
				if (displayItems.length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
			}
			const usageStr = formatUsageStats(r.usage, r.model);
			if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
			return new Text(text, 0, 0);
		},
	});
}
