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
import type { SessionMessageEntry } from "@earendil-works/pi-coding-agent";
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
	/** Whether the summary has been injected into the first post-compaction turn */
	injected?: boolean;
}
const TOOL_CALL_START_MARKER = "TOOL_CALL_START";
const TOOL_CALL_END_MARKER = "TOOL_CALL_END";

/** Debug mode environment variable name */
const CLAUDE_CODE_DEBUG_ENV = "CLAUDE_CODE_DEBUG";
/** Whether debug logging is enabled */
const CLAUDE_CODE_DEBUG_ENABLED = process.env[CLAUDE_CODE_DEBUG_ENV] === "1";
/** Error message for stale tool results */
const STALE_TOOL_RESULT_ERROR = "[Error: Tool result is stale - invocation sequence mismatch]";

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
	/** Tool call ID for tracking */
	toolCallId?: string;
	/** Tool call sequence number */
	toolCallSequence?: number;
	/** Source of the tool call */
	source?: ToolCallSource;
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
	/** Tool call ID for tracking */
	toolCallId?: string;
	/** Tool call sequence number */
	toolCallSequence?: number;
}

/** Source of a tool call: 'claude' for zero-shot, 'pi' for Pi-initiated */
type ToolCallSource = 'claude' | 'pi';

/** Replay state for tracking tool calls with sequence numbers */
interface ToolCallReplayState {
	/** Tool call ID (Pi-generated) */
	toolCallId: string;
	/** Tool call sequence number (Pi side) */
	toolCallSequence: number;
	/** Tool name */
	name: string;
	/** Source of the tool call */
	source: ToolCallSource;
	/** Arguments passed to the tool */
	arguments: Record<string, unknown>;
	/** Whether the tool call was emitted to Pi */
	emitted: boolean;
	/** Invocation sequence when the tool call was made */
	invocationSequence: number;
}

/** Tool call with replay metadata attached */
interface ToolCallWithReplayMetadata extends ToolCall {
	/** Sequence number for replay tracking */
	toolCallSequence: number;
	/** Source of the tool call */
	source: ToolCallSource;
	/** Invocation sequence when the tool call was made */
	invocationSequence: number;
}

/** Replay state for tracking tool results */
interface ToolResultReplayState {
	/** Tool call ID this result corresponds to */
	toolCallId: string;
	/** Expected sequence number for this result */
	expectedSequence: number;
	/** Invocation sequence when the result was received */
	invocationSequence: number;
	/** Result text content */
	result: string;
	/** Whether the result has been validated */
	validated: boolean;
}

/** Result of validating a tool result against replay state */
interface ToolResultValidationResult {
	/** Whether the result is valid (not stale) */
	isValid: boolean;
	/** Whether the result matches an expected tool call */
	isMatched: boolean;
	/** Error message if validation failed */
	error?: string;
	/** The validated result text (may be error message if stale) */
	validatedResult: string;
}

/**
 * Log debug message if debug mode is enabled.
 * @param message - Message to log
 * @param data - Optional data to include
 */
function logClaudeCodeProvider(message: string, data?: unknown): void {
	if (CLAUDE_CODE_DEBUG_ENABLED) {
		const timestamp = new Date().toISOString();
		// eslint-disable-next-line no-console
		console.log(`[${timestamp}] [claude-code-provider] ${message}`, data ?? '');
	}
}

/**
 * Register a tool call in the replay state.
 * @param invocationSequence - The invocation sequence number
 * @param toolCallId - The tool call ID
 * @param toolCallSequence - The tool call sequence number
 * @param name - Tool name
 * @param source - Source of the tool call
 * @param args - Tool arguments
 * @param emitted - Whether the tool call was emitted
 */
function registerToolCall(
	invocationSequence: number,
	toolCallId: string,
	toolCallSequence: number,
	name: string,
	source: ToolCallSource,
	args: Record<string, unknown>,
	emitted: boolean,
): void {
	if (!toolCallReplayStates.has(invocationSequence)) {
		toolCallReplayStates.set(invocationSequence, new Map());
	}
	const replayMap = toolCallReplayStates.get(invocationSequence)!;
	replayMap.set(toolCallId, {
		toolCallId,
		toolCallSequence,
		name,
		source,
		arguments: args,
		emitted,
		invocationSequence,
	});
}

/**
 * Get tool call ID from a Pi message.
 * @param message - Pi message object
 * @returns Tool call ID if present
 */
