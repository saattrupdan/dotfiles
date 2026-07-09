/**
 * Claude Code Provider
 *
 * Uses the Claude Code CLI (`claude` command) as a provider backend.
 * Executes `claude -p <prompt>` with appropriate flags for each turn.
 *
 * Features:
 * - Uses Claude Code's native session mechanism for conversation continuity
 * - System prompt passed via --system-prompt only (not duplicated in prompt)
 * - Session ID keyed to Pi session file (isolated across Pi sessions, subagents, parallel calls)
 * - Process-start random salt prevents PID reuse collisions
 * - Per-session mutex queue prevents concurrent session ID conflicts
 * - Model selection via --model
 * - --dangerously-skip-permissions enabled
 * - No Pi tool descriptions passed (Claude Code has its own tools)
 *
 * Session strategy:
 * - Session ID is keyed to Pi session file path (ctx.sessionManager.getSessionFile())
 * - Falls back to sessionId if sessionFile unavailable
 * - Process-start salt mixed in to prevent PID reuse collisions
 * - Per-session mutex queue serialises concurrent calls sharing the same session ID
 * - Claude Code maintains conversation history in its session storage
 * - Only the latest user message is sent per turn (not full Pi conversation history)
 *
 * Continuity limits:
 * - Only turns handled by this provider in the same active Pi session are retained
 * - Provider switches (e.g. to a different model provider) break continuity
 * - `pi --continue` that spawns a new process gets a new session (no cross-process persistence)
 * - Pi session switch (/new or session change) gets a fresh Claude Code session
 *
 * Usage:
 *   pi -e ./extensions/claude-code-provider
 *   Then /model to select claude-code/<model-id>
 *
 * Requires: claude CLI installed and authenticated
 */

import type {
	Api,
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	ImageContent,
	Model,
	SimpleStreamOptions,
	TextContent,
	ToolCall,
	ThinkingContent,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { spawn } from "child_process";
import { createHash, randomBytes } from "crypto";

/**
 * Process-start random salt to prevent PID reuse collisions.
 * Generated once when the module is loaded.
 */
const PROCESS_START_SALT = randomBytes(16).toString("hex");

/**
 * Generate a deterministic UUID v4 from Pi session identity + process salt.
 * Uses first 16 bytes of SHA256 hash, then sets version/variant bits per RFC 4122.
 * - Byte 6, high nibble: 0100 = version 4
 * - Byte 8, high nibble: 10xx = variant (8, 9, a, or b)
 *
 * @param sessionIdentity - Pi session file path or sessionId
 * @param cwd - Current working directory
 * @returns UUID v4 string
 */
function generateSessionUUID(sessionIdentity: string, cwd: string): string {
	// Mix in process-start salt to prevent PID reuse collisions
	const hash = createHash("sha256").update(`${sessionIdentity}:${cwd}:${PROCESS_START_SALT}`).digest("hex");
	// Take first 32 hex chars (16 bytes) and format as UUID
	let uuid =
		hash.slice(0, 8) +
		"-" +
		hash.slice(8, 12) +
		"-" +
		hash.slice(12, 16) +
		"-" +
		hash.slice(16, 20) +
		"-" +
		hash.slice(20, 32);
	// Set version bits (byte 6, high nibble = 4)
	uuid = uuid.slice(0, 14) + "4" + uuid.slice(15);
	// Set variant bits (byte 8, high nibble = 8-9-a-b; use "a")
	uuid = uuid.slice(0, 19) + "a" + uuid.slice(20);
	return uuid;
}

/**
 * Per-session mutex queues to prevent concurrent Claude Code session conflicts.
 * Maps session ID -> queue of Promise<void> representing pending operations.
 */
const sessionMutexes = new Map<string, Promise<void>[]>();

/**
 * Acquire a mutex for a session ID, returning a release function.
 * Ensures only one Claude Code call uses a given session ID at a time.
 */
async function acquireSessionMutex(sessionId: string): Promise<() => void> {
	const queue = sessionMutexes.get(sessionId) || [];
	
	// Create a promise that resolves when it's this caller's turn
	let release: () => void = () => {};
	const waitPromise = new Promise<void>((resolve) => {
		release = resolve;
	});
	
	queue.push(waitPromise);
	sessionMutexes.set(sessionId, queue);
	
	// Wait for all previous operations to complete
	if (queue.length > 1) {
		await queue[queue.length - 2];
	}
	
	// Return release function
	return () => {
		const currentQueue = sessionMutexes.get(sessionId) || [];
		if (currentQueue.length > 0) {
			currentQueue.shift();
			sessionMutexes.set(sessionId, currentQueue);
		}
		release();
	};
}

type ClaudeCodeUsage = {
	inputTokens?: number;
	input_tokens?: number;
	outputTokens?: number;
	output_tokens?: number;
	cacheReadInputTokens?: number;
	cache_read_input_tokens?: number;
	cacheCreationInputTokens?: number;
	cache_creation_input_tokens?: number;
	costUSD?: number;
	cost_usd?: number;
};

type ClaudeCodeJsonOutput = {
	result?: string;
	usage?: Record<string, ClaudeCodeUsage> | ClaudeCodeUsage;
	modelUsage?: Record<string, ClaudeCodeUsage> | ClaudeCodeUsage;
	total_cost_usd?: number;
};

/**
 * Extract the last user message from the conversation for Claude Code.
 * Claude Code maintains its own session history; we only send the latest message.
 */
function getLastUserMessage(messages: Context["messages"]): string {
	// Find the last user message
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "user") {
			return typeof msg.content === "string" ? msg.content : extractTextFromContent(msg.content);
		}
	}
	return "";
}

