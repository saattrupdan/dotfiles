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
 * - Session ID is keyed to the first user message timestamp/content plus cwd (used for mutex only).
 * - Per-session mutex queue serialises concurrent calls sharing the same session ID.
 * - **Only the latest user message is sent via `-p`** — Claude Code's native session
 *   management via `--resume` maintains conversation history.
 * - Session ID is used for mutex coordination; actual context comes from `context.messages`.
 *
 * Tool calling:
 * - Model outputs zero-shot tool calls: `TOOL_CALL_START{"name":...,"arguments":...}TOOL_CALL_END`
 * - Provider parses text for this pattern and emits Pi `toolcall_*` events
 * - Pi executes tools and returns results in `context.messages` on next turn
 * - Results are formatted as "Tool Result [name]: output" in conversation history
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

/**
 * Compaction state for a conversation session.
 * Tracks the summary and generation counter for conversation compaction.
 */
interface CompactionState {
	/** The compacted summary text */
	summary: string;
	/** Generation counter - increments on each compaction */
	generation: number;
	/** Session ID to use after this compaction (generation-based) */
	postCompactionSessionId?: string;
}
const TOOL_CALL_START_MARKER = "TOOL_CALL_START";
const TOOL_CALL_END_MARKER = "TOOL_CALL_END";

/** Parse text for tool call patterns and return segments (text/toolCall)
 * Does simple string matching instead of regex to avoid statefulness issues.
 */
/**
 * Compute the longest suffix of `pending` that is a proper prefix of `marker`.
 * This is the boundary-safe hold-back to avoid splitting a marker across chunks.
 * Returns the suffix to keep in pending (may be empty if no partial match).
 */
function computeBoundarySafeSuffix(pending: string, marker: string): string {
	// Find the longest proper prefix of marker that is a suffix of pending
	for (let len = Math.min(marker.length - 1, pending.length); len > 0; len--) {
		if (marker.startsWith(pending.slice(-len))) {
			return pending.slice(-len);
		}
	}
	return '';
}

/**
 * Try to parse tool call JSON from the text between markers.
 * Returns { name, arguments } on success, null on failure.
 */
function tryParseToolCall(jsonText: string): { name: string; arguments: Record<string, unknown> } | null {
	try {
		const toolData = JSON.parse(jsonText.trim()) as { name: string; arguments?: Record<string, unknown> };
		if (typeof toolData.name === 'string') {
			return { name: toolData.name, arguments: toolData.arguments || {} };
		}
	} catch {
		// Invalid JSON
	}
	return null;
}

type ProviderConfig = Parameters<ExtensionAPI["registerProvider"]>[1];

/**
 * Generate a deterministic UUID-shaped Claude Code session ID.
 *
 * Claude Code validates `--session-id` as a UUID. We use the first 16 bytes of a
 * SHA256 hash, then set RFC 4122 version/variant bits.
 */
function generateSessionUUID(conversationIdentity: string, cwd: string, generation: number = 0): string {
	// Include generation in the hash so compaction produces a new session ID
	const hash = createHash("sha256").update(`${conversationIdentity}:${cwd}:${generation}`).digest("hex");
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
	errors?: string[];
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
	type: "text" | "thinking" | "toolCall" | "tool_use";
	text?: string;
	toolCall?: ToolCall;
	partialJson?: string;
}