function getMessageToolCallId(message: Context["messages"][0]): string | null {
	if ('toolCallId' in message && typeof message.toolCallId === 'string') {
		return message.toolCallId;
	}
	return null;
}

/**
 * Get the replay sequence number for a tool call.
 * @param invocationSequence - The invocation sequence
 * @param toolCallId - The tool call ID
 * @returns Tool call sequence number if found
 */
function getToolCallReplaySequence(invocationSequence: number, toolCallId: string): number | null {
	const replayMap = toolCallReplayStates.get(invocationSequence);
	if (!replayMap) return null;
	const state = replayMap.get(toolCallId);
	return state?.toolCallSequence ?? null;
}

/**
 * Extract text content from a tool result message.
 * @param message - Tool result message
 * @returns Extracted text
 */
function extractToolResultText(message: Context["messages"][0]): string {
	if (typeof message.content === 'string') {
		return message.content;
	}
	if (Array.isArray(message.content)) {
		return message.content
			.filter((block): block is TextContent => block.type === 'text')
			.map(block => block.text)
			.join('\n');
	}
	return '';
}

/**
 * Collect tool results from the tail of messages.
 * @param messages - Context messages array
 * @param invocationSequence - Expected invocation sequence
 * @returns Array of tool result replay states
 */
function collectTailToolResults(
	messages: Context["messages"],
	invocationSequence: number,
): ToolResultReplayState[] {
	const results: ToolResultReplayState[] = [];
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== 'tool') break;
		const toolCallId = getMessageToolCallId(msg);
		if (!toolCallId) continue;
		const expectedSequence = getToolCallReplaySequence(invocationSequence, toolCallId);
		if (expectedSequence === null) continue;
		results.push({
			toolCallId,
			expectedSequence,
			invocationSequence,
			result: extractToolResultText(msg),
			validated: false,
		});
	}
	return results.reverse();
}

/**
 * Validate a tool result against replay state.
 * @param result - Tool result replay state
 * @param invocationSequence - Current invocation sequence
 * @returns Validation result
 */
function validateTailToolResults(
	result: ToolResultReplayState,
	invocationSequence: number,
): ToolResultValidationResult {
	if (result.invocationSequence !== invocationSequence) {
		return {
			isValid: false,
			isMatched: false,
			error: 'Invocation sequence mismatch',
			validatedResult: STALE_TOOL_RESULT_ERROR,
		};
	}
	return {
		isValid: true,
		isMatched: true,
		validatedResult: result.result,
	};
}

/**
 * Find expected tool calls before tail marker.
 * @param invocationSequence - Invocation sequence to check
 * @returns Array of expected tool call IDs
 */
function findExpectedToolCallsBeforeTail(invocationSequence: number): string[] {
	const replayMap = toolCallReplayStates.get(invocationSequence);
	if (!replayMap) return [];
	return Array.from(replayMap.values())
		.filter(state => state.emitted)
		.map(state => state.toolCallId);
}

/**
 * Format tool result for Claude with replay metadata.
 * @param toolName - Name of the tool
 * @param result - Result text
 * @param sequence - Tool call sequence number
 * @returns Formatted result string
 */
