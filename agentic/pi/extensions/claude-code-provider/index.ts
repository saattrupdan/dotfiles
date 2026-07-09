/**
 * Claude Code Provider
 *
 * Uses the Claude Code CLI (`claude` command) as a provider backend.
 * Executes `claude -p <prompt>` with appropriate flags for each turn.
 *
 * Features:
 * - Uses Claude Code's native session mechanism for conversation continuity
 * - System prompt passed via --system-prompt only (not duplicated in prompt)
 * - Session ID keyed to the Pi conversation's first user message and cwd
 * - Per-session mutex queue prevents concurrent session ID conflicts
 * - Model selection via --model
 * - --dangerously-skip-permissions enabled
 * - --tools "" to disable Claude Code's built-in tools
 * - Pi's tools passed via system prompt augmentation
 * - Realtime streaming via --output-format stream-json
 * - First attempt uses `--resume` (continues existing sessions); on "No conversation
 *   found" error, retries with `--session-id` (creates new sessions)
 * - Retry logic keeps per-session mutex held across both attempts
 *
 * Session strategy:
 * - Provider streams receive pi-ai Context, not ExtensionContext, so no Pi session
 *   manager is available here.
 * - Session ID is keyed to the first user message timestamp/content plus cwd.
 * - Per-session mutex queue serialises concurrent calls sharing the same session ID.
 * - Claude Code maintains conversation history in its session storage.
 * - Only the latest user message is sent per turn (not full Pi conversation history).
 * - First attempt uses `--resume` (continues existing sessions); on "No conversation
 *   found" error, retries with `--session-id` (creates new sessions).
 *
 * Continuity limits:
 * - Only turns handled by this provider for the same Pi conversation are retained.
 * - Provider switches only preserve context after Claude Code has seen an earlier turn
 *   for the same conversation-derived session ID.
 * - `pi --continue` can reuse Claude Code context when Pi preserves the original
 *   first user message timestamp/content.
 * - `/new` or session changes get fresh Claude Code sessions because the first user
 *   message changes.
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
	Tool,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "child_process";
import { createHash } from "crypto";
import { v4 as uuidv4 } from "uuid";

/** Regex for zero-shot tool call pattern: TOOL_CALL_START{...}TOOL_CALL_END */
const TOOL_CALL_START_MARKER = "TOOL_CALL_START";
const TOOL_CALL_END_MARKER = "TOOL_CALL_END";

/** Parse text for tool call patterns and return segments (text/toolCall)
 * Does simple string matching instead of regex to avoid statefulness issues.
 */
function parseTextWithToolCalls(text: string): Array<{ type: "text"; content: string } | { type: "toolCall"; toolCall: ToolCall }> {
	const segments: Array<{ type: "text"; content: string } | { type: "toolCall"; toolCall: ToolCall }> = [];
	let remainingText = text;

	while (true) {
		const startIndex = remainingText.indexOf(TOOL_CALL_START_MARKER);
		if (startIndex === -1) {
			// No more tool calls, add remaining text
			if (remainingText.trim()) {
				segments.push({ type: "text", content: remainingText });
			}
			break;
		}

		// Add text before the tool call
		const textBefore = remainingText.slice(0, startIndex);
		if (textBefore.trim()) {
			segments.push({ type: "text", content: textBefore });
		}

		// Find the end marker
		const afterStartMarker = remainingText.slice(startIndex + TOOL_CALL_START_MARKER.length);
		const endIndex = afterStartMarker.indexOf(TOOL_CALL_END_MARKER);

		if (endIndex === -1) {
			// No end marker found, treat rest as text
			segments.push({ type: "text", content: remainingText });
			break;
		}

		// Extract JSON between markers
		const jsonText = afterStartMarker.slice(0, endIndex).trim();
		
		try {
			const toolData = JSON.parse(jsonText) as { name: string; arguments: Record<string, unknown> };
			segments.push({
				type: "toolCall",
				toolCall: {
					type: "toolCall",
					id: uuidv4(),
					name: toolData.name,
					arguments: toolData.arguments || {},
				},
			});
		} catch {
			// Invalid JSON, treat the whole thing as text
			segments.push({ type: "text", content: remainingText.slice(startIndex, startIndex + TOOL_CALL_START_MARKER.length + endIndex + TOOL_CALL_END_MARKER.length) });
		}

		// Move past this tool call
		remainingText = afterStartMarker.slice(endIndex + TOOL_CALL_END_MARKER.length);
	}

	return segments;
}