/** Streaming state for a text block that may contain zero-shot tool calls */
interface TextBlockStreamingState {
	mode: 'text' | 'collectingJson';
	pending: string; // Received-but-not-yet-classified text
	textBlockOpen: boolean; // Whether a Pi text block is currently open
	textBlockPiIndex?: number; // Pi index of the open text block
	// When in collectingJson mode:
	jsonAccumulator?: string; // Accumulated JSON string
	toolcallStartEmitted?: boolean; // Whether toolcall_start has been emitted
	toolCallPiIndex?: number; // Pi contentIndex of the tool call
	toolCall?: ToolCall; // The tool call object (after emission)
	emittedText?: boolean; // Track if visible text was emitted
	emittedAny?: boolean; // Track if anything was emitted
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
function buildConversationHistory(messages: Context["messages"], compactedSummary?: string): string {
	const lines: string[] = [];

	// Prepend compacted summary if available
	if (compactedSummary) {
		lines.push(`[Conversation Summary from Previous Turns]\n${compactedSummary}\n[End Summary]\n`);
	}

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
/**
 * Get the compacted summary for a conversation, if one exists.
 */
function getCompactedSummary(context: Context): string | null {
	const identity = getConversationIdentity(context);
	const state = compactionStates.get(identity);
	return state?.summary || null;
}

/**
 * Get the generation counter for a conversation session.
 * Returns 0 if no compaction has occurred.
 */
function getCompactionGeneration(context: Context): number {
	const identity = getConversationIdentity(context);
	const state = compactionStates.get(identity);
	return state?.generation || 0;
}

/**
 * Get the post-compaction session ID for a conversation session.
 * Returns undefined if no compaction has occurred.
 */
// getPostCompactionSessionId removed - compaction state managed internally

function buildSystemPromptWithTools(basePrompt: string | undefined, tools: Tool[] | undefined, _context?: Context): string {
	const parts: string[] = [];

	if (basePrompt && basePrompt.trim()) {
		parts.push(basePrompt);
		parts.push("");
	}

	// Tool calling format instruction
	parts.push("## Tool Calling Format");
	parts.push("To call a tool, output: TOOL_CALL_START{\"name\": \"toolName\", \"arguments\": {...}}TOOL_CALL_END");
	parts.push("");

	// List available tool names
	if (tools && tools.length > 0) {
		parts.push("## Available Tools");
		for (const tool of tools) {
			parts.push(`- ${tool.name}: ${tool.description || "No description"}`);
		}
	}

	return parts.join("\n");
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
	// Streaming state for text blocks - keyed by claude block index
	const textBlockStates: Map<number, TextBlockStreamingState> = new Map();
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
			stdio: ["ignore", "pipe", "pipe"],
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

			// Handle assistant records (emitted by Claude Code for slash commands)
			// These have type: "assistant" and contain message with content blocks
			// Reference: https://code.claude.com/docs/en/cli-reference#streaming-output-format
			const isAssistantRecord = (d: unknown): d is { message: { content: Array<{ type: string; text?: string }> } } => {
				if (d === null || typeof d !== "object") return false;
				const obj = d as Record<string, unknown>;
				if (obj.type !== "assistant") return false;
				if (!("message" in obj) || obj.message === null || typeof obj.message !== "object") return false;
				const msg = obj.message as Record<string, unknown>;
				if (!("content" in msg) || !Array.isArray(msg.content)) return false;
				return msg.content.every(
					(block) => block !== null && typeof block === "object" && "type" in block,
				);
			};

			if (isAssistantRecord(data)) {
				// Extract text from content blocks (skip tool_use blocks which are handled separately)
				const text = data.message.content
					.filter((block): block is { type: "text"; text: string } => block.type === "text" && typeof (block as { text?: unknown }).text === "string")
					.map((block) => block.text)
					.join("");
				if (!state.started) {
					state.started = true;
					state.emittedAny = true;
					stream.push({ type: "start", partial: output });
				}
				if (text.trim()) {
					const piIndex = output.content.length;
					output.content.push({ type: "text", text: text });
					stream.push({ type: "text_start", contentIndex: piIndex, partial: output });
					stream.push({ type: "text_delta", contentIndex: piIndex, delta: text, partial: output });
					stream.push({ type: "text_end", contentIndex: piIndex, content: text, partial: output });
					state.emittedText = true;
					state.emittedAny = true;
				}
				return;
			}

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
						// Don't emit text_start yet - wait until first visible character
						// Initialize streaming state for incremental tool-call detection
						textBlockStates.set(claudeIndex, {
							mode: 'text',
							pending: '',
							textBlockOpen: false,
							emittedText: false,
							emittedAny: false,
						});
						// Don't create a placeholder text block yet - lazily create on first visible char
						// But add a blockMapping so the delta handler can find this block
						blockMappings.set(claudeIndex, { claudeIndex, piIndex, type: "text", text: "" });
					} else if (blockType === "tool_use") {
						// Handle tool_use blocks directly from Claude Code streaming
						state.emittedAny = true;
						const toolCallBlock = event.content_block as { id?: string; name?: string };
						const toolCall: ToolCall = {
							type: "toolCall",
							id: toolCallBlock.id || uuidv4(),
							name: toolCallBlock.name || "unknown",
							arguments: {},
						};
						output.content.push(toolCall);
						blockMappings.set(claudeIndex, { claudeIndex, piIndex, type: "tool_use", toolCall, partialJson: "" });
						stream.push({ type: "toolcall_start", contentIndex: piIndex, partial: output });
					}
					return;
				}