function formatToolResultForClaude(toolName: string, result: string, sequence: number): string {
	return `Tool Result [${toolName} #${sequence}]: ${result}`;
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
 * @deprecated Use buildFilteredConversationHistory for compaction - kept for normal message flow.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
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
							const toolCallWithMeta = toolCall as ToolCallWithReplayMetadata;
							const seqInfo = toolCallWithMeta.toolCallSequence !== undefined ? ` #${toolCallWithMeta.toolCallSequence}` : '';
							lines.push(`Assistant: [Calling tool: ${toolCall.name}${seqInfo} toolCallId=${toolCall.id}]`);
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
 * Build filtered conversation history for compaction.
 *
 * Strategy:
 * 1. First user message: Always include the initial goal
 * 2. Key assistant messages: Include reasoning/planning, skip verbose tool calls
 * 3. Tool results: Keep first line only (success/failure), skip full outputs
 * 4. Recent messages: Always include last 50 messages regardless of type
 * 5. Truncate to ~50k chars: If still too long, prioritize recent + first, drop middle
 */
function buildFilteredConversationHistory(messages: Context["messages"], compactedSummary?: string): string {
	const MAX_CHARS = 50000;
	const RECENT_COUNT = 50;

	const lines: string[] = [];

	// Prepend compacted summary if available
	if (compactedSummary) {
		lines.push(`[Conversation Summary from Previous Turns]\n${compactedSummary}\n[End Summary]\n`);
	}

	// First pass: mark which messages to include
	const includeFlags: boolean[] = new Array(messages.length).fill(false);

	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];

		// First message always included
		if (i === 0) {
			includeFlags[i] = true;
			continue;
		}

		// Last 50 messages always included
		if (i >= messages.length - RECENT_COUNT) {
			includeFlags[i] = true;
			continue;
		}

		// Key assistant messages (reasoning/planning) - skip pure tool calls
		if (msg.role === "assistant") {
			const textContent = Array.isArray(msg.content)
				? msg.content
					.filter((c) => c.type === "text")
					.map((c) => c.text)
					.join(" ")
				: "";

			// Include if has meaningful text content (reasoning/planning)
			if (textContent.trim().length > 0) {
				includeFlags[i] = true;
			}
		}

		// User messages in the middle - include for context
		if (msg.role === "user") {
			includeFlags[i] = true;
		}
	}

	// Second pass: build history with truncation
	const includedMessages: Context["messages"][0][] = [];

	for (let i = 0; i < messages.length; i++) {
		if (!includeFlags[i]) continue;
		includedMessages.push(messages[i]);
	}

	// Third pass: if >50k chars, drop older marked messages until under limit
	let historyText = buildHistoryFromMessages(includedMessages);

	if (historyText.length > MAX_CHARS) {
		// Drop middle messages progressively, keeping first and last 50
		while (historyText.length > MAX_CHARS && includedMessages.length > RECENT_COUNT + 1) {
			// Find a middle message to drop (not first, not in last 50)
			const dropIndex = Math.floor(includedMessages.length / 2);
			if (dropIndex <= 0 || dropIndex >= includedMessages.length - RECENT_COUNT) {
				// Can't drop more without losing first or recent
				break;
			}
			includedMessages.splice(dropIndex, 1);
			historyText = buildHistoryFromMessages(includedMessages);
		}
	}

	return historyText;
}

