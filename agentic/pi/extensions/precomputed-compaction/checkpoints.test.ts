import assert from "node:assert/strict";
import test from "node:test";
import {
	buildSessionProjection,
	estimateTokens,
	SessionManager,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_CONFIG,
	checkpointCompaction, latestCheckpoint, matchesHistory, parseConfig, planCheckpoint,
	projectHistory, scaledConfig, validateSummary,
} from "./checkpoints.ts";

import { summary, entry, conversation, checkpointFor, storedCheckpoint, linkEntries } from "./fixtures.ts";

const small = { ...DEFAULT_CONFIG, startTokens: 200, updateTokens: 60, keepRecentTokens: 100, maxChunkTokens: 180 };

test("configuration validates preparation floors and ordered headroom", () => {
	assert.deepEqual(parseConfig({}), DEFAULT_CONFIG);
	assert.equal(parseConfig({ model: "other" }).model, "other");
	for (const invalid of [null, [], { enabled: "yes" }, { model: "" }, { thinkingLevel: "turbo" }, { updateTokens: -1 }, { startTokens: 20 }, { startHeadroomTokens: 50_000 }, { compactHeadroomTokens: 0 }]) {
		assert.throws(() => parseConfig(invalid));
	}
});

test("thresholds follow the effective context window without a large-window ceiling", () => {
	for (const window of [200_000, 250_000, 256_000, 300_000, 1_000_000]) {
		const resolved = scaledConfig(DEFAULT_CONFIG, window, 16_384);
		assert.equal(resolved.enabled, true);
		assert.equal(resolved.startTokens, Math.max(50_000, window - 150_000));
		assert.equal(resolved.compactAtTokens, window - 50_000);
		assert.equal(resolved.keepRecentTokens, Math.floor(30_000 * Math.min(1, window / 256_000)));
	}
	assert.equal(scaledConfig(DEFAULT_CONFIG, 128_000, 16_384).startTokens, 50_000);
	assert.equal(scaledConfig({ ...DEFAULT_CONFIG, enabled: false }, 256_000, 16_384).enabled, false);
});

test("small or invalid windows leave native compaction in charge", () => {
	for (const window of [0, 2048, 32_000, 100_000, Infinity, NaN]) {
		assert.equal(scaledConfig(DEFAULT_CONFIG, window, 16_384).enabled, false);
	}
	const reserved = scaledConfig(DEFAULT_CONFIG, 250_000, 120_000);
	assert.equal(reserved.compactAtTokens, 128_976);
	assert.equal(reserved.enabled, true);
	assert.equal(scaledConfig(DEFAULT_CONFIG, 250_000, 160_000).enabled, false);
});

test("short histories and a tail with no eligible source do not start summaries", () => {
	assert.equal(planCheckpoint(projectHistory(conversation(2, 100)), small), undefined);
	const branch = conversation(10, 1000);
	const checkpoint = checkpointFor(conversation());
	assert.equal(planCheckpoint(projectHistory(branch), { ...small, startTokens: 1, keepRecentTokens: 100_000 }), undefined);
	assert.equal(latestCheckpoint([...branch, storedCheckpoint(checkpoint)]), undefined);
});

test("first checkpoint is bounded; updates consume only new source plus the previous summary", () => {
	const branch = conversation(20, 400);
	const history = projectHistory(branch);
	const first = planCheckpoint(history, small);
	assert.ok(first);
	assert.equal(first.previousSummary, undefined);
	assert.equal(first.entries[0].sourceEntry.id, "message-0");
	const checkpoint = { ...first.checkpoint, summary, createdAt: 1 };
	const second = planCheckpoint(history, small, checkpoint);
	assert.ok(second);
	assert.equal(second.previousSummary, summary);
	assert.equal(second.entries[0].sourceEntry.id, checkpoint.firstKeptEntryId);
	assert.ok(!second.entries.some(next => first.entries.some(previous => previous.sourceEntry.id === next.sourceEntry.id)));
	const lastWork = planCheckpoint(history, { ...small, maxChunkTokens: 10_000 });
	assert.ok(lastWork);
	const latest = { ...lastWork.checkpoint, summary, createdAt: 2 };
	assert.equal(planCheckpoint(history, small, latest), undefined);
});

test("cut points preserve complete parallel tool exchanges, even when one result crosses the chunk budget", () => {
	const branch = [
		entry("user", "user", "x".repeat(400)),
		entry("call", "assistant", "", { content: [
			{ type: "toolCall", id: "a", name: "read", arguments: { path: "a" } },
			{ type: "toolCall", id: "b", name: "read", arguments: { path: "b" } },
		] }),
		entry("result-a", "toolResult", "x".repeat(400), { toolCallId: "a", toolName: "read" }),
		entry("result-b", "toolResult", "x".repeat(400), { toolCallId: "b", toolName: "read" }),
		entry("next", "assistant", "x".repeat(400)),
		entry("tail", "user", "x".repeat(400)),
	];
	const history = projectHistory(linkEntries(branch));
	const limited = planCheckpoint(history, small);
	assert.ok(limited);
	assert.equal(limited.checkpoint.firstKeptEntryId, "call");
	const larger = planCheckpoint(history, { ...small, maxChunkTokens: 1000 });
	assert.ok(larger);
	assert.ok(!larger.checkpoint.firstKeptEntryId.startsWith("result-"));
	const cut = history.entries.findIndex(item => item.sourceEntry.id === larger.checkpoint.firstKeptEntryId);
	const retained = history.entries.slice(cut).flatMap(item => item.messages);
	for (const result of retained.filter(message => message.role === "toolResult")) {
		assert.ok(retained.some(message => message.role === "assistant" && message.content.some(block => block.type === "toolCall" && block.id === result.toolCallId)));
	}
});

