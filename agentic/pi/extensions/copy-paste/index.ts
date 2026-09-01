/**
 * Tool-output reference annotations.
 *
 * Lets an agent surface a verbatim tool output (e.g. the full stdout of a
 * `bash` command, or the body of a `read`) without re-emitting it through
 * the model — that's expensive in tokens and lossy in fidelity.
 *
 * Three hooks, all in-process:
 *
 *  1. `tool_result` — prepends `[toolCallId: <id>]` to every tool result
 *     so the model sees the ID in plain text (it lives in protocol metadata
 *     otherwise and the model can't reliably reference it).
 *  2. `tool_execution_end` — captures each result into an in-memory map.
 *  3. `message_end` — when the assistant produces a message, any
 *     `{tool: <id>}` placeholder in its text parts is expanded into the
 *     captured tool output before the message is finalized.
 *
 * Because expansion runs on `message_end` in the same process that produced
 * the message, it works for both subagents (their final message is expanded
 * before being streamed to the parent) and for the orchestrator (its
 * messages to the user are expanded directly).
 *
 * ## Which ID the model may use
 *
 * pi's internal `toolCallId` is not always what the model sees. The OpenAI
 * Responses family (`openai-codex`, `github-copilot`, `opencode`) encodes a
 * call as `{call_id}|{item_id}`; pi splits that apart again when it builds
 * requests, so on the wire the model only ever reads the `call_id` part, and
 * the item part is rewritten whenever the session is replayed into another
 * model. Item ids can also be 400+ chars of base64 — pure token waste to
 * print. So the tag prints the *reference* id (everything before the first
 * `|`) and the result is registered under both the reference id and the full
 * internal id, making a placeholder work whichever form the model copies. If
 * two calls ever shared a reference id, the first claimer keeps the short tag
 * and the later one is tagged with its full id, so a short placeholder can
 * never resolve to the wrong output.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PLACEHOLDER = /\{tool:\s*([^}]*\S)\s*\}/g;
const ID_SEPARATOR = "|";

/** The part of a toolCallId that is stable and visible to the model. */
export function toolCallIdReference(toolCallId: string) {
	const separator = toolCallId.indexOf(ID_SEPARATOR);
	return separator === -1 ? toolCallId : toolCallId.slice(0, separator);
}

function formatTag(handle: string) {
	return `[toolCallId: ${handle}]\n`;
}

/** The tag line printed in front of a tool result for the given id. */
export function toolCallIdTag(toolCallId: string) {
	return formatTag(toolCallIdReference(toolCallId));
}

/** Every tag form a result for `toolCallId` may have been printed with. */
function toolCallIdTags(toolCallId: string) {
	const reference = toolCallIdReference(toolCallId);
	return reference === toolCallId
		? [formatTag(toolCallId)]
		: [formatTag(reference), formatTag(toolCallId)];
}

export function stripPrependedToolCallIdTag(raw: string, toolCallId: string) {
	for (const tag of toolCallIdTags(toolCallId)) {
		if (!raw.startsWith(tag)) continue;
		let contentStart = tag.length;
		if (raw[contentStart] === "\n") contentStart += 1;
		return raw.slice(contentStart);
	}
	return raw;
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

/** The ids referenced by unresolvable `{tool: <id>}` placeholders in `text`. */
export function unresolvedToolPlaceholders(
	text: string,
	toolResultMap: ReadonlyMap<string, string>,
) {
	const unresolved: string[] = [];
	for (const [, id] of text.matchAll(PLACEHOLDER)) {
		if (!toolResultMap.has(id)) unresolved.push(id);
	}
	return unresolved;
}

export interface ToolResultStore {
	/** Captured outputs, keyed by every id that can reach them. */
	readonly outputs: ReadonlyMap<string, string>;
	/** The tag to print for `toolCallId`, claiming its short handle if free. */
	tagFor(toolCallId: string): string;
	/** Capture a raw tool result (our tag still prepended) for later reference. */
	remember(toolCallId: string, raw: string): void;
}

export function createToolResultStore(): ToolResultStore {
	const outputs = new Map<string, string>();
	// Reference id → the full toolCallId that claimed it, so two different
	// calls can never resolve through the same short handle.
	const referenceOwners = new Map<string, string>();

	function referenceFor(toolCallId: string) {
		const reference = toolCallIdReference(toolCallId);
		if (reference === toolCallId) return toolCallId;

		const owner = referenceOwners.get(reference);
		if (owner === undefined) {
			referenceOwners.set(reference, toolCallId);
			return reference;
		}
		return owner === toolCallId ? reference : toolCallId;
	}

	return {
		outputs,
		// The handle is already short or full — never re-shorten it here.
		tagFor: (toolCallId) => formatTag(referenceFor(toolCallId)),
		remember: (toolCallId, raw) => {
			const text = stripPrependedToolCallIdTag(raw, toolCallId);
			outputs.set(toolCallId, text);
			const reference = referenceFor(toolCallId);
			if (reference !== toolCallId) outputs.set(reference, text);
		},
	};
}

export default function (pi: ExtensionAPI) {
	const store = createToolResultStore();

	pi.on("tool_result", async (event) => {
		const tag = store.tagFor(event.toolCallId as string);
		const original = event.content ?? [];
		return { content: [{ type: "text" as const, text: tag }, ...original] };
	});

	pi.on("tool_execution_end", async (event) => {
		if (!event.toolCallId) return;
		const raw = ((event.result?.content ?? []) as { type?: string; text?: string }[])
			.map((c) => (c.type === "text" ? c.text ?? "" : ""))
			.filter(Boolean)
			.join("\n");
		store.remember(event.toolCallId as string, raw);
	});

	pi.on("message_end", async (event, ctx) => {
		const msg = event.message;
		if (!msg || msg.role !== "assistant") return;
		const content = (msg as any).content;
		if (!Array.isArray(content)) return;

		const unresolved: string[] = [];
		let changed = false;
		const newContent = content.map((part: any) => {
			if (part?.type !== "text" || typeof part.text !== "string") return part;
			unresolved.push(...unresolvedToolPlaceholders(part.text, store.outputs));
			const expanded = expandToolPlaceholders(part.text, store.outputs);
			if (expanded === part.text) return part;
			changed = true;
			return { ...part, text: expanded };
		});

		// A placeholder that cannot be resolved would otherwise be echoed to
		// the user verbatim with no hint of what went wrong.
		if (unresolved.length > 0 && ctx?.ui) {
			ctx.ui.notify(
				`copy-paste: unknown tool call id in placeholder (${[...new Set(unresolved)].join(", ")})`,
				"warning",
			);
		}
		if (!changed) return;
		return { message: { ...msg, content: newContent } };
	});
}