type ProviderConfig = Parameters<ExtensionAPI["registerProvider"]>[1];

/**
 * Generate a deterministic UUID-shaped Claude Code session ID.
 *
 * Claude Code validates `--session-id` as a UUID. We use the first 16 bytes of a
 * SHA256 hash, then set RFC 4122 version/variant bits.
 */
function generateSessionUUID(conversationIdentity: string, cwd: string): string {
	const hash = createHash("sha256").update(`${conversationIdentity}:${cwd}`).digest("hex");
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

/** Claude Code stream-json event types */
interface ClaudeCodeStreamEvent {
	type: "stream_event";
	event: ClaudeCodeEvent;
}

interface ClaudeCodeResultEvent {
	type: "result";
	result?: string;
	stop_reason?: string;
	usage?: Record<string, ClaudeCodeUsage> | ClaudeCodeUsage;
	modelUsage?: Record<string, ClaudeCodeUsage> | ClaudeCodeUsage;
	total_cost_usd?: number;
	is_error?: boolean;
	error?: string;
}

interface ClaudeCodeContentBlockStartEvent {
	type: "content_block_start";
	index: number;
	content_block: { type: "text" } | { type: "thinking" } | { type: "tool_use" };
}

interface ClaudeCodeTextDeltaEvent {
	type: "content_block_delta";
	index: number;
	delta: { type: "text_delta"; text: string };
}

interface ClaudeCodeContentBlockStopEvent {
	type: "content_block_stop";
	index: number;
}

type ClaudeCodeEvent = ClaudeCodeContentBlockStartEvent | ClaudeCodeTextDeltaEvent | ClaudeCodeContentBlockStopEvent;

/** Type guard for stream_event wrapper */
function isStreamEvent(data: unknown): data is ClaudeCodeStreamEvent {
	return (
		typeof data === "object" &&
		data !== null &&
		"type" in data &&
		data.type === "stream_event" &&
		"event" in data
	);
}

/** Type guard for result event */
function isResultEvent(data: unknown): data is ClaudeCodeResultEvent {
	return typeof data === "object" && data !== null && "type" in data && data.type === "result";
}

/** Mapping from Claude content block index to Pi content index */
interface ContentBlockMapping {
	claudeIndex: number;
	piIndex: number;
	type: "text" | "thinking" | "toolCall";
	text: string;
}

/** Parse a single JSONL line, returning null for incomplete/invalid lines */
function parseJsonlLine(line: string): unknown | null {
	const trimmed = line.trim();
	if (!trimmed) return null;
	try {
		return JSON.parse(trimmed) as unknown;
	} catch {
		return null;
	}
}

/**
 * Extract the last user message from the conversation for Claude Code.
 * Claude Code maintains its own session history; we only send the latest message.
 */
/**
 * Build full conversation history including tool results.
 * Formats messages for Claude Code to understand Pi tool calls and results.
 */
function buildConversationHistory(messages: Context["messages"]): string {
	const lines: string[] = [];

	for (const msg of messages) {
		if (msg.role === "user") {
			const text = typeof msg.content === "string" ? msg.content : extractTextFromContent(msg.content);
			lines.push(`User: ${text}`);
		} else if (msg.role === "assistant") {
			// Check if this message contains tool calls
			const textContent = Array.isArray(msg.content)
				? msg.content
					.filter((c) => c.type === "text")
					.map((c) => c.text)
					.join(" ")
				: "";

			const toolCalls = Array.isArray(msg.content)
				? msg.content.filter((c) => c.type === "toolCall")
				: [];

			if (toolCalls.length > 0) {
				for (const toolCall of toolCalls) {
					if (toolCall.type === "toolCall") {
						lines.push(`Assistant: [Calling tool: ${toolCall.name}]`);
						lines.push(`TOOL_CALL_START${JSON.stringify({ name: toolCall.name, arguments: toolCall.arguments })}TOOL_CALL_END`);
					}
				}
			}

			if (textContent.trim()) {
				lines.push(`Assistant: ${textContent}`);
			}
		} else if (msg.role === "toolResult") {
			const text = Array.isArray(msg.content)
				? msg.content.filter((c) => c.type === "text").map((c) => c.text).join(" ")
				: "";
			lines.push(`Tool Result [${msg.toolName}]: ${text || "(no output)"}`);
		}
	}

	return lines.join("\n\n");
}

/**
 * Build system prompt with Pi's tool definitions appended.
 * Claude Code's --tools "" disables its built-in tools, so we need to describe Pi's tools
 * in the system prompt for the model to know what tools it can call.
 */
function buildSystemPromptWithTools(basePrompt: string | undefined, tools: Tool[] | undefined): string {
	const sections: string[] = [];

	// Base system prompt (Pi's SYSTEM.md content)
	if (basePrompt && basePrompt.trim()) {
		sections.push(basePrompt);
	}

	// Pi's tool definitions
	if (tools && tools.length > 0) {
		const toolDefinitions = tools.map((tool) => {
			const params = tool.parameters ? JSON.stringify(tool.parameters, null, 2) : "{}";
			return `- **${tool.name}**: ${tool.description}\n  Parameters: ${params}`;
		}).join("\n");

		sections.push(`## Available Tools\n\nYou have access to the following Pi tools. To call a tool, output this exact format (all on one line, no code blocks):\n\nTOOL_CALL_START{"name": "toolName", "arguments": {"arg1": "value1"}}TOOL_CALL_END\n\nExample: TOOL_CALL_START{"name": "read", "arguments": {"path": "file.txt"}}TOOL_CALL_END\n\nAfter calling a tool, wait for the result before continuing.\n\n## Tool Definitions\n${toolDefinitions}`);
	}

	return sections.join("\n\n---\n\n");
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
						return item.thinking || "";
					case "toolCall":
						return `[Tool: ${item.name || "unknown"}]`;
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
 * Uses the first user message as a stable conversation boundary without sending
 * full history to Claude Code on every turn.
 */
function getConversationIdentity(context: Context): string {
	const firstUser = context.messages.find((msg) => msg.role === "user");
	if (!firstUser) {
		return `empty:${process.pid}:${Date.now()}`;
	}

	const content = typeof firstUser.content === "string"
		? firstUser.content
		: extractTextFromContent(firstUser.content);
	const contentHash = createHash("sha256")
		.update(content)
		.update(context.systemPrompt || "")
		.digest("hex")
		.slice(0, 16);

	return `first-user:${firstUser.timestamp}:${contentHash}`;
}

/**
 * Stream output from Claude Code CLI.
 * Uses Pi session identity to derive session ID, avoiding cross-session leaks.
 * Serialises concurrent calls with the same session ID via mutex queue.
 */
/**
 * Result of a single Claude Code invocation attempt.
 */
interface ClaudeInvocationResult {
	/** True if the invocation completed without spawn/abort errors (may still have Claude error). */
	success: boolean;
	/** The result event data if available. */
	resultEvent: ClaudeCodeResultEvent | null;
	/** Standard error output. */
	stderr: string;
	/** Whether any actual text deltas were emitted (not just block start). */
	emittedText: boolean;
	/** Whether ANY Pi events (start, text_start/delta/end) were emitted. */
	emittedAny: boolean;
	/** Error from Claude (nonzero exit, is_error result) if present. */
	error?: Error;
}

/**
 * Run a single Claude Code invocation with the given session mode.
 * Streams output to the provided stream and returns result/error info.
 *
 * @param baseArgs - Base CLI arguments (without --session-id or --resume)
 * @param sessionMode - Session mode: "session-id" or "resume"
 * @param sessionId - The session UUID to use
 * @param stream - The Pi event stream to push deltas to
 * @param output - The output message being built
 * @param options - Optional timeout/abort signal
 * @returns Result indicating success/failure, whether anything was emitted
 */
async function runClaudeInvocation(
	baseArgs: string[],
	sessionMode: { kind: "session-id" | "resume"; sessionId: string },
	stream: ReturnType<typeof createAssistantMessageEventStream>,
	output: AssistantMessage,
	options?: SimpleStreamOptions,
): Promise<ClaudeInvocationResult> {
	const invocationArgs = [
		...baseArgs,
		sessionMode.kind === "session-id" ? "--session-id" : "--resume",
		sessionMode.sessionId,
	];

	const blockMappings: Map<number, ContentBlockMapping> = new Map();
	// Buffer for detecting tool calls in text - keyed by claude block index
	const textBuffers: Map<number, string> = new Map();
	const state = {
		emittedText: false, // Track if any actual text deltas were emitted
		resultEvent: null as ClaudeCodeResultEvent | null,
		started: false,
		emittedAny: false, // Track if ANY Pi events or visible text were emitted
	};
	let stderr = "";
	let invocationError: Error | undefined;

	await new Promise<void>((resolve, reject) => {
		const proc = spawn("claude", invocationArgs, {
			cwd: process.cwd(),
			env: process.env,
		});

		let stdoutBuffer = "";
		let timeout: NodeJS.Timeout | undefined;
		let settled = false;
		let abortPending = false;

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
		const succeed = () => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve();
		};
		function onAbort() {
			if (settled) return;
			abortPending = true;
			proc.kill("SIGTERM");
		}

		const processLine = (line: string) => {
			const data = parseJsonlLine(line);
			if (data === null) return;

			if (isStreamEvent(data)) {
				const event = data.event;
				if (!state.started) {
					state.started = true;
					state.emittedAny = true;
					stream.push({ type: "start", partial: output });
				}

				if (event.type === "content_block_start") {
					const claudeIndex = event.index;
					const blockType = event.content_block.type;
					const piIndex = output.content.length;
					if (blockType === "text") {
						state.emittedAny = true;
						output.content.push({ type: "text", text: "" });
						blockMappings.set(claudeIndex, { claudeIndex, piIndex, type: "text", text: "" });
						textBuffers.set(claudeIndex, "");
						stream.push({ type: "text_start", contentIndex: piIndex, partial: output });
					}
					return;
				}

				if (event.type === "content_block_delta") {
					const mapping = blockMappings.get(event.index);
					if (mapping && mapping.type === "text" && event.delta.type === "text_delta") {
						// Accumulate text in buffer
						const currentBuffer = textBuffers.get(event.index) || "";
						const newText = currentBuffer + event.delta.text;
						textBuffers.set(event.index, newText);

						const textBlock = output.content[mapping.piIndex] as TextContent;
						textBlock.text += event.delta.text;
						mapping.text += event.delta.text;
						state.emittedAny = true;
						if (event.delta.text.length > 0) {
							state.emittedText = true;
						}
						stream.push({ type: "text_delta", contentIndex: mapping.piIndex, delta: event.delta.text, partial: output });
					}
					return;
				}

				if (event.type === "content_block_stop") {
					const mapping = blockMappings.get(event.index);
					if (mapping && mapping.type === "text") {
						// Check for tool call patterns in the accumulated text
						const finalText = textBuffers.get(event.index) || mapping.text;
						const segments = parseTextWithToolCalls(finalText);

						if (segments.length === 1 && segments[0].type === "text") {
							// No tool calls detected - emit as normal text
							stream.push({ type: "text_end", contentIndex: mapping.piIndex, content: mapping.text, partial: output });
						} else {
							// Tool calls detected - emit structured events
							// Clear the text block we started and replace with proper content
							output.content.splice(mapping.piIndex, 1); // Remove the placeholder text block

							let currentPiIndex = mapping.piIndex;
							for (const segment of segments) {
								if (segment.type === "text") {
									if (segment.content.trim()) {
										output.content.splice(currentPiIndex, 0, { type: "text", text: segment.content });
										stream.push({ type: "text_start", contentIndex: currentPiIndex, partial: output });
										stream.push({ type: "text_delta", contentIndex: currentPiIndex, delta: segment.content, partial: output });
										stream.push({ type: "text_end", contentIndex: currentPiIndex, content: segment.content, partial: output });
										currentPiIndex++;
									}
								} else if (segment.type === "toolCall") {
									output.content.splice(currentPiIndex, 0, segment.toolCall);
									stream.push({ type: "toolcall_start", contentIndex: currentPiIndex, partial: output });
									stream.push({ type: "toolcall_delta", contentIndex: currentPiIndex, delta: JSON.stringify(segment.toolCall.arguments), partial: output });
									stream.push({ type: "toolcall_end", contentIndex: currentPiIndex, toolCall: segment.toolCall, partial: output });
									currentPiIndex++;
								}
							}

							state.emittedText = true; // Mark that we emitted content
						}

						blockMappings.delete(event.index);
						textBuffers.delete(event.index);
					}
					return;
				}
			}

			if (isResultEvent(data)) {
				state.resultEvent = data;

				const usage = data.usage || data.modelUsage;
				if (usage) {
					const modelUsage = selectModelUsage(usage, output.model);
					output.usage.input = modelUsage.inputTokens || modelUsage.input_tokens || 0;
					output.usage.output = modelUsage.outputTokens || modelUsage.output_tokens || 0;
					output.usage.cacheRead = modelUsage.cacheReadInputTokens || modelUsage.cache_read_input_tokens || 0;
					output.usage.cacheWrite = modelUsage.cacheCreationInputTokens || modelUsage.cache_creation_input_tokens || 0;
					output.usage.totalTokens = output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;

					const costUsd = modelUsage.costUSD || modelUsage.cost_usd || data.total_cost_usd || 0;
					output.usage.cost.total = costUsd;
					output.usage.cost.input = costUsd * 0.2;
					output.usage.cost.output = costUsd * 0.8;
				}

				if (data.stop_reason) {
					output.stopReason = data.stop_reason === "end_turn" ? "stop" : data.stop_reason === "max_tokens" ? "length" : "stop";
				}

				if (data.is_error || data.error) {
					invocationError = new Error(`Claude Code error: ${data.error || "Unknown error"}`);
					// Don't reject here - caller needs to inspect emittedAny/emittedText state
				}
			}
		};

		proc.stdout?.on("data", (data) => {
			stdoutBuffer += data.toString();

			let newlineIndex: number;
			while ((newlineIndex = stdoutBuffer.indexOf("\n")) !== -1) {
				const line = stdoutBuffer.slice(0, newlineIndex);
				stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
				processLine(line);
			}
		});

		proc.stderr?.on("data", (data) => {
			stderr += data.toString();
		});

		proc.on("error", (err) => {
			fail(new Error(`Failed to start claude: ${err.message}`));
		});

		proc.on("close", (code) => {
			if (stdoutBuffer.trim()) {
				processLine(stdoutBuffer);
			}

			if (abortPending && !settled) {
				settled = true;
				cleanup();
				const msg = options?.signal?.aborted
					? "Request was aborted"
					: `claude timed out after ${options?.timeoutMs}ms`;
				reject(new Error(msg));
				return;
			}

			if (code !== 0 && !settled) {
				// Capture error but don't reject - caller needs state to decide retry
				invocationError = new Error(`Claude Code error (exit ${code}): ${stderr || `exit code ${code}`}`);
			}

			succeed();
		});

		if (options?.signal) {
			if (options.signal.aborted) {
				onAbort();
			} else {
				options.signal.addEventListener("abort", onAbort, { once: true });
			}
		}

		if (options?.timeoutMs) {
			timeout = setTimeout(() => {
				if (settled) return;
				abortPending = true;
				proc.kill("SIGTERM");
			}, options.timeoutMs);
		}
	});

	return {
		success: !invocationError,
		resultEvent: state.resultEvent,
		stderr,
		emittedText: state.emittedText,
		emittedAny: state.emittedAny,
		error: invocationError,
	};
}

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
			const conversationIdentity = getConversationIdentity(context);
			const sessionId = generateSessionUUID(conversationIdentity, process.cwd());

			// Acquire mutex to prevent concurrent session ID conflicts
			const releaseMutex = await acquireSessionMutex(sessionId);

			try {
				// Build full conversation history including tool results
				// This is required because Pi tool call results aren't visible to Claude Code's session
				const conversationHistory = buildConversationHistory(context.messages);

				// Build base CLI arguments (session flag added per-attempt)
				const baseArgs: string[] = [
					"-p",
					conversationHistory,
					"--dangerously-skip-permissions",
					"--output-format",
					"stream-json",
					"--verbose",
					"--include-partial-messages",
					// Disable Claude Code's built-in tools so only Pi's tools are visible to the model
					"--tools", "",
				];

				if (model.id) {
					baseArgs.push("--model", model.id);
				}

				// Build system prompt: base prompt + Pi's tool definitions
				const systemPrompt = buildSystemPromptWithTools(context.systemPrompt, context.tools);
				if (systemPrompt && systemPrompt.trim()) {
					baseArgs.push("--system-prompt", systemPrompt);
				}

				// Attempt 1: try --resume (continues existing sessions)
				// Attempt 2: if "No conversation found" OR "already in use" AND nothing was emitted, retry with --session-id
				let lastAttemptResult: ClaudeInvocationResult | null = null;
				const firstAttemptResult = await runClaudeInvocation(baseArgs, { kind: "resume", sessionId }, stream, output, options);

				// Check if we should retry with --session-id
				if (!firstAttemptResult.success && firstAttemptResult.error) {
					const errorMsg = firstAttemptResult.error.message;
					const isNoConversation = errorMsg.includes("No conversation found");
					const isAlreadyInUse = errorMsg.includes("already in use");

					if (isNoConversation || isAlreadyInUse) {
						// --resume failed because session doesn't exist (or is locked).
						// Only retry with --session-id if the first attempt emitted NO Pi events.
						// If anything was emitted (start, partial text), retrying would duplicate output.
						if (!firstAttemptResult.emittedAny) {
							lastAttemptResult = await runClaudeInvocation(baseArgs, { kind: "session-id", sessionId }, stream, output, options);
						} else {
							// Something was already emitted; surface the original error instead of risking duplication
							throw firstAttemptResult.error;
						}
					} else {
						// Not a retryable error; surface it
						throw firstAttemptResult.error;
					}
				} else {
					lastAttemptResult = firstAttemptResult;
				}

				// If the retry (or first attempt) failed, surface the error before fallback/done
				if (lastAttemptResult && !lastAttemptResult.success) {
					throw lastAttemptResult.error ?? new Error("Claude Code invocation failed");
				}

				// Check for abort
				if (options?.signal?.aborted) {
					throw new Error("Request was aborted");
				}

				// Fallback: if no actual text was streamed but result has text, emit it
				// This handles cases where Claude returns a result without streaming deltas,
				// or when a text block started but emitted no deltas (empty block).
				if (lastAttemptResult && !lastAttemptResult.emittedText && lastAttemptResult.resultEvent?.result) {
					// Ensure start is emitted exactly once
					if (!lastAttemptResult.emittedAny) {
						stream.push({ type: "start", partial: output });
					}
					const text = lastAttemptResult.resultEvent.result;
					const piIndex = output.content.length; // Index of the block we're about to push
					output.content.push({ type: "text", text: text });
					stream.push({ type: "text_start", contentIndex: piIndex, partial: output });
					stream.push({ type: "text_delta", contentIndex: piIndex, delta: text, partial: output });
					stream.push({ type: "text_end", contentIndex: piIndex, content: text, partial: output });
					lastAttemptResult.emittedText = true; // Mark that text was now emitted
				}

				// Emit completion
				stream.push({ type: "done", reason: output.stopReason as "stop" | "length" | "toolUse", message: output });
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
		name: "Claude Code CLI",
		baseUrl: "cli://claude-code",
		apiKey: "claude-code-cli",
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
		streamSimple: streamClaudeCode as unknown as ProviderConfig["streamSimple"],
	});
}