/**
 * Helper to build history text from a list of messages.
 * Tool results are truncated to first line / 200 chars.
 */	function buildHistoryFromMessages(messages: Context["messages"][0][]): string {
		const TOOL_RESULT_TRUNCATE = 200;
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
							const toolCallWithMeta = toolCall as ToolCallWithReplayMetadata;
							const seqInfo = toolCallWithMeta.toolCallSequence !== undefined ? ` #${toolCallWithMeta.toolCallSequence}` : '';
							lines.push(`Assistant: [Calling tool: ${toolCall.name}${seqInfo} toolCallId=${toolCall.id}]`);
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
				// Truncate tool results to first line / 200 chars
				const truncated = text.length > TOOL_RESULT_TRUNCATE ? text.substring(0, TOOL_RESULT_TRUNCATE) + "..." : text;
				const firstLine = truncated.split("\n")[0] || "(no output)";
				lines.push(`Tool Result [${msg.toolName}]: ${firstLine || "(no output)"}`);
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
	parts.push("**Note:** The provider assigns toolCallId automatically. Do not invent or include toolCallId in your output.");
	parts.push("");

	// List available tools with parameter schemas
	if (tools && tools.length > 0) {
		parts.push("## Available Tools");
		for (const tool of tools) {
			parts.push(`- **${tool.name}**: ${tool.description || "No description"}`);
			if (tool.parameters && Object.keys(tool.parameters).length > 0) {
				parts.push(`  Parameters: ${JSON.stringify(tool.parameters, null, 2)}`);
			}
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
	/** Whether a zero-shot tool call was successfully parsed and emitted. */
	toolCallEmitted: boolean;
	/** Error from Claude (nonzero exit, is_error result) if present. */
	error?: Error;
	/** Invocation sequence number for this turn */
	invocationSequence: number;
	/** Tool call IDs emitted during this invocation */
	emittedToolCallIds: string[];
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
	const invocationSequence = nextInvocationSequence++;
	const emittedToolCallIds: string[] = [];

	logClaudeCodeProvider(`invocation_start seq=${invocationSequence}`);

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
		toolCallEmitted: false, // Track if a zero-shot tool call was successfully parsed
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

			// Claude Code emits top-level assistant snapshots alongside partial stream_event
			// deltas. The snapshots contain the same text as the deltas, so rendering both
			// duplicates every assistant response. Ignore snapshots and rely on deltas,
			// with the final result fallback below covering non-streaming responses.
			if (data !== null && typeof data === "object" && (data as Record<string, unknown>).type === "assistant") {
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
						blockMappings.set(claudeIndex, { claudeIndex, piIndex, type: "text", text: "" });				} else if (blockType === "tool_use") {
					// Handle tool_use blocks directly from Claude Code streaming
					state.emittedAny = true;
					state.toolCallEmitted = true;
					output.stopReason = "toolUse";
					const toolCallBlock = event.content_block as { id?: string; name?: string };
					const toolCallId = toolCallBlock.id || uuidv4();
					const toolCallSequence = nextToolCallSequence++;
					emittedToolCallIds.push(toolCallId);
					const toolCall: ToolCallWithReplayMetadata = {
						type: "toolCall",
						id: toolCallId,
						name: toolCallBlock.name || "unknown",
						arguments: {},
						toolCallSequence,
						source: 'pi',
						invocationSequence,
					};
					registerToolCall(invocationSequence, toolCallId, toolCallSequence, toolCall.name, 'pi', toolCall.arguments, true);
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

						// After a tool call has been emitted, suppress any further visible text deltas
						// to prevent fabricated "Result of calling tool..." text from being appended
						if (state.toolCallEmitted) {
							return;
						}

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
									// Handle doubled START markers - skip duplicate to prevent it being accumulated as JSON
									if (streamingState.pending.startsWith(TOOL_CALL_START_MARKER)) {
										streamingState.pending = streamingState.pending.slice(TOOL_CALL_START_MARKER.length);
									}
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
									const parsedToolCall = tryParseToolCall(jsonText);								if (parsedToolCall) {
									// Complete valid marker parsed - now emit the tool call atomically
									const toolPiIndex = output.content.length;
									const toolCallId = uuidv4();
									const toolCallSequence = nextToolCallSequence++;
									emittedToolCallIds.push(toolCallId);
									streamingState.toolCallPiIndex = toolPiIndex;
									streamingState.toolCall = {
										type: "toolCall",
										id: toolCallId,
										name: parsedToolCall.name,
										arguments: parsedToolCall.arguments ?? {},
										toolCallSequence,
										source: 'claude',
										invocationSequence,
									};
									registerToolCall(invocationSequence, toolCallId, toolCallSequence, parsedToolCall.name, 'claude', parsedToolCall.arguments ?? {}, true);
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
									state.toolCallEmitted = true;
									// Set stopReason to toolUse - a tool call was detected
									output.stopReason = "toolUse";
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
								// Suppress flush if tool call already emitted - prevents mixed content
								if (state.toolCallEmitted) return;
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
								// Suppress flush if tool call already emitted - prevents mixed content
								if (state.toolCallEmitted) return;
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
					// Don't overwrite toolUse with stop - if a tool call was emitted, keep toolUse
					if (state.toolCallEmitted) {
						output.stopReason = "toolUse";
					} else {
						output.stopReason = data.stop_reason === "end_turn" ? "stop" : data.stop_reason === "max_tokens" ? "length" : "stop";
					}
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
		toolCallEmitted: state.toolCallEmitted,
		error: invocationError,
		invocationSequence,
		emittedToolCallIds,
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
			const isToolResult = lastMessage && lastMessage.role === "toolResult";

			if (isToolResult) {
				// Collect and validate tool results from the tail of messages
				// Use previous invocation sequence (decremented) since this is responding to prior turn's tool calls
				const previousInvocationSequence = nextInvocationSequence - 1;
				const tailResults = collectTailToolResults(context.messages, previousInvocationSequence);
				
				// Validate each tool result
				const validatedToolResults: string[] = [];
				for (const result of tailResults) {
					const validation = validateTailToolResults(result, previousInvocationSequence);
					if (!validation.isValid) {
						// Reject stale tool results
						throw new Error(STALE_TOOL_RESULT_ERROR);
					}
					// Look up tool name from replay state
					const replayMap = toolCallReplayStates.get(previousInvocationSequence);
					const toolName = replayMap?.get(result.toolCallId)?.name || 'unknown';
					// Format valid result with sequence number
					const formattedResult = formatToolResultForClaude(toolName, result.result, result.expectedSequence);
					validatedToolResults.push(formattedResult);
				}
				inputText = validatedToolResults.join("\n\n");
			} else {
				// Send the latest user message
				const latestUserMessage = context.messages.filter((m) => m.role === "user").pop();			inputText =
				latestUserMessage && typeof latestUserMessage.content === "string"
					? latestUserMessage.content
					: latestUserMessage && Array.isArray(latestUserMessage.content)
						? latestUserMessage.content.filter((c) => c.type === "text").map((c) => c.text).join(" ")
						: "";
			}

			// Inject compaction summary into the first user turn after compaction
			const compactionState = compactionStates.get(getConversationIdentity(context));
			if (compactionState?.summary && !compactionState.injected && !isToolResult) {
				inputText = `${compactionState.summary}\n\n${inputText}`;
				compactionState.injected = true;
				compactionStates.set(getConversationIdentity(context), compactionState);
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
					// DO NOT emit fallback text if a tool call was emitted - that would append
					// fabricated tool-result text after the tool call.
					if (lastAttemptResult && !lastAttemptResult.emittedText && lastAttemptResult.resultEvent?.result && !lastAttemptResult.toolCallEmitted) {
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

			// Use generation-based session ID if compaction has occurred
			const conversationIdentity = getConversationIdentity(context);
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
				}			// Fallback: if no actual text was streamed but result has text, emit it
			// This handles cases where Claude returns a result without streaming deltas,
			// or when a text block started but emitted no deltas (empty block).
			// DO NOT emit fallback text if a tool call was emitted - that would append
			// fabricated tool-result text after the tool call.
			if (lastAttemptResult && !lastAttemptResult.emittedText && lastAttemptResult.resultEvent?.result && !lastAttemptResult.toolCallEmitted) {
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

/** Next invocation sequence number (incremented per turn) */
let nextInvocationSequence = 0;
/** Next tool call sequence number (incremented per tool call) */
let nextToolCallSequence = 0;
/** Replay states for active invocations, keyed by invocation sequence */
const toolCallReplayStates = new Map<number, Map<string, ToolCallReplayState>>();
/** Active Pi session ID for tracking replay context */
let activePiSessionId: string | null = null;

/**
 * Compact the conversation by asking Claude to summarize it.
 * Called when user types /compact with Claude Code model active.
 */


/**
 * Get conversation identity from messages array (for use in input handler where we don't have Context).
 */
function getConversationIdentityFromMessages(messages: Context["messages"], systemPrompt?: string): string {
	const firstUser = messages.find((msg) => msg.role === "user");
	if (!firstUser) {
		return `empty:${process.pid}:${Date.now()}`;
	}

	const content = typeof firstUser.content === "string"
		? firstUser.content
		: extractTextFromContent(firstUser.content);
	const contentHash = createHash("sha256")
		.update(content)
		.update(systemPrompt || "")
		.digest("hex")
		.slice(0, 16);

	return `first-user:${firstUser.timestamp}:${contentHash}`;
}

/**
 * Compact conversation using pre-built history. Called from input handler.
 * Stores compaction state and returns the summary.
 */
async function compactConversationWithHistory(
	conversationHistory: string,
	conversationIdentity: string,
	model: Model<Api>,
): Promise<string | null> {
	if (!conversationHistory.trim()) {
		return null;
	}

	const prompt = `Please summarize the following conversation into a concise "activation prompt" that captures the key context, decisions, code changes, and any important details. The summary should be brief but preserve essential information so the conversation can continue effectively. Format as a single paragraph or bullet points.

Conversation:
${conversationHistory}

Summary:`;


	const args = [
		"-p",
		"--dangerously-skip-permissions",
		"--output-format", "stream-json",
		"--verbose",
		"--include-partial-messages",
		"--tools", "",
	];

	if (model.id) args.push("--model", model.id);

	return new Promise((resolve, reject) => {
		const proc = spawn("claude", args, {
			cwd: process.cwd(),
			env: process.env,
			stdio: ["pipe", "pipe", "pipe"],
		});

		// Write prompt to stdin to avoid E2BIG (Argument list too long) errors
		proc.stdin.write(prompt);
		proc.stdin.end();

		// Handle stdin errors gracefully
		proc.stdin.on("error", () => {
			// Silently ignore stdin errors - process will fail and be handled below
		});

		let summary = "";
		let stderr = "";
		let timedOut = false;

		proc.stderr.on("data", (data: Buffer) => {
			stderr += data.toString();
		});

		proc.stdout.on("data", (data: Buffer) => {
			const lines = data.toString().split("\n");
			for (const line of lines) {
				if (!line.trim()) continue;			try {
				const parsed = JSON.parse(line);
				// Check for rate limit events
					if (parsed.type === "rate_limit_event" && parsed.rate_limit_info?.status === "rejected") {
						const info = parsed.rate_limit_info;
						const resetsAt = info.resetsAt ? new Date(info.resetsAt * 1000).toLocaleTimeString() : 'unknown';
						const reason = info.overageDisabledReason || info.rateLimitType || 'rate limit exceeded';
						reject(new Error(`Claude API rate limited (${reason}). Resets at ${resetsAt}`));
						return;
					}
					// Handle result event (fallback when no assistant content streamed)
					if (parsed.type === "result" && parsed.result) {
						summary = parsed.result;
					}
					// Handle assistant records
					if (parsed.type === "assistant" && parsed.message?.content) {
						const content = parsed.message.content as Array<{ type: string; text?: string }> | undefined;
						if (Array.isArray(content)) {
							summary += content
								.filter((b): b is { type: "text"; text: string } => b.type === "text" && typeof b.text === "string")
								.map((b) => b.text)
								.join("");
						}
					}
				} catch {
					// Ignore parse errors
				}
			}
		});

		const timeout = setTimeout(() => {
			timedOut = true;
			proc.kill();
			reject(new Error(`Claude Code compaction timed out after 30s: ${stderr.trim() || "no stderr output"}`));
		}, 30000);

		proc.on("close", (code) => {
			clearTimeout(timeout);

			if (timedOut) {
				// Already rejected in timeout handler
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
				const errorMsg = stderr.trim() || "no stderr output";
				reject(new Error(`Claude exited with code ${code}: ${errorMsg}`));
			}
		});
	});
}

export default function (pi: ExtensionAPI) {
	// Register /cc-compact as a proper command so it shows in autocomplete dropdown
	pi.registerCommand("cc-compact", {
		description: "Compact Claude Code conversation context",
		async handler(_args, ctx) {
			try {
				// Get conversation messages from session branch
				const entries = ctx.sessionManager.getBranch();
				
				// Check for empty session first
				if (entries.length === 0) {
					ctx.ui.notify("No session entries found - this may be a fresh conversation", "error");
					return;
				}
			const messages = entries
				.filter((e): e is SessionMessageEntry => e.type === "message")
				.map((e) => e.message) as Context["messages"];

				// Check if we have messages but no actual message content
				if (messages.length === 0) {
					ctx.ui.notify(`Found ${entries.length} entries but 0 messages. Entries: ${entries.map(e => e.type).join(",")}`, "error");
					return;
				}

				// Get system prompt from context
				const systemPrompt = ctx.getSystemPrompt();
				const convIdentity = getConversationIdentityFromMessages(messages, systemPrompt);			const previousSummary = compactionStates.get(convIdentity)?.summary || undefined;

			// Build filtered conversation history for compaction
			const conversationHistory = buildFilteredConversationHistory(messages, previousSummary);

				if (!conversationHistory.trim()) {
					ctx.ui.notify("No conversation to compact", "info");
					return;
				}			// Get current model from context
		const model = ctx.model;
			if (!model) {
				ctx.ui.notify("No model selected - are you using a Claude Code model?", "error");
				return;
			}

			// Warn if conversation is very large
			if (conversationHistory.length > 100000) {
				ctx.ui.notify(
					`Large conversation (${(conversationHistory.length / 1000).toFixed(0)}k chars) - compacting last 100k chars`,
					"warning",
				);
			}

				// Show progress in footer during compaction (no model streaming, so force visible)
				pi.events.emit("thinking-status:override", { label: "Claude Code compacting" });
				try {
				// Compact the conversation
				await compactConversationWithHistory(conversationHistory, convIdentity, model);

				// Compaction succeeded - state is stored in compactConversationWithHistory
				ctx.ui.notify(`Conversation compacted successfully`, "info");
			} finally {
				// Always clear the override (success, error, or early return)
				pi.events.emit("thinking-status:override", { label: undefined });
			}
		} catch (error) {
				const msg = error instanceof Error ? error.message : "Unknown error";
				if (msg.includes('rate limited')) {
					ctx.ui.notify(`Rate limit: ${msg}. Try a different model or wait.`, "warning");
				} else if (msg.includes('authentication failed') || msg.includes('API key')) {
					ctx.ui.notify(`Auth error: ${msg}`, "error");
				} else {
					ctx.ui.notify(`Compaction error: ${msg}`, "error");
				}
			}
		},
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
