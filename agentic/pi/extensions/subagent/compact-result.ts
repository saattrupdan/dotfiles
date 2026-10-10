/** Keep subagent UI history useful without persisting entire child tool transcripts. */
import type { Message } from "@earendil-works/pi-ai";

const MAX_TEXT = 64_000;
const MAX_ARGUMENT = 1_000;
const MAX_MESSAGES = 200;

type ResultLike = { messages: Message[]; partialResults?: Record<string, unknown>; finalOutput?: string };

function shorten(text: string, limit: number): string {
	return text.length > limit ? `${text.slice(0, limit)}… [truncated]` : text;
}

function compactArguments(value: unknown): unknown {
	if (typeof value === "string") return shorten(value, MAX_ARGUMENT);
	if (Array.isArray(value)) return value.slice(0, 20).map(compactArguments);
	if (value && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).slice(0, 30).map(([key, item]) => [key, compactArguments(item)]));
	}
	return value;
}

/** Tool-result content (not shown by the subagent renderer) often includes base64 images. */
export function compactMessage(message: Message): Message {
	if (message.role === "toolResult") {
		const result = message as typeof message & { details?: ResultLike };
		return {
			...message,
			content: [],
			...(message.toolName === "subagent" && result.details?.messages
				? { details: compactResult(result.details) }
				: { details: undefined }),
		} as Message;
	}
	if (message.role === "assistant") {
		return {
			...message,
			content: message.content.filter((block) => block.type !== "thinking").map((block) => {
				if (block.type === "text") return { ...block, text: shorten(block.text, MAX_TEXT) };
				return { ...block, arguments: compactArguments(block.arguments) as Record<string, unknown> };
			}),
		} as Message;
	}
	return { ...message, content: [] } as Message;
}

/** Bound retained messages; a child session itself remains available on disk. */
export function compactResult<T extends ResultLike>(result: T, live = false): T {
	const partialResults = live && result.partialResults
		? Object.fromEntries(Object.entries(result.partialResults).slice(-20).map(([id, partial]) => {
			const item = partial as { details?: ResultLike; isError?: boolean };
			return [id, { content: [], isError: item.isError,
				details: item.details?.messages ? compactResult(item.details, true) : undefined }];
		}))
		: undefined;
	return {
		...result,
		messages: result.messages.slice(-MAX_MESSAGES).map(compactMessage),
		finalOutput: undefined, // The outer tool content holds the complete answer.
		partialResults,
	};
}