/**
 * Extract text from mixed content array (text, images, tool calls, thinking).
 */
function extractTextFromContent(
	content: string | (TextContent | ImageContent | ToolCall | ThinkingContent)[],
): string {
	if (typeof content === "string") {
		return content;
	}
	
	return content
		.map((item) => {
			if (typeof item === "string") {
				return item;
			}
			
			if ("type" in item) {
				switch (item.type) {
					case "text":
						return item.text;
					case "image":
						return "[Image]";
					case "thinking":
					case "redacted_thinking":
						return item.thinking || "";
					case "tool_use":
					case "tool_use_block":
						return `[Tool: ${(item as ToolCall & { name?: string; input?: unknown }).name || "unknown"}]`;
					default:
						return "";
				}
			}
			
			return "";
		})
		.join("");
}

/**
 * Custom API identifier for Claude Code provider.
 */
const CLAUDE_CODE_API: Api = "claude-code-cli";

/**
 * Select the appropriate usage object based on model ID.
 */
function selectModelUsage(
	usage: ClaudeCodeUsage | Record<string, ClaudeCodeUsage>,
	modelId: string,
): ClaudeCodeUsage {
	if (isClaudeCodeUsage(usage)) {
		return usage;
	}
	
	// Try exact model match, then fallback to first available
	const modelUsage = usage[modelId];
	if (modelUsage) {
		return modelUsage;
	}
	
	const firstKey = Object.keys(usage)[0];
	return firstKey ? usage[firstKey] : { inputTokens: 0, outputTokens: 0 };
}

/**
 * Type guard to check if value is a direct usage object (not a map).
 */
function isClaudeCodeUsage(value: ClaudeCodeUsage | Record<string, ClaudeCodeUsage>): value is ClaudeCodeUsage {
	return (
		typeof value === "object" &&
		value !== null &&
		("inputTokens" in value ||
			"input_tokens" in value ||
			"outputTokens" in value ||
			"output_tokens" in value)
	);
}

/**
 * Get a session identity string from the extension context.
 * Keys to Pi session file (preferred) or sessionId as fallback.
 * Never uses PID alone to avoid session boundary leaks.
 */
function getSessionIdentity(ctx: ExtensionContext): string {
	// Prefer session file path - this uniquely identifies a Pi session
	const sessionFile = ctx.sessionManager.getSessionFile();
	if (sessionFile) {
		return sessionFile;
	}
	
	// Fallback to sessionId if sessionFile unavailable
	return ctx.sessionManager.getSessionId() || `unknown-session-${process.pid}`;
}

/**
 * Stream output from Claude Code CLI.
 * Uses Pi session identity to derive session ID, avoiding cross-session leaks.
 * Serialises concurrent calls with the same session ID via mutex queue.
 */