test("checkpoint restoration ignores state-only entries and rejects changed source, divergent branches and later compactions", () => {
	const branch = conversation();
	const checkpoint = checkpointFor(branch);
	const saved = storedCheckpoint(checkpoint);
	assert.deepEqual(latestCheckpoint([...branch, saved]), checkpoint);
	const metadata: SessionEntry = { type: "custom", id: "meta", parentId: null, timestamp: "", customType: "other", data: {} };
	assert.ok(matchesHistory(projectHistory(linkEntries([...branch, metadata])), checkpoint));
	const edited = [...branch];
	edited[0] = entry("message-0", "user", "changed instructions");
	assert.equal(latestCheckpoint([...edited, saved]), undefined);
	assert.equal(latestCheckpoint([...branch.slice(4), saved]), undefined);
	const compacted: SessionEntry = {
		type: "compaction", id: "native", parentId: null, timestamp: "", summary: "New native summary",
		firstKeptEntryId: "message-8", tokensBefore: 100_000,
	};
	assert.equal(latestCheckpoint(linkEntries([...branch, saved, compacted])), undefined);
});

test("resuming after a native compaction carries its summary without re-reading discarded raw messages", () => {
	const branch = conversation();
	branch.push({ type: "compaction", id: "native", parentId: null, timestamp: "", summary: "Previous native facts",
		firstKeptEntryId: "message-4", tokensBefore: 200_000 });
	branch.push(entry("latest", "user", "x".repeat(20_000)));
	const work = planCheckpoint(projectHistory(linkEntries(branch)), DEFAULT_CONFIG);
	assert.ok(work);
	assert.equal(work.previousSummary, "Previous native facts");
	assert.equal(work.checkpoint.baseCompactionId, "native");
	assert.equal(work.entries[0].sourceEntry.id, "message-4");
});

test("compaction preserves every entry at and after the coverage marker in the native projection", () => {
	const branch = conversation();
	const checkpoint = checkpointFor(branch);
	branch.push(entry("uncovered", "user", "New instructions after the background snapshot"));
	const history = projectHistory(linkEntries(branch));
	const result = checkpointCompaction(history, checkpoint, 150_000, 256_000, 16_384);
	assert.ok(result);
	assert.equal(result.tokensBefore, 150_000);
	assert.equal(result.firstKeptEntryId, checkpoint.firstKeptEntryId);
	const projected = buildSessionProjection(linkEntries([...branch, {
		type: "compaction", id: "applied", parentId: null, timestamp: "", ...result,
	}]));
	const tail = history.entries.slice(history.entries.findIndex(item => item.sourceEntry.id === checkpoint.firstKeptEntryId)).flatMap(item => item.messages);
	assert.deepEqual(projected.messages.slice(1), tail);
});

test("an old checkpoint that cannot free enough context falls back instead of overflowing again", () => {
	const branch = conversation();
	const checkpoint = checkpointFor(branch);
	branch.push(entry("huge", "user", "x".repeat(1_000_000)));
	assert.equal(checkpointCompaction(projectHistory(linkEntries(branch)), checkpoint, 350_000, 256_000, 16_384), undefined);
	assert.equal(checkpointCompaction(projectHistory(conversation()), checkpoint, 1000, 256_000, 16_384), undefined);
});

test("post-swap accounting matches Pi's preserved system snapshot and rejects small-window overflow", () => {
	const manager = SessionManager.inMemory();
	manager.appendMessage({ role: "system", content: "s".repeat(60_000), timestamp: 0 });
	for (const item of conversation(10, 4000)) {
		if (item.type === "message") manager.appendMessage(item.message);
	}
	const history = projectHistory(manager.getBranch());
	const work = planCheckpoint(history, { ...DEFAULT_CONFIG, startTokens: 1, keepRecentTokens: 3000 });
	assert.ok(work);
	const checkpoint = { ...work.checkpoint, summary, createdAt: 1 };
	assert.equal(checkpointCompaction(history, checkpoint, history.tokens, 32_000, 16_384), undefined);
	const safe = checkpointCompaction(history, checkpoint, history.tokens, 128_000, 16_384);
	assert.ok(safe);
	manager.appendCompaction(safe.summary, safe.firstKeptEntryId, safe.tokensBefore, safe.details, true);
	const actual = manager.buildSessionProjection().messages.reduce((sum, message) => sum + estimateTokens(message), 0);
	assert.equal(safe.estimatedTokensAfter, actual);
	assert.equal(manager.buildSessionProjection().messages[0].role, "system");
});

test("empty, oversized, malformed and section-incomplete summaries are rejected", () => {
	assert.doesNotThrow(() => validateSummary(summary, 8000));
	assert.throws(() => validateSummary("", 8000));
	assert.throws(() => validateSummary(summary, 1));
	assert.throws(() => validateSummary("A plausible paragraph without the structured state", 8000));
});
