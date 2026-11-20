import assert from "node:assert/strict";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { CHECKPOINT_TYPE, DEFAULT_CONFIG, SUMMARY_SECTIONS, planCheckpoint, projectHistory, type Checkpoint } from "./checkpoints.ts";

export const summary = SUMMARY_SECTIONS.map(section => `## ${section}\n${section === "Goal" ? "Continue the requested task; preserve explicit constraints." : "None"}\n`).join("\n");

export function entry(id: string, role: "user" | "assistant" | "toolResult", text: string, extra = {}): SessionEntry {
	return {
		type: "message", id, parentId: null, timestamp: "2026-11-15T12:00:00.000Z",
		message: {
			role, content: [{ type: "text", text }], timestamp: 0,
			...(role === "assistant" ? { api: "openai-responses", provider: "test", model: "test", stopReason: "stop",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } : {}),
			...extra,
		},
	} as SessionEntry;
}

export function conversation(count = 20, chars = 24_000): SessionEntry[] {
	return linkEntries(Array.from({ length: count }, (_, i) => entry(`message-${i}`, i % 2 ? "assistant" : "user", `${i}:` + "x".repeat(chars))));
}

export function linkEntries(entries: SessionEntry[]): SessionEntry[] {
	return entries.map((entry, index) => ({ ...entry, parentId: entries[index - 1]?.id ?? null }));
}

export function checkpointFor(branch: SessionEntry[]): Checkpoint {
	const work = planCheckpoint(projectHistory(branch), DEFAULT_CONFIG);
	assert.ok(work);
	return { ...work.checkpoint, summary, createdAt: 1 };
}

export function storedCheckpoint(checkpoint: Checkpoint, id = "checkpoint"): SessionEntry {
	return { type: "custom", id, parentId: "message-19", timestamp: "2026-11-15T12:00:00.000Z", customType: CHECKPOINT_TYPE, data: checkpoint };
}