function streamClaudeCode(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();

	(async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: CLAUDE_CODE_API,
			provider: "claude-code",
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};

		try {
			// Generate session UUID from Pi session identity (not PID)
			const sessionIdentity = getSessionIdentity(context);
			const sessionId = generateSessionUUID(sessionIdentity, process.cwd());

			// Acquire mutex to prevent concurrent session ID conflicts
			const releaseMutex = await acquireSessionMutex(sessionId);
			
			try {
				// Extract only the last user message - Claude Code maintains conversation history in session
				const prompt = getLastUserMessage(context.messages);

				// Build the claude command with JSON output for usage stats
				const args: string[] = [
					"-p",
					prompt,
					"--dangerously-skip-permissions",
					"--session-id",
					sessionId,
					"--output-format", "json",
				];

				// Add model if specified
				if (model.id) {
					args.push("--model", model.id);
				}

				// Add system prompt via --system-prompt flag
				if (context.systemPrompt && context.systemPrompt.trim()) {
					args.push("--system-prompt", context.systemPrompt);
				}

				// Execute claude CLI using spawn
				const result = await new Promise<{ stdout: string; stderr: string; code: number }>((resolve, reject) => {
					const proc = spawn("claude", args, {
						cwd: process.cwd(),
						env: process.env,
					});

					let stdout = "";
					let stderr = "";
					let timeout: NodeJS.Timeout | undefined;
					let settled = false;

					const cleanup = () => {
						if (timeout) clearTimeout(timeout);
						if (options?.signal) options.signal.removeEventListener("abort", onAbort);
					};
					const fail = (error: Error) => {
						if (settled) return;
						settled = true;
						cleanup();
						reject(error);
					};
					const succeed = (code: number | null) => {
						if (settled) return;
						settled = true;
						cleanup();
						resolve({ stdout, stderr, code: code ?? 0 });
					};
					function onAbort() {
						proc.kill("SIGTERM");
						fail(new Error("Request was aborted"));
					}

					proc.stdout?.on("data", (data) => {
						stdout += data.toString();
					});

					proc.stderr?.on("data", (data) => {
						stderr += data.toString();
					});

					proc.on("error", (err) => {
						fail(new Error(`Failed to start claude: ${err.message}`));
					});

					proc.on("close", succeed);

					// Handle abort signal
					if (options?.signal) {
						if (options.signal.aborted) {
							onAbort();
						} else {
							options.signal.addEventListener("abort", onAbort, { once: true });
						}
					}

					// Handle timeout
					if (options?.timeoutMs) {
						timeout = setTimeout(() => {
							proc.kill("SIGTERM");
							fail(new Error(`claude timed out after ${options.timeoutMs}ms`));
						}, options.timeoutMs);
					}
				});

				// Check for errors - nonzero exit with no stdout is an error
				if (result.code !== 0) {
					const errorMsg = result.stderr || `claude exited with code ${result.code}`;
					// Check if stdout contains JSON error output
					if (result.stdout) {
						try {
							const errorJson = JSON.parse(result.stdout);
							// Claude Code may output error details in JSON format
							throw new Error(`Claude Code error (exit ${result.code}): ${errorJson.error || errorMsg}`);
						} catch (parseErr) {
							// Not valid JSON, treat stderr as error message
							throw new Error(errorMsg);
						}
					} else {
						throw new Error(errorMsg);
					}
				}

				// Parse JSON output
				let jsonOutput: ClaudeCodeJsonOutput;
				try {
					jsonOutput = JSON.parse(result.stdout) as ClaudeCodeJsonOutput;
				} catch (e) {
					throw new Error(`Failed to parse Claude Code JSON output: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
				}

				// Check for error in JSON response
				if ("error" in jsonOutput && jsonOutput.error) {
					throw new Error(`Claude Code error: ${jsonOutput.error}`);
				}

				// Extract usage data from JSON response
				const usage = jsonOutput.usage || jsonOutput.modelUsage;
				if (usage) {
					// Handle both formats: claude-sonnet-5 nested or direct usage
					const modelUsage = selectModelUsage(usage, model.id);
					output.usage.input = modelUsage.inputTokens || modelUsage.input_tokens || 0;
					output.usage.output = modelUsage.outputTokens || modelUsage.output_tokens || 0;
					output.usage.cacheRead = modelUsage.cacheReadInputTokens || modelUsage.cache_read_input_tokens || 0;
					output.usage.cacheWrite = modelUsage.cacheCreationInputTokens || modelUsage.cache_creation_input_tokens || 0;
					output.usage.totalTokens = output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;

					// Calculate cost from USD
					const costUsd = modelUsage.costUSD || modelUsage.cost_usd || jsonOutput.total_cost_usd || 0;
					output.usage.cost.total = costUsd;
					// Rough breakdown (Claude doesn't separate input/output costs in the API)
					output.usage.cost.input = costUsd * 0.2;
					output.usage.cost.output = costUsd * 0.8;
				}

				// Extract the result text
				const text = jsonOutput.result || "";

				// Emit start event
				stream.push({ type: "start", partial: output });

				// Stream text content
				if (text) {
					output.content.push({ type: "text", text: "" });
					stream.push({ type: "text_start", contentIndex: 0, partial: output });

					// Claude Code JSON output arrives after the CLI exits; replay it in chunks so Pi renders normal text deltas.
					const chunks = text.split(/(\s+)/);
					for (const chunk of chunks) {
						if (chunk) {
							(output.content[0] as TextContent).text += chunk;
							stream.push({ type: "text_delta", contentIndex: 0, delta: chunk, partial: output });
						}
					}

					stream.push({ type: "text_end", contentIndex: 0, content: text, partial: output });
				}

				// Check for abort
				if (options?.signal?.aborted) {
					throw new Error("Request was aborted");
				}

				// Emit completion
				output.stopReason = "stop";
				stream.push({ type: "done", reason: output.stopReason, message: output });
				stream.end();
			} finally {
				// Always release mutex
				releaseMutex();
			}
		} catch (error) {
			for (const block of output.content) {
				if (typeof block === "object" && "index" in block) {
					delete (block as { index?: unknown }).index;
				}
			}
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
}

export default function (pi: ExtensionAPI) {
	pi.registerProvider("claude-code", {
		name: "Claude Code",
		api: CLAUDE_CODE_API,
		streamSimple: (model, context, options) => streamClaudeCode(model, context, options),
	});
}
