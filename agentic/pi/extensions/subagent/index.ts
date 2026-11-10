import { createSubagentRenderers, ModelAttempt, SingleResult, getFinalOutput, isFailedResult, isModelAttemptFailure, isRetryableModelAttemptFailure, getResultOutput, formatAttemptModel } from "./display.ts";
import { remotePromptsEnabled } from "../_remote_bridge/prompts.ts";
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
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { StringEnum, type Message } from "@earendil-works/pi-ai";
import { type ExtensionAPI, getAgentDir, withFileMutationQueue } from "@earendil-works/pi-coding-agent";

import { Type } from "typebox";

import { type AgentConfig, type AgentScope, delegatableAgents, discoverAgents, findNearestProjectAgentsDir } from "./agents.ts";
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

import { interactiveQueue } from "../_interactive_queue/queue.ts";
import { dispatchAsk } from "../question/index.ts";
import { getPiInvocation } from "./pi-invocation.ts";
import { createSubagentLabelCounter, SUBAGENT_TASK_NAME_PATTERN } from "./session-label.ts";
import { resolveSkillAllowList } from "./skill-scope.ts";
import { compactMessage, compactResult } from "./compact-result.ts";

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir: tmpDir, filePath };
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
	taskName: string,
	cwd: string | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	fulfillQuestion: QuestionFulfiller | undefined,
	sessionModel: string | undefined,
	requestedModel?: string,
	taskSkills?: string[],
	agentScope?: AgentScope,
	sessionLabel?: string,
): Promise<SingleResult> {
	const agent = agents.find((a) => a.name === agentName && a.subagent);

	if (!agent) {
		const available = agents.filter((a) => a.subagent).map((a) => `"${a.name}"`).join(", ") || "none";
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
	if (agent.tools !== undefined) {
		if (agent.tools.length === 0) baseArgs.push("--no-tools");
		else baseArgs.push("--tools", agent.tools.join(","));
	}

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
	const effectiveSkills = resolveSkillAllowList(agent.skills, taskSkills);
	if (effectiveSkills !== undefined) {
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
				sessionLabel,
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
					// PI_SUBAGENT_SESSION_NAME is the label the child adopts as its
					// own session name (see session-label.ts and
					// extensions/conversation-name, which short-circuits on it instead
					// of spawning a nested `pi -p` to invent one). It is always set
					// explicitly: our own value must never be inherited down to a
					// grandchild, which would name it after its grandparent.
					const childEnv: NodeJS.ProcessEnv = {
						...process.env,
						PI_SUBAGENT_CHILD: "1",
						PI_QUESTION_RESPONSE_FD: "3",
					};
					if (sessionLabel) {
						childEnv.PI_SUBAGENT_SESSION_NAME = sessionLabel;
					} else {
						delete childEnv.PI_SUBAGENT_SESSION_NAME;
					}
					const proc = spawn(invocation.command, invocation.args, {
						cwd: effectiveCwd ?? defaultCwd,
						shell: false,
						stdio: ["ignore", "pipe", "pipe", "pipe"],
						env: childEnv,
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
							currentResult.messages.push(compactMessage(msg));
							if (currentResult.messages.length > 200) currentResult.messages.shift();

							if (msg.role === "assistant") {
								const output = getFinalOutput([msg]);
								if (output) currentResult.finalOutput = output;
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
									content: [],
									details: partial.details?.messages ? compactResult(partial.details, true) : undefined,
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
							: await mergeAndCleanup(worktreeHandle, agentName, taskName);
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
	taskName: Type.String({
		description: "Short name describing this task (1–5 words)",
		minLength: 1,
		maxLength: 80,
		pattern: SUBAGENT_TASK_NAME_PATTERN,
	}),
	task: Type.String({ description: "Task to delegate to the agent" }),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true }),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	model: Type.Optional(Type.String({ description: "Preferred model for this call" })),
	skills: Type.Optional(
		Type.Array(Type.String(), { description: "Additional skills for this call (combined with the agent's skills)" }),
	),
});

function buildSubagentDescription(): string {
	const base = [
		"Delegate one task to a specialized subagent with isolated context.",
		"Give every call a 1–5-word taskName describing the concrete task.",
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
	const available = delegatableAgents(agents);
	if (available.length === 0) return base;

	const lines = available
		.sort((a, b) => a.name.localeCompare(b.name))
		.map((a) => {
			const tools = a.tools && a.tools.length > 0 ? a.tools.join(", ") : "(default)";
			return `- ${a.name}: ${a.description} Tools: ${tools}.`;
		});

	return `${base}\n\nAvailable agents (user scope):\n${lines.join("\n")}`;
}

export default function (pi: ExtensionAPI) {
	// Spawn ordinals (builder1, builder2, ...) for this process's lifetime, plus
	// the label each tool call got, so renderCall can show it in its own row.
	const labelCounter = createSubagentLabelCounter();
	const labelsByToolCallId = new Map<string, string>();

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: buildSubagentDescription(),
		parameters: SubagentParams,

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const agentScope = (params.agentScope as AgentScope | undefined) ?? "user";
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = delegatableAgents(discovery.agents);
			const confirmProjectAgents = params.confirmProjectAgents ?? true;
			const sessionModel = modelToCliPattern(ctx.model);

			// We own the child's name: use the concrete task name supplied on this
			// call instead of inheriting the much broader parent conversation name.
			const sessionLabel = labelCounter.next(params.agent, params.taskName);
			labelsByToolCallId.set(toolCallId, sessionLabel);

			// A child question is answered by the orchestrator, including when this
			// process is itself a subagent and the request must travel up to its parent.
			// dispatchAsk queues on the shared interactive queue itself, so it must not
			// be wrapped here.
			const fulfillQuestion: QuestionFulfiller = (questions, sig) => dispatchAsk(ctx, questions, sig);

			if ((agentScope === "project" || agentScope === "both") && confirmProjectAgents && (ctx.hasUI||remotePromptsEnabled())) {
				const projectAgent = agents.find((a) => a.name === params.agent && a.source === "project");
				if (projectAgent) {
					const dir = discovery.projectAgentsDir ?? "(unknown)";
					const remoteApproval=remotePromptsEnabled()?await dispatchAsk(ctx,[{question:`Run project-local agent ${projectAgent.name}? Source: ${dir}. Continue only for trusted repositories.`,options:["Approve","Cancel"]}],signal):undefined;
     if(remoteApproval?.error)throw new Error(remoteApproval.error);
     const ok = remoteApproval ? remoteApproval.answers?.[0]==="Approve" : await interactiveQueue.run(
      (interactionSignal) =>
							ctx.ui.confirm(
								"Run project-local agents?",
								`Agents: ${projectAgent.name}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
								{ signal: interactionSignal },
							),
						signal,
					);
					if (!ok) {
						return {
							content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
							details: {
								agent: params.agent,
								sessionLabel,
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
				params.taskName,
				params.cwd,
				signal,
				onUpdate,
				fulfillQuestion,
				sessionModel,
				params.model,
				params.skills,
				agentScope,
				sessionLabel,
			);
			// Covers the early-return paths inside runSingleAgent, which build their
			// own SingleResult before any of them knows about the label.
			result.sessionLabel = sessionLabel;
			if (isFailedResult(result)) {
				const errorMsg = getResultOutput(result);
				return {
					content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${errorMsg}` }],
					details: compactResult(result),
					isError: true,
				};
			}
			return {
				content: [{ type: "text", text: result.finalOutput || getFinalOutput(result.messages) || "(no output)" }],
				details: compactResult(result),
			};
		},

		...createSubagentRenderers(labelsByToolCallId),


	});
}
