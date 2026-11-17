/** Lossless local display history; compact tool results carry only the archive id. */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getAgentDir, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";

export type ToolOutput = AgentToolResult<unknown> & { isError: boolean; durationMs?: number };
export type ActivityItem = { type: "text"; text: string } | {
	type: "toolCall"; id: string; name: string; args: Record<string, unknown>;
	result?: ToolOutput; isPartial: boolean;
};
type Live = { message?: Message; partialResults: Record<string, ToolOutput> };
type PrivateTranscript = { messages: Message[]; live: Live };
// Extension reloads and render-only consumers share the same process-local private history.
const key = Symbol.for("pi.subagent.privateTranscripts");
const runtime = globalThis as unknown as Record<symbol, Map<string, PrivateTranscript>>;
const privateTranscripts = runtime[key] ??= new Map<string, PrivateTranscript>();

type Location = { offset: number; length: number };
type Entry = { location: Location; block: number; id?: string };
type Index = { offset: number; entries: Entry[]; results: Map<string, Location> };

/** Interpret narration and tool calls identically for live, archived, and legacy messages. */
export function activityItems(messages: Message[], partials: Record<string, ToolOutput> = {}): ActivityItem[] {
	const results = new Map<string, ToolOutput>();
	for (const message of messages) {
		if (message.role === "toolResult") results.set(message.toolCallId, message as ToolOutput);
	}
	return messages.flatMap((message): ActivityItem[] => {
		if (message.role !== "assistant") return [];
		return message.content.flatMap((part): ActivityItem[] => {
			if (part.type === "text") return part.text.trim() ? [{ type: "text", text: part.text }] : [];
			if (part.type !== "toolCall") return [];
			return [{ type: "toolCall", id: part.id, name: part.name, args: part.arguments,
				result: results.get(part.id) ?? partials[part.id], isPartial: !results.has(part.id) }];
		});
	});
}

export class TranscriptArchive {
	private indexes = new Map<string, Index>();
	constructor(private root = path.join(getAgentDir(), "subagent-transcripts")) {}

	create(options: { persist?: boolean; onUpdate?: () => void } = {}) {
		const persist = options.persist !== false;
		const id = persist ? randomUUID() : `memory:${randomUUID()}`;
		const live: Live = { partialResults: {} };
		const messages: Message[] = [];
		let file: string | undefined;
		let streamTimer: ReturnType<typeof setTimeout> | undefined;
		if (persist) {
			fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
			file = this.file(id);
			fs.writeFileSync(file, "", { mode: 0o600, flag: "wx" });
		} else privateTranscripts.set(id, { messages, live });
		const publish = () => {
			if (!file) return;
			fs.writeFileSync(`${file}.tmp`, JSON.stringify(live), { mode: 0o600 });
			fs.renameSync(`${file}.tmp`, `${file}.live`);
		};
		const flushStream = () => {
			if (streamTimer) clearTimeout(streamTimer);
			streamTimer = undefined;
			publish();
		};
		return {
			id,
			append(message: Message) {
				if (streamTimer) clearTimeout(streamTimer);
				streamTimer = undefined;
				if (file) fs.appendFileSync(file, `${JSON.stringify(message)}\n`);
				else messages.push(message);
				if (message.role === "assistant") live.message = undefined;
				if (message.role === "toolResult") delete live.partialResults[message.toolCallId];
				publish();
			},
			stream(message: Message) {
				live.message = message;
				if (!streamTimer) streamTimer = setTimeout(() => {
					streamTimer = undefined;
					publish();
					options.onUpdate?.();
				}, 50);
			},
			partial(id: string, result: ToolOutput) { live.partialResults[id] = result; publish(); },
			finish() {
				// Flush even if the child exits inside the 50ms streaming debounce window.
				flushStream();
				if (file && !live.message && !Object.keys(live.partialResults).length)
					fs.rmSync(`${file}.live`, { force: true });
			},
		};
	}

	clearPrivate() { privateTranscripts.clear(); }

	/** Only selected entries load payloads. The incremental index retains byte offsets, not tool output. */
	read(id: string, expanded: boolean): ActivityItem[] {
		if (id.startsWith("memory:")) {
			const history = privateTranscripts.get(id);
			if (!history) throw new Error("Private subagent history is no longer available");
			const items = activityItems([...history.messages, ...(history.live.message ? [history.live.message] : [])], history.live.partialResults);
			return expanded ? items : items.slice(-5);
		}
		const file = this.file(id);
		let index = this.indexes.get(id);
		if (!index) {
			index = { offset: 0, entries: [], results: new Map() };
			this.indexes.set(id, index);
			if (this.indexes.size > 16) this.indexes.delete(this.indexes.keys().next().value!);
		}
		const fd = fs.openSync(file, "r");
		try {
			const size = fs.fstatSync(fd).size;
			if (size > index.offset) {
				const data = Buffer.alloc(size - index.offset);
				fs.readSync(fd, data, 0, data.length, index.offset);
				let start = 0;
				for (let end = data.indexOf(10); end !== -1; end = data.indexOf(10, start)) {
					const location = { offset: index.offset + start, length: end - start };
					const message = JSON.parse(data.subarray(start, end).toString()) as Message;
					if (message.role === "assistant") message.content.forEach((part, block) => {
						if (part.type === "toolCall") index!.entries.push({ location, block, id: part.id });
						else if (part.type === "text" && part.text.trim()) index!.entries.push({ location, block });
					});
					if (message.role === "toolResult") index.results.set(message.toolCallId, location);
					start = end + 1;
				}
				index.offset += start;
			}
			let live: Live = { partialResults: {} };
			try { live = JSON.parse(fs.readFileSync(`${file}.live`, "utf8")) as Live; }
			catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
			const streaming = live.message ? activityItems([live.message], live.partialResults) : [];
			const count = Math.max(0, 5 - streaming.length);
			const selected = expanded ? index.entries : count ? index.entries.slice(-count) : [];
			const loaded = new Map<number, Message>();
			const load = (location: Location) => {
				let message = loaded.get(location.offset);
				if (!message) {
					const data = Buffer.alloc(location.length);
					fs.readSync(fd, data, 0, data.length, location.offset);
					message = JSON.parse(data.toString()) as Message;
					loaded.set(location.offset, message);
				}
				return message;
			};
			const items = selected.map((entry): ActivityItem => {
				const message = load(entry.location);
				if (message.role !== "assistant") throw new Error("Invalid subagent transcript entry");
				const part = message.content[entry.block]!;
				if (part.type === "text") return { type: "text", text: part.text };
				if (part.type !== "toolCall") throw new Error("Invalid subagent transcript block");
				const result = index!.results.get(part.id);
				return { type: "toolCall", id: part.id, name: part.name, args: part.arguments,
					result: result ? load(result) as ToolOutput : live.partialResults[part.id], isPartial: !result };
			});
			return expanded ? [...items, ...streaming] : [...items, ...streaming].slice(-5);
		} finally { fs.closeSync(fd); }
	}

	private file(id: string) {
		if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id)) throw new Error("Invalid subagent transcript id");
		return path.join(this.root, `${id}.jsonl`);
	}
}

export const transcripts = new TranscriptArchive();