				if (event.type === "content_block_delta") {
					const mapping = blockMappings.get(event.index);
					if (mapping && mapping.type === "text" && event.delta.type === "text_delta") {
						// Incremental streaming parser for zero-shot tool calls
						const streamingState = textBlockStates.get(event.index);
						if (!streamingState) return;

						// Append new text to pending
						streamingState.pending += event.delta.text;

						// Consume pending in a loop
						while (streamingState.pending.length > 0) {
							if (streamingState.mode === 'text') {
								const markerIndex = streamingState.pending.indexOf(TOOL_CALL_START_MARKER);
								if (markerIndex !== -1) {
									// Found start marker - emit text before it, then switch to collectingJson
									const textBefore = streamingState.pending.slice(0, markerIndex);
									if (textBefore.length > 0) {
										// Lazily open text block on first visible character
										if (!streamingState.textBlockOpen) {
											const textPiIndex = output.content.length;
											streamingState.textBlockPiIndex = textPiIndex;
											output.content.push({ type: "text", text: "" });
											streamingState.textBlockOpen = true;
											stream.push({ type: "text_start", contentIndex: textPiIndex, partial: output });
										}
										const textBlock = output.content[streamingState.textBlockPiIndex!] as TextContent;
										textBlock.text += textBefore;
										streamingState.emittedText = true;
										streamingState.emittedAny = true;
										state.emittedText = true;
										state.emittedAny = true;										stream.push({ type: "text_delta", contentIndex: streamingState.textBlockPiIndex!, delta: textBefore, partial: output });
									}
									// Close text block if open
									if (streamingState.textBlockOpen) {
										const textBlock = output.content[streamingState.textBlockPiIndex!] as TextContent;
										stream.push({ type: "text_end", contentIndex: streamingState.textBlockPiIndex!, content: textBlock.text, partial: output });
										streamingState.textBlockOpen = false;
										streamingState.textBlockPiIndex = undefined;
									}
									// Remove up to and including start marker, switch mode
									streamingState.pending = streamingState.pending.slice(markerIndex + TOOL_CALL_START_MARKER.length);
									streamingState.mode = 'collectingJson';
									streamingState.jsonAccumulator = '';
									streamingState.toolcallStartEmitted = false;
									streamingState.toolCallPiIndex = undefined;
									streamingState.toolCall = undefined;
									continue;
								} else {
									// No marker found - emit safe prefix, keep boundary-safe suffix
									const suffix = computeBoundarySafeSuffix(streamingState.pending, TOOL_CALL_START_MARKER);
									const safePrefix = streamingState.pending.slice(0, streamingState.pending.length - suffix.length);
									if (safePrefix.length > 0) {
										if (!streamingState.textBlockOpen) {
											const textPiIndex = output.content.length;
											streamingState.textBlockPiIndex = textPiIndex;
											output.content.push({ type: "text", text: "" });
											streamingState.textBlockOpen = true;
											stream.push({ type: "text_start", contentIndex: textPiIndex, partial: output });
										}
										const textBlock = output.content[streamingState.textBlockPiIndex!] as TextContent;
										textBlock.text += safePrefix;
										streamingState.emittedText = true;
										streamingState.emittedAny = true;
										state.emittedText = true;
										state.emittedAny = true;
										stream.push({ type: "text_delta", contentIndex: streamingState.textBlockPiIndex!, delta: safePrefix, partial: output });
									}
									streamingState.pending = suffix;
									break;
								}
							} else {
								// collectingJson mode
								const endIndex = streamingState.pending.indexOf(TOOL_CALL_END_MARKER);
								if (endIndex !== -1) {
									// Found end marker - combine accumulated JSON with final pending slice before parsing
									const jsonText = (streamingState.jsonAccumulator || '') + streamingState.pending.slice(0, endIndex);
									const parsedToolCall = tryParseToolCall(jsonText);

									if (parsedToolCall) {
										// Complete valid marker parsed - now emit the tool call atomically
										const toolPiIndex = output.content.length;
										streamingState.toolCallPiIndex = toolPiIndex;
										streamingState.toolCall = {
											type: "toolCall",
											id: uuidv4(),
											name: parsedToolCall.name,
											arguments: parsedToolCall.arguments ?? {},
										};
										output.content.push(streamingState.toolCall);
										// Emit toolcall_start, toolcall_delta (json), and toolcall_end in quick succession
										stream.push({ type: "toolcall_start", contentIndex: toolPiIndex, partial: output });
										if (jsonText.trim()) {
											stream.push({ type: "toolcall_delta", contentIndex: toolPiIndex, delta: jsonText, partial: output });
										}
										stream.push({ type: "toolcall_end", contentIndex: toolPiIndex, toolCall: streamingState.toolCall, partial: output });
										streamingState.toolcallStartEmitted = true;
										streamingState.emittedAny = true;
										state.emittedText = true; // Tool call content counts as emitted content
									} else {
										// Parse failed - emit as visible text (fallback)
										const fullSpan = TOOL_CALL_START_MARKER + jsonText + TOOL_CALL_END_MARKER;
										if (!streamingState.textBlockOpen) {
											const textPiIndex = output.content.length;
											streamingState.textBlockPiIndex = textPiIndex;
											output.content.push({ type: "text", text: "" });
											streamingState.textBlockOpen = true;
											stream.push({ type: "text_start", contentIndex: textPiIndex, partial: output });
										}
										const textBlock = output.content[streamingState.textBlockPiIndex!] as TextContent;
										textBlock.text += fullSpan;
										streamingState.emittedText = true;
										streamingState.emittedAny = true;
										state.emittedText = true;
										state.emittedAny = true;
										stream.push({ type: "text_delta", contentIndex: streamingState.textBlockPiIndex!, delta: fullSpan, partial: output });
									}

									// Remove up to and including end marker, switch back to text
									streamingState.pending = streamingState.pending.slice(endIndex + TOOL_CALL_END_MARKER.length);
									streamingState.mode = 'text';
									continue;							} else {
								// No end marker yet - accumulate JSON safely, DO NOT emit anything yet
								const suffix = computeBoundarySafeSuffix(streamingState.pending, TOOL_CALL_END_MARKER);
								const safePrefix = streamingState.pending.slice(0, streamingState.pending.length - suffix.length);

								if (safePrefix.length > 0) {								// Accumulate JSON - defer toolcall_start until complete marker is parsed
								streamingState.jsonAccumulator = (streamingState.jsonAccumulator || '') + safePrefix;
								}

								streamingState.pending = suffix;
								break;
							}
							}
						}
					} else if (mapping && mapping.type === "tool_use") {
						// Handle streaming tool use arguments (partial JSON) - native path unchanged
						// Note: Claude Code may send tool_use_delta events; check for partial_json to handle them
						const delta = event.delta as { partial_json?: string };
						if (delta.partial_json) {
							const toolCall = output.content[mapping.piIndex] as ToolCall;
							// Accumulate partial JSON string
							const accumulatedJson = (mapping.partialJson || "") + delta.partial_json;
							mapping.partialJson = accumulatedJson;
							
							// Try to parse and update arguments
							try {
								toolCall.arguments = JSON.parse(accumulatedJson);
							} catch {
								// Keep last valid arguments or empty object
							}
							stream.push({ type: "toolcall_delta", contentIndex: mapping.piIndex, delta: delta.partial_json, partial: output });
						}
					}
					return;
				}

