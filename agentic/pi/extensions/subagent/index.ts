/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 *
 * Supports three modes:
 *   - Single: { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 *   - Chain: { chain: [{ agent: "name", task: "... {previous} ..." }, ...] }
 *
 * Uses JSON mode to capture structured output from subagents.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import { type ExtensionAPI, getAgentDir, getMarkdownTheme, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.ts";
import {
	createWorktree,
	findRepoRoot,
	mergeAndCleanup,
	sweepOrphanedSubagentArtifacts,
	type WorktreeCleanupResult,
} from "./worktree.ts";
import {
	encodeResponse,
	tryParseRequest,
	type QuestionItem,
	type QuestionResponse,
} from "../_question_protocol/protocol.ts";
import { dispatchAsk } from "../question/index.ts";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const COLLAPSED_ITEM_COUNT = 10;
const PER_TASK_OUTPUT_CAP = 50 * 1024;

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
		case "web_fetch": {
			const url = (args.url || "...") as string;
			const preview = url.length > 80 ? `${url.slice(0, 80)}...` : url;
			return themeFg("muted", "web_fetch ") + themeFg("accent", preview);
		}
		case "web_search": {
			const query = (args.query || "") as string;
			const preview = query.length > 80 ? `${query.slice(0, 80)}...` : query;
			return themeFg("muted", "web_search ") + themeFg("accent", `"${preview}"`);
		}
		case "web_browse": {
			const command = (args.command || "...") as string;
			const preview = command.length > 80 ? `${command.slice(0, 80)}...` : command;
			return themeFg("muted", "web_browse ") + themeFg("accent", preview);
		}
		case "subagent": {
			if (args.chain && Array.isArray(args.chain)) {
				return themeFg("muted", "subagent ") + themeFg("accent", `chain(${args.chain.length})`);
			}
			if (args.tasks && Array.isArray(args.tasks)) {
				const agentList = args.tasks.map((t: any) => t?.agent).filter(Boolean).join(",");
				return themeFg("muted", "subagent ") + themeFg("accent", `parallel(${args.tasks.length})`) + themeFg("dim", ` [${agentList}]`);
			}
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

interface SingleResult {
	agent: string;
	agentSource: "user" | "project" | "unknown";
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
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

interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SingleResult[];
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

function getResultOutput(result: SingleResult): string {
	if (isFailedResult(result)) {
		return result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
	}
	return getFinalOutput(result.messages) || "(no output)";
}

function truncateParallelOutput(output: string): string {
	const byteLength = Buffer.byteLength(output, "utf8");
	if (byteLength <= PER_TASK_OUTPUT_CAP) return output;

	let truncated = output.slice(0, PER_TASK_OUTPUT_CAP);
	while (Buffer.byteLength(truncated, "utf8") > PER_TASK_OUTPUT_CAP) {
		truncated = truncated.slice(0, -1);
	}
	return `${truncated}\n\n[Output truncated: ${byteLength - Buffer.byteLength(truncated, "utf8")} bytes omitted. Full output preserved in tool details.]`;
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
			 * `subagent` calls, `result.details` is a `SubagentDetails` and
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

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
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

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

/**
 * Fulfil a question request coming up from a child subagent. The caller
 * decides where the answer comes from (orchestrator's ctx.ui, or forwarded
 * further up the chain via this process's own stdin/stderr).
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
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
	fulfillQuestion: QuestionFulfiller | undefined,
	taskSkills?: string[],
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
			step,
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
					step,
				};
			}
		}
	}

	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	if (agent.model) args.push("--model", agent.model);
	if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

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
		args.push("--no-skills");
		const skillsRoot = path.join(getAgentDir(), "skills");
		for (const name of effectiveSkills) {
			const skillDir = path.join(skillsRoot, name);
			const skillFile = path.join(skillDir, "SKILL.md");
			if (fs.existsSync(skillFile)) {
				args.push("--skill", skillDir);
			} else {
				console.error(`subagent: skill "${name}" not found at ${skillFile}; skipping for agent "${agent.name}".`);
			}
		}
	}

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;
	let worktreeHandle: Awaited<ReturnType<typeof createWorktree>> | null = null;

	// If the agent declares worktree: true, spin up a fresh git worktree on a
	// new branch and run the subagent there. Cleanup/merge happens in finally.
	let effectiveCwd: string | undefined = cwd;
	if (agent.worktree) {
		const worktreeCwd = cwd ?? defaultCwd;
		const repoRoot = await findRepoRoot(worktreeCwd);
		if (!repoRoot) {
			console.error("subagent: worktree requested but cwd is not a git repo; running in-place.");
		} else {
			// Reclaim any orphaned subagent worktrees/branches left behind by
			// previous pi runs that died before they could clean up. Cheap,
			// idempotent, runs at most once per repo per process.
			await sweepOrphanedSubagentArtifacts(repoRoot);
			try {
				worktreeHandle = await createWorktree(worktreeCwd, agent.name);
				effectiveCwd = worktreeHandle.worktreePath;
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
					step,
				};
			}
		}
	}

	const currentResult: SingleResult = {
		agent: agentName,
		agentSource: agent.source,
		task,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model: agent.model,
		step,
		worktreePath: worktreeHandle?.worktreePath,
		worktreeBranch: worktreeHandle?.branchName,
	};

	const emitUpdate = () => {
		if (onUpdate) {
			onUpdate({
				content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
				details: makeDetails([currentResult]),
			});
		}
	};

	try {
		if (agent.systemPrompt.trim()) {
			const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}

		args.push(`Task: ${task}`);
		let wasAborted = false;

		const exitCode = await new Promise<number>((resolve) => {
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

			proc.stdout.on("data", (data) => {
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
			proc.stderr.on("data", (data) => {
				stderrBuffer += data.toString();
				let nl = stderrBuffer.indexOf("\n");
				while (nl !== -1) {
					handleStderrLine(stderrBuffer.slice(0, nl));
					stderrBuffer = stderrBuffer.slice(nl + 1);
					nl = stderrBuffer.indexOf("\n");
				}
			});

			proc.on("close", (code) => {
				if (buffer.trim()) processLine(buffer);
				if (stderrBuffer.trim()) handleStderrLine(stderrBuffer);
				resolve(code ?? 0);
			});

			proc.on("error", () => {
				resolve(1);
			});

			if (signal) {
				const killProc = () => {
					wasAborted = true;
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
		if (wasAborted) throw new Error("Subagent was aborted");

		return currentResult;
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
		if (worktreeHandle) {
			try {
				const cleanup = await mergeAndCleanup(worktreeHandle);
				currentResult.worktreeCleanup = cleanup;
				if (!cleanup.merged && !cleanup.skipped) {
					// Merge failed: surface in stderr so the orchestrator sees it.
					currentResult.stderr = `${currentResult.stderr}\n[worktree] ${cleanup.message}`.trim();
					if (currentResult.exitCode === 0) currentResult.exitCode = 1;
					if (!currentResult.errorMessage) currentResult.errorMessage = cleanup.message;
				}
			} catch (err) {
				currentResult.stderr = `${currentResult.stderr}\n[worktree] cleanup failed: ${(err as Error).message}`.trim();
				if (currentResult.exitCode === 0) currentResult.exitCode = 1;
			}
		}
	}
}

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	skills: Type.Optional(Type.Array(Type.String(), { description: "Override skills for this task" })),
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	skills: Type.Optional(Type.Array(Type.String(), { description: "Override skills for this step" })),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
	default: "user",
});

const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (for single mode)" })),
	task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" })),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true }),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
	skills: Type.Optional(Type.Array(Type.String(), { description: "Override skills for all tasks in this call" })),
});

function buildSubagentDescription(): string {
	const base = [
		"Delegate tasks to specialized subagents with isolated context.",
		"Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
		'Default agent scope is "user" (from ~/.pi/agent/agents).',
		'To enable project-local agents in .pi/agents, set agentScope: "both" (or "project").',
	].join(" ");

	// Enumerate user-scope agents at load time so the orchestrator can see
	// each agent's name, one-line description, and tool allow-list without
	// having to guess. Project-scope agents aren't included (cwd isn't known
	// at load time), but they're rare; the orchestrator still gets a list on
	// invocation errors.
	let agents: AgentConfig[] = [];
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

			// Builds the per-call question fulfiller used when a child subagent
			// emits a PI_QUESTION_REQUEST: defers to ctx.ui in the orchestrator,
			// or forwards up the chain when this process is itself a subagent.
			const fulfillQuestion: QuestionFulfiller = (questions, sig) =>
				dispatchAsk(ctx, questions, sig);

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

			const makeDetails =
				(mode: "single" | "parallel" | "chain") =>
				(results: SingleResult[]): SubagentDetails => ({
					mode,
					agentScope,
					projectAgentsDir: discovery.projectAgentsDir,
					results,
				});

			if (modeCount !== 1) {
				const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
				return {
					content: [
						{
							type: "text",
							text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}`,
						},
					],
					details: makeDetails("single")([]),
				};
			}

			if ((agentScope === "project" || agentScope === "both") && confirmProjectAgents && ctx.hasUI) {
				const requestedAgentNames = new Set<string>();
				if (params.chain) for (const step of params.chain) requestedAgentNames.add(step.agent);
				if (params.tasks) for (const t of params.tasks) requestedAgentNames.add(t.agent);
				if (params.agent) requestedAgentNames.add(params.agent);

				const projectAgentsRequested = Array.from(requestedAgentNames)
					.map((name) => agents.find((a) => a.name === name))
					.filter((a): a is AgentConfig => a?.source === "project");

				if (projectAgentsRequested.length > 0) {
					const names = projectAgentsRequested.map((a) => a.name).join(", ");
					const dir = discovery.projectAgentsDir ?? "(unknown)";
					const ok = await ctx.ui.confirm(
						"Run project-local agents?",
						`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
					);
					if (!ok)
						return {
							content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
							details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
						};
				}
			}

			if (params.chain && params.chain.length > 0) {
				const results: SingleResult[] = [];
				let previousOutput = "";

				for (let i = 0; i < params.chain.length; i++) {
					const step = params.chain[i];
					const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);

					// Create update callback that includes all previous results
					const chainUpdate: OnUpdateCallback | undefined = onUpdate
						? (partial) => {
								// Combine completed results with current streaming result
								const currentResult = partial.details?.results[0];
								if (currentResult) {
									const allResults = [...results, currentResult];
									onUpdate({
										content: partial.content,
										details: makeDetails("chain")(allResults),
									});
								}
							}
						: undefined;

					const result = await runSingleAgent(
						ctx.cwd,
						agents,
						step.agent,
						taskWithContext,
						step.cwd,
						i + 1,
						signal,
						chainUpdate,
						makeDetails("chain"),
						fulfillQuestion,
						step.skills,
					);
					results.push(result);

					const isError = isFailedResult(result);
					if (isError) {
						const errorMsg = getResultOutput(result);
						return {
							content: [{ type: "text", text: `Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}` }],
							details: makeDetails("chain")(results),
							isError: true,
						};
					}
					previousOutput = getFinalOutput(result.messages);
				}
				return {
					content: [{ type: "text", text: getFinalOutput(results[results.length - 1].messages) || "(no output)" }],
					details: makeDetails("chain")(results),
				};
			}

			if (params.tasks && params.tasks.length > 0) {
				if (params.tasks.length > MAX_PARALLEL_TASKS)
					return {
						content: [
							{
								type: "text",
								text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
							},
						],
						details: makeDetails("parallel")([]),
					};

				// Track all results for streaming updates
				const allResults: SingleResult[] = new Array(params.tasks.length);

				// Initialize placeholder results
				for (let i = 0; i < params.tasks.length; i++) {
					allResults[i] = {
						agent: params.tasks[i].agent,
						agentSource: "unknown",
						task: params.tasks[i].task,
						exitCode: -1, // -1 = still running
						messages: [],
						stderr: "",
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
					};
				}

				const emitParallelUpdate = () => {
					if (onUpdate) {
						const running = allResults.filter((r) => r.exitCode === -1).length;
						const done = allResults.filter((r) => r.exitCode !== -1).length;
						onUpdate({
							content: [
								{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` },
							],
							details: makeDetails("parallel")([...allResults]),
						});
					}
				};

				const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (t, index) => {
					const result = await runSingleAgent(
						ctx.cwd,
						agents,
						t.agent,
						t.task,
						t.cwd,
						undefined,
						signal,
						// Per-task update callback
						(partial) => {
							if (partial.details?.results[0]) {
								allResults[index] = partial.details.results[0];
								emitParallelUpdate();
							}
						},
						makeDetails("parallel"),
						fulfillQuestion,
						t.skills,
					);
					allResults[index] = result;
					emitParallelUpdate();
					return result;
				});

				const successCount = results.filter((r) => !isFailedResult(r)).length;
				const summaries = results.map((r) => {
					const output = truncateParallelOutput(getResultOutput(r));
					const status = isFailedResult(r)
						? `failed${r.stopReason && r.stopReason !== "end" ? ` (${r.stopReason})` : ""}`
						: "completed";
					return `### [${r.agent}] ${status}\n\n${output}`;
				});
				return {
					content: [
						{
							type: "text",
							text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`,
						},
					],
					details: makeDetails("parallel")(results),
				};
			}

			if (params.agent && params.task) {
				const result = await runSingleAgent(
					ctx.cwd,
					agents,
					params.agent,
					params.task,
					params.cwd,
					undefined,
					signal,
					onUpdate,
					makeDetails("single"),
					fulfillQuestion,
					params.skills,
				);
				const isError = isFailedResult(result);
				if (isError) {
					const errorMsg = getResultOutput(result);
					return {
						content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${errorMsg}` }],
						details: makeDetails("single")([result]),
						isError: true,
					};
				}
				return {
					content: [{ type: "text", text: getFinalOutput(result.messages) || "(no output)" }],
					details: makeDetails("single")([result]),
				};
			}

			const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
			return {
				content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }],
				details: makeDetails("single")([]),
			};
		},

		renderCall(args, theme, _context) {
			const scope: AgentScope = args.agentScope ?? "user";
			if (args.chain && args.chain.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `chain (${args.chain.length} steps)`) +
					theme.fg("muted", ` [${scope}]`);
				for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
					const step = args.chain[i];
					// Clean up {previous} placeholder for display
					const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
					const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
					text +=
						"\n  " +
						theme.fg("muted", `${i + 1}.`) +
						" " +
						theme.fg("accent", step.agent) +
						theme.fg("dim", ` ${preview}`);
				}
				if (args.chain.length > 3) text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			if (args.tasks && args.tasks.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `parallel (${args.tasks.length} tasks)`) +
					theme.fg("muted", ` [${scope}]`);
				for (const t of args.tasks.slice(0, 3)) {
					const preview = t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
					text += `\n  ${theme.fg("accent", t.agent)}${theme.fg("dim", ` ${preview}`)}`;
				}
				if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			const agentName = args.agent || "...";
			const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
			let text =
				theme.fg("toolTitle", theme.bold("subagent ")) +
				theme.fg("accent", agentName) +
				theme.fg("muted", ` [${scope}]`);
			text += `\n  ${theme.fg("dim", preview)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as SubagentDetails | undefined;
			if (!details || details.results.length === 0) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
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

				const nestedDetails = item.result.details as SubagentDetails | undefined;
				if (!nestedDetails || !nestedDetails.results || nestedDetails.results.length === 0) return [head];

				const lines = [head];
				const showHeaders = nestedDetails.mode !== "single" || nestedDetails.results.length > 1;
				for (const r of nestedDetails.results) {
					const childIndent = "  ".repeat(depth + 1);
					if (showHeaders) {
						const statusIcon =
							r.exitCode === -1
								? theme.fg("warning", "⏳")
								: isFailedResult(r)
									? theme.fg("error", "✗")
									: theme.fg("success", "✓");
						const stepLabel = r.step ? `step ${r.step}: ` : "";
						lines.push(
							`${childIndent}${theme.fg("muted", "─── ")}${stepLabel}${theme.fg("accent", r.agent)} ${statusIcon}`,
						);
					}
					lines.push(...renderNested(r.messages, depth + 1, (r as any).partialResults));
				}
				return lines;
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

			if (details.mode === "single" && details.results.length === 1) {
				const r = details.results[0];
				const isError = isFailedResult(r);
				const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
				const displayItems = getDisplayItems(r.messages, (r as any).partialResults);
				const finalOutput = getFinalOutput(r.messages);

				if (expanded) {
					const container = new Container();
					let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
					if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
					container.addChild(new Text(header, 0, 0));
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
				if (isError && r.errorMessage) text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
				else if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
				else {
					text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
					if (displayItems.length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				}
				const usageStr = formatUsageStats(r.usage, r.model);
				if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
				return new Text(text, 0, 0);
			}

			const aggregateUsage = (results: SingleResult[]) => {
				const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
				for (const r of results) {
					total.input += r.usage.input;
					total.output += r.usage.output;
					total.cacheRead += r.usage.cacheRead;
					total.cacheWrite += r.usage.cacheWrite;
					total.cost += r.usage.cost;
					total.turns += r.usage.turns;
				}
				return total;
			};

			if (details.mode === "chain") {
				const successCount = details.results.filter((r) => r.exitCode === 0).length;
				const icon = successCount === details.results.length ? theme.fg("success", "✓") : theme.fg("error", "✗");

				if (expanded) {
					const container = new Container();
					container.addChild(
						new Text(
							icon +
								" " +
								theme.fg("toolTitle", theme.bold("chain ")) +
								theme.fg("accent", `${successCount}/${details.results.length} steps`),
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
						const displayItems = getDisplayItems(r.messages, (r as any).partialResults);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(
								`${theme.fg("muted", `─── Step ${r.step}: `) + theme.fg("accent", r.agent)} ${rIcon}`,
								0,
								0,
							),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const stepUsage = formatUsageStats(r.usage, r.model);
						if (stepUsage) container.addChild(new Text(theme.fg("dim", stepUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed view
				let text =
					icon +
					" " +
					theme.fg("toolTitle", theme.bold("chain ")) +
					theme.fg("accent", `${successCount}/${details.results.length} steps`);
				for (const r of details.results) {
					const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
					const displayItems = getDisplayItems(r.messages, (r as any).partialResults);
					text += `\n\n${theme.fg("muted", `─── Step ${r.step}: `)}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				const usageStr = formatUsageStats(aggregateUsage(details.results));
				if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			if (details.mode === "parallel") {
				const running = details.results.filter((r) => r.exitCode === -1).length;
				const successCount = details.results.filter((r) => r.exitCode !== -1 && !isFailedResult(r)).length;
				const failCount = details.results.filter((r) => r.exitCode !== -1 && isFailedResult(r)).length;
				const isRunning = running > 0;
				const icon = isRunning
					? theme.fg("warning", "⏳")
					: failCount > 0
						? theme.fg("warning", "◐")
						: theme.fg("success", "✓");
				const status = isRunning
					? `${successCount + failCount}/${details.results.length} done, ${running} running`
					: `${successCount}/${details.results.length} tasks`;

				if (expanded && !isRunning) {
					const container = new Container();
					container.addChild(
						new Text(
							`${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`,
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = isFailedResult(r) ? theme.fg("error", "✗") : theme.fg("success", "✓");
						const displayItems = getDisplayItems(r.messages, (r as any).partialResults);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(`${theme.fg("muted", "─── ") + theme.fg("accent", r.agent)} ${rIcon}`, 0, 0),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const taskUsage = formatUsageStats(r.usage, r.model);
						if (taskUsage) container.addChild(new Text(theme.fg("dim", taskUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed view (or still running)
				let text = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;
				for (const r of details.results) {
					const rIcon =
						r.exitCode === -1
							? theme.fg("warning", "⏳")
							: isFailedResult(r)
								? theme.fg("error", "✗")
								: theme.fg("success", "✓");
					const displayItems = getDisplayItems(r.messages, (r as any).partialResults);
					text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (displayItems.length === 0)
						text += `\n${theme.fg("muted", r.exitCode === -1 ? "(running...)" : "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				if (!isRunning) {
					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				}
				if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
		},
	});
}
