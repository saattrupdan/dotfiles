/**
 * Claude Code Provider
 *
 * Uses the Claude Code CLI (`claude` command) as a provider backend.
 * Executes `claude -p <prompt>` with appropriate flags for each turn.
 *
 * Features:
 * - Session ID persistence across Pi conversation turns
 * - System prompt injection via --system-prompt
 * - Model selection via --model
 * - --dangerously-skip-permissions enabled
 * - No Pi tool descriptions passed (Claude Code has its own tools)
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
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "child_process";

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
	usage?: ClaudeCodeUsage | Record<string, ClaudeCodeUsage>;
	modelUsage?: ClaudeCodeUsage | Record<string, ClaudeCodeUsage>;
	total_cost_usd?: number;
};

// =============================================================================
// Message Conversion
// =============================================================================

/**
 * Convert Pi messages to a prompt string for Claude Code.
 * Claude Code expects a conversational prompt format.
 */
function buildPrompt(messages: Context["messages"], systemPrompt?: string): string {
	const parts: string[] = [];

	// Add system prompt as context if provided (Claude Code will see it as context)
	if (systemPrompt && systemPrompt.trim()) {
		parts.push(`[System Context]\n${systemPrompt}\n`);
	}

	// Convert messages to conversational format
	for (const msg of messages) {
		if (msg.role === "user") {
			const content = typeof msg.content === "string" ? msg.content : extractTextFromContent(msg.content);
			parts.push(`User: ${content}`);
		} else if (msg.role === "assistant") {
			const content = extractTextFromContent(msg.content);
			if (content.trim()) {
				parts.push(`Assistant: ${content}`);
			}
		} else if (msg.role === "toolResult") {
			// Tool results are shown as context for Claude Code
			const content = extractTextFromContent(msg.content);
			parts.push(`[Tool Result] ${content}`);
		}
	}

	return parts.join("\n\n");
}

function extractTextFromContent(content: string | (TextContent | ImageContent | ToolCall | ThinkingContent)[]): string {
	if (typeof content === "string") {
		return content;
	}
	if (Array.isArray(content)) {
		return content
			.map((c) => {
				if (c.type === "text") {
					return (c as TextContent).text;
				} else if (c.type === "thinking") {
					return `[Thinking: ${(c as ThinkingContent).thinking}]`;
				} else if (c.type === "toolCall") {
					return `[Tool: ${(c as ToolCall).name}(${JSON.stringify((c as ToolCall).arguments)})]`;
				} else if (c.type === "image") {
					return "[Image]";
				}
				return "";
			})
			.join(" ");
	}
	return "";
}

// =============================================================================
// Custom API Definition
// =============================================================================

/**
 * Custom API identifier for Claude Code provider.
 * Note: Api type is just a string - see KnownApi | (string & {})
 */
const CLAUDE_CODE_API: Api = "claude-code-cli";

function selectModelUsage(
	usage: ClaudeCodeUsage | Record<string, ClaudeCodeUsage>,
	modelId: string,
): ClaudeCodeUsage {
	if (isClaudeCodeUsage(usage)) return usage;
	return usage[modelId] ?? Object.values(usage)[0] ?? {};
}

function isClaudeCodeUsage(value: ClaudeCodeUsage | Record<string, ClaudeCodeUsage>): value is ClaudeCodeUsage {
	return "inputTokens" in value
		|| "input_tokens" in value
		|| "outputTokens" in value
		|| "output_tokens" in value;
}

// =============================================================================
// Streaming Implementation
// =============================================================================

function streamClaudeCode(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	// Generate a unique session ID per-call to avoid "already in use" errors from Claude Code
	// Context continuity is maintained via the full conversation prompt we send
	const sessionId = crypto.randomUUID();

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
			// Build the prompt from conversation history
			const prompt = buildPrompt(context.messages, context.systemPrompt);

			// Build the claude command with JSON output for usage stats
			// claude -p <prompt> --system-prompt <system> --model <model> --dangerously-skip-permissions --session-id <id> --output-format json
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

			// Add system prompt if provided (using --system-prompt flag as requested)
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

			// Check for errors
			if (result.code !== 0 && !result.stdout) {
				throw new Error(result.stderr || `claude exited with code ${result.code}`);
			}

			// Parse JSON output
			let jsonOutput: ClaudeCodeJsonOutput;
			try {
				jsonOutput = JSON.parse(result.stdout) as ClaudeCodeJsonOutput;
			} catch (e) {
				throw new Error(`Failed to parse Claude Code JSON output: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
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
			stream.push({ type: "done", reason: output.stopReason as "stop" | "length" | "toolUse", message: output });
			stream.end();
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

// =============================================================================
// Extension Entry Point
// =============================================================================

export default function (pi: ExtensionAPI) {
	// Register the claude-code provider
	// Note: baseUrl/apiKey are required by the provider API even though we don't use HTTP
	// Claude Code CLI handles authentication separately via `claude login` or env vars
	pi.registerProvider("claude-code", {
		name: "Claude Code CLI",
		baseUrl: "cli://claude-code", // Dummy value - this provider uses subprocess, not HTTP
		apiKey: "claude-code-cli", // Placeholder - authentication handled by claude CLI
		api: CLAUDE_CODE_API,
		models: [
			{
				id: "claude-sonnet-5",
				name: "Claude Sonnet 5 (Claude Code)",
				api: CLAUDE_CODE_API,
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
				contextWindow: 1000000,
				maxTokens: 128000,
			},
			{
				id: "claude-opus-4-8",
				name: "Claude Opus 4.8 (Claude Code)",
				api: CLAUDE_CODE_API,
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
				contextWindow: 1000000,
				maxTokens: 128000,
			},
			{
				id: "claude-fable-5",
				name: "Claude Fable 5 (Claude Code)",
				api: CLAUDE_CODE_API,
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
				contextWindow: 1000000,
				maxTokens: 128000,
			},
			{
				id: "claude-haiku-4-5-20251001",
				name: "Claude Haiku 4.5 (Claude Code)",
				api: CLAUDE_CODE_API,
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
				contextWindow: 200000,
				maxTokens: 32000,
			},
		],
		streamSimple: streamClaudeCode,
	});
}