				if (event.type === "content_block_stop") {
					const mapping = blockMappings.get(event.index);
					if (mapping && mapping.type === "text") {
						// Flush remaining streaming state for this text block
						const streamingState = textBlockStates.get(event.index);
						if (streamingState) {
							if (streamingState.mode === 'text') {
								// Flush any remaining pending as visible text
								if (streamingState.pending.length > 0) {
									if (!streamingState.textBlockOpen) {
										const textPiIndex = output.content.length;
										streamingState.textBlockPiIndex = textPiIndex;
										output.content.push({ type: "text", text: "" });
										streamingState.textBlockOpen = true;
										stream.push({ type: "text_start", contentIndex: textPiIndex, partial: output });
									}
									const textBlock = output.content[streamingState.textBlockPiIndex!] as TextContent;
									textBlock.text += streamingState.pending;
									streamingState.emittedText = true;
									streamingState.emittedAny = true;
									state.emittedText = true;
									state.emittedAny = true;
									stream.push({ type: "text_delta", contentIndex: streamingState.textBlockPiIndex!, delta: streamingState.pending, partial: output });
								}
								// Close text block if open
								if (streamingState.textBlockOpen) {
									const textBlock = output.content[streamingState.textBlockPiIndex!] as TextContent;
									stream.push({ type: "text_end", contentIndex: streamingState.textBlockPiIndex!, content: textBlock.text, partial: output });
								}
							} else {
								// collectingJson mode with no end marker (truncated/aborted)
								// Truncated tool calls should NOT become executable - fall back to text
								// toolcall_start was never emitted (we defer until complete marker), so no orphan possible
								const bufferedJson = streamingState.jsonAccumulator || '';
								if (bufferedJson.length > 0 || streamingState.pending.length > 0) {
									// Combine jsonAccumulator + pending for the fallback text
									const fullSpan = TOOL_CALL_START_MARKER + bufferedJson + streamingState.pending;
									if (!streamingState.textBlockOpen) {
										const textPiIndex = output.content.length;
										streamingState.textBlockPiIndex = textPiIndex;
										output.content.push({ type: "text", text: "" });
										streamingState.textBlockOpen = true;
										stream.push({ type: "text_start", contentIndex: textPiIndex, partial: output });
									}
									const textBlock = output.content[streamingState.textBlockPiIndex!] as TextContent;
									textBlock.text += fullSpan;
									streamingState.emittedText = true;
									streamingState.emittedAny = true;
									state.emittedText = true;
									state.emittedAny = true;
									stream.push({ type: "text_delta", contentIndex: streamingState.textBlockPiIndex!, delta: fullSpan, partial: output });
									if (streamingState.textBlockOpen) {
										stream.push({ type: "text_end", contentIndex: streamingState.textBlockPiIndex!, content: textBlock.text, partial: output });
									}
								}
							}
							textBlockStates.delete(event.index);
						} else {
							// Fallback for legacy state (shouldn't happen, but handle gracefully)
							if (mapping.text && mapping.text.trim()) {
								stream.push({ type: "text_end", contentIndex: mapping.piIndex, content: mapping.text, partial: output });
							}
						}
						blockMappings.delete(event.index);
					} else if (mapping && mapping.type === "tool_use") {
						// Finalize tool_use block from direct streaming
						const toolCall = output.content[mapping.piIndex] as ToolCall;
						stream.push({ type: "toolcall_end", contentIndex: mapping.piIndex, toolCall, partial: output });
						blockMappings.delete(event.index);
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

				if (data.is_error || data.error || (Array.isArray(data.errors) && data.errors.length > 0)) {
					const errorDetails = [data.error, ...(data.errors ?? []), data.is_error ? data.result : undefined]
						.filter((error): error is string => typeof error === "string" && error.length > 0)
						.join("\n");
					invocationError = new Error(`Claude Code error: ${errorDetails || "Unknown error"}`);
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
				// Capture error but don't reject - caller needs state to decide retry.
				// Claude Code can emit structured result errors on stdout while stderr is empty.
				const stderrText = stderr.trim();
				if (invocationError) {
					if (stderrText) {
						invocationError = new Error(`${invocationError.message}\n${stderrText}`);
					}
				} else {
					invocationError = new Error(`Claude Code error (exit ${code}): ${stderrText || `exit code ${code}`}`);
				}
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
			// Determine what to send to Claude Code:
			// - If the tail of messages contains toolResult messages, send those (response to a tool call)
			// - Otherwise, send the latest user message
			let inputText: string;
			const lastMessage = context.messages[context.messages.length - 1];

			if (lastMessage && lastMessage.role === "toolResult") {
				// Collect consecutive toolResult messages from the end
				const toolResults: string[] = [];
				for (let i = context.messages.length - 1; i >= 0; i--) {
					const msg = context.messages[i];
					if (msg.role !== "toolResult") break;
					const text = Array.isArray(msg.content)
						? msg.content.filter((c) => c.type === "text").map((c) => c.text).join(" ")
						: "";
					toolResults.unshift(`Tool Result [${msg.toolName}]: ${text || "(no output)"}`);
				}
				inputText = toolResults.join("\n\n");
			} else {
				// Send the latest user message
				const latestUserMessage = context.messages.filter((m) => m.role === "user").pop();
				inputText =
					latestUserMessage && typeof latestUserMessage.content === "string"
						? latestUserMessage.content
						: latestUserMessage && Array.isArray(latestUserMessage.content)
							? latestUserMessage.content.filter((c) => c.type === "text").map((c) => c.text).join(" ")
							: "";
			}

			// Handle /compact specially - summarize the conversation instead of forwarding to Claude
			if (inputText === "/compact") {
				const summary = await compactConversation(context, model);
				if (summary) {
					// Compaction already stored state in compactionStates
					stream.push({ type: "start", partial: output });
					const piIndex = output.content.length;
					output.content.push({ type: "text", text: summary });
					stream.push({ type: "text_start", contentIndex: piIndex, partial: output });
					stream.push({ type: "text_delta", contentIndex: piIndex, delta: summary, partial: output });
					stream.push({ type: "text_end", contentIndex: piIndex, content: summary, partial: output });
					stream.push({ type: "done", reason: "stop", message: output });
					stream.end();
					return;
				}
				// If compaction failed, fall through to notify user
				stream.push({ type: "start", partial: output });
				const piIndex = output.content.length;
				const errorMsg = "Compaction failed or timed out. Try again with a shorter conversation.";
				output.content.push({ type: "text", text: errorMsg });
				stream.push({ type: "text_start", contentIndex: piIndex, partial: output });
				stream.push({ type: "text_delta", contentIndex: piIndex, delta: errorMsg, partial: output });
				stream.push({ type: "text_end", contentIndex: piIndex, content: errorMsg, partial: output });
				stream.push({ type: "done", reason: "stop", message: output });
				stream.end();
				return;
			}

			// If the message is a slash command (starts with / followed by a word character), forward it to Claude Code CLI
			// Avoid matching absolute paths like /tmp/foo or /Users/... by requiring the command to be followed by whitespace, colon, or end
			if (/^\/[A-Za-z][\w:-]*(?:\s|$)/.test(inputText)) {
				const conversationIdentity = getConversationIdentity(context);
				// Use generation-based session ID if compaction has occurred
				const generation = getCompactionGeneration(context);
				const sessionId = generateSessionUUID(conversationIdentity, process.cwd(), generation);
				const releaseMutex = await acquireSessionMutex(sessionId);

				try {
					// Build CLI arguments for slash command - just pass the command as-is
					const slashCommandArgs: string[] = [
						"-p",
						inputText,
						"--dangerously-skip-permissions",
						"--output-format",
						"stream-json",
						"--verbose",
						"--include-partial-messages",
						"--tools",
						"",
					];

					if (model.id) {
						slashCommandArgs.push("--model", model.id);
					}

					// Use the same retry logic as normal messages (--resume first, then --session-id)
					let lastAttemptResult: ClaudeInvocationResult | null = null;
					const firstAttemptResult = await runClaudeInvocation(
						slashCommandArgs,
						{ kind: "resume", sessionId },
						stream,
						output,
						options,
					);

					if (!firstAttemptResult.success && firstAttemptResult.error) {
						const errorMsg = firstAttemptResult.error.message;
						const isNoConversation = errorMsg.includes("No conversation found");
						const isAlreadyInUse = errorMsg.includes("already in use");

						if ((isNoConversation || isAlreadyInUse) && !firstAttemptResult.emittedAny) {
							lastAttemptResult = await runClaudeInvocation(
								slashCommandArgs,
								{ kind: "session-id", sessionId },
								stream,
								output,
								options,
							);
							if (!lastAttemptResult.success && lastAttemptResult.error) {
								throw lastAttemptResult.error;
							}
						} else {
							throw firstAttemptResult.error;
						}
					} else {
						lastAttemptResult = firstAttemptResult;
					}

					// Fallback: if no text was streamed but result has text, emit it (same as normal path)
					if (lastAttemptResult && !lastAttemptResult.emittedText && lastAttemptResult.resultEvent?.result) {
						if (!lastAttemptResult.emittedAny) {
							stream.push({ type: "start", partial: output });
						}
						const text = lastAttemptResult.resultEvent.result;
						const piIndex = output.content.length;
						output.content.push({ type: "text", text: text });
						stream.push({ type: "text_start", contentIndex: piIndex, partial: output });
						stream.push({ type: "text_delta", contentIndex: piIndex, delta: text, partial: output });
						stream.push({ type: "text_end", contentIndex: piIndex, content: text, partial: output });
						lastAttemptResult.emittedText = true;
					}

					// Emit completion unconditionally (matches normal path)
					stream.push({ type: "done", reason: output.stopReason as "stop" | "length" | "toolUse", message: output });
					stream.end();
				} finally {
					releaseMutex();
				}
				return;
			}

			const conversationIdentity = getConversationIdentity(context);
			// Use generation-based session ID if compaction has occurred
			const generation = getCompactionGeneration(context);
			const sessionId = generateSessionUUID(conversationIdentity, process.cwd(), generation);

			// Acquire mutex to prevent concurrent session ID conflicts
			const releaseMutex = await acquireSessionMutex(sessionId);

			try {
				// Build base CLI arguments (session flag added per-attempt)
				// Send only the latest message via -p; Claude Code maintains session history natively via --resume
				const baseArgs: string[] = [
					"-p",
					inputText,
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
				const systemPrompt = buildSystemPromptWithTools(context.systemPrompt, context.tools, context);
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

/**
 * In-memory storage for compaction state per session.
 * Key: session identity, Value: compaction state with summary and generation.
 */
const compactionStates = new Map<string, CompactionState>();

/**
 * Compact the conversation by asking Claude to summarize it.
 * Called when user types /compact with Claude Code model active.
 */
async function compactConversation(context: Context, model: Model<Api>): Promise<string | null> {
	const conversationIdentity = getConversationIdentity(context);
	// Include previous compaction summary in the history if available
	const previousSummary = getCompactedSummary(context) || undefined;
	const conversationHistory = buildConversationHistory(context.messages, previousSummary);

	if (!conversationHistory.trim()) {
		return null;
	}

	const prompt = `Please summarize the following conversation into a concise "activation prompt" that captures the key context, decisions, code changes, and any important details. The summary should be brief but preserve essential information so the conversation can continue effectively. Format as a single paragraph or bullet points.

Conversation:
${conversationHistory}

Summary:`;

	const args = [
		"-p",
		prompt,
		"--dangerously-skip-permissions",
		"--output-format", "stream-json",
		"--verbose",
		"--include-partial-messages",
		"--tools", "",
	];

	if (model.id) args.push("--model", model.id);

	return new Promise((resolve) => {
		const proc = spawn("claude", args, {
			cwd: process.cwd(),
			env: process.env,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let summary = "";
		let timedOut = false;

		proc.stdout.on("data", (data: Buffer) => {
			const lines = data.toString().split("\n");
			for (const line of lines) {
				if (!line.trim()) continue;
				try {
					const parsed = JSON.parse(line);
					if (parsed.type === "content_block_delta" && parsed.delta?.text) {
						summary += parsed.delta.text;
					}
					// Also handle assistant records
					if (parsed.type === "assistant" && parsed.message?.content) {
						summary += parsed.message.content
							.filter((b: any) => b.type === "text")
							.map((b: any) => b.text)
							.join("");
					}
				} catch {
					// Ignore parse errors
				}
			}
		});

		const timeout = setTimeout(() => {
			timedOut = true;
			proc.kill();
			resolve(null);
		}, 30000);

		proc.on("close", (code) => {
			clearTimeout(timeout);
			if (timedOut) {
				resolve(null);
			} else if (code === 0 && summary.trim()) {
				// Store compaction state with incremented generation
				const existingState = compactionStates.get(conversationIdentity);
				const newGeneration = (existingState?.generation || 0) + 1;
				const cwd = process.cwd();
				// Generate new session ID for post-compaction turns
				const postCompactionSessionId = generateSessionUUID(conversationIdentity, cwd, newGeneration);
				compactionStates.set(conversationIdentity, {
					summary: summary.trim(),
					generation: newGeneration,
					postCompactionSessionId,
				});
				resolve(summary.trim());
			} else {
				resolve(null);
			}
		});
	});
}

export default function (pi: ExtensionAPI) {
	// Handle /compact command for Claude Code models
	pi.on("input", async (event, ctx) => {
		if (ctx.model?.provider !== "claude-code" && ctx.model?.api !== CLAUDE_CODE_API) {
			return { action: "continue" };
		}

		const text = event.text?.trim();
		if (text === "/compact") {
			if (!ctx.hasUI) return { action: "continue" };

			// Compaction is handled in streamClaudeCode - just continue to let the model process it
			// The stream handler will detect /compact and trigger compaction
			ctx.ui.notify?.("/compact will summarize the conversation context for efficient future turns.", "info");
			return { action: "continue" };
		}

		return { action: "continue" };
	});

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
