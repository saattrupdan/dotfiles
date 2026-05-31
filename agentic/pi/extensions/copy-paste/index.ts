/**
 * Tool-output reference annotations.
 *
 * Lets an agent surface a verbatim tool output (e.g. the full stdout of a
 * `bash` command, or the body of a `read`) without re-emitting it through
 * the model — that's expensive in tokens and lossy in fidelity.
 *
 * Two hooks, all in-process:
 *
 *  1. `tool_result` — prepends `[toolCallId: <id>]` to every tool result
 *     so the model sees the ID in plain text (it lives in protocol metadata
 *     otherwise and the model can't reliably reference it).
 *  2. `tool_execution_end` — captures each result keyed by `toolCallId`
 *     (with the prepended tag stripped back off) into an in-memory map.
 *  3. `message_end` — when the assistant produces a message, any
 *     `{tool: <id>}` placeholder in its text parts is expanded into the
 *     captured tool output before the message is finalized.
 *
 * Because expansion runs on `message_end` in the same process that produced
 * the message, it works for both subagents (their final message is expanded
 * before being streamed to the parent) and for the orchestrator (its
 * messages to the user are expanded directly).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PLACEHOLDER = /\{tool:\s*([^}]*\S)\s*\}/g;

export function toolCallIdTag(toolCallId: string) {
	return `[toolCallId: ${toolCallId}]\n`;
}

export function stripPrependedToolCallIdTag(raw: string, toolCallId: string) {
	const tag = toolCallIdTag(toolCallId);
	if (!raw.startsWith(tag)) return raw;

	let contentStart = tag.length;
	if (raw[contentStart] === "\n") contentStart += 1;
	return raw.slice(contentStart);
}

export function expandToolPlaceholders(
	text: string,
	toolResultMap: ReadonlyMap<string, string>,
) {
	return text.replace(PLACEHOLDER, (match: string, id: string) => {
		const captured = toolResultMap.get(id);
		return captured === undefined ? match : captured;
	});
}

export default function (pi: ExtensionAPI) {
	// toolCallId → captured tool result text (with the `[toolCallId: ...]`
	// tag we prepended stripped back off).
	const toolResultMap = new Map<string, string>();

	pi.on("tool_result", async (event) => {
		const tag = toolCallIdTag(event.toolCallId as string);
		const original = event.content ?? [];
		return { content: [{ type: "text" as const, text: tag }, ...original] };
	});

	pi.on("tool_execution_end", async (event) => {
		if (!event.toolCallId) return;
		const tcid = event.toolCallId as string;
		const raw = ((event.result?.content ?? []) as { type?: string; text?: string }[])
			.map((c) => (c.type === "text" ? c.text ?? "" : ""))
			.filter(Boolean)
			.join("\n");
		const stripped = stripPrependedToolCallIdTag(raw, tcid);
		toolResultMap.set(tcid, stripped);
	});

	pi.on("message_end", async (event) => {
		const msg = event.message;
		if (!msg || msg.role !== "assistant") return;
		const content = (msg as any).content;
		if (!Array.isArray(content)) return;

		let changed = false;
		const newContent = content.map((part: any) => {
			if (part?.type !== "text" || typeof part.text !== "string") return part;
			const expanded = expandToolPlaceholders(part.text, toolResultMap);
			if (expanded !== part.text) changed = true;
			return expanded === part.text ? part : { ...part, text: expanded };
		});

		if (!changed) return;
		return { message: { ...msg, content: newContent } };
	});
}
