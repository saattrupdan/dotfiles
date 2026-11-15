import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import extension from "./index.ts";
import { CHECKPOINT_TYPE, latestCheckpoint } from "./checkpoints.ts";
import { checkpointFor, conversation, entry, storedCheckpoint, summary, linkEntries } from "./fixtures.ts";

const tick = () => new Promise<void>(resolve => setImmediate(resolve));

type Response = { content: { type: string; text?: string }[]; stopReason: string; errorMessage?: string };
function setup(t: TestContext, initial = conversation(), ignoreAbort = false) {
	const cwd = mkdtempSync(path.join(tmpdir(), "pi-checkpoint-test-"));
	const listeners = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	const calls: { resolve: (response: Response) => void; signal: AbortSignal; context: { messages: { content: string }[] }; options: Record<string, unknown> }[] = [];
	const compactCalls: { customInstructions: string; onComplete: () => void; onError: (error: Error) => void }[] = [];
	const statuses: (string | undefined)[] = [];
	const notices: string[] = [];
	let branch = linkEntries(initial);
	let sessionId = "session-one";
	let idle = true;
	let pending = false;
	let tokens = 150_000;
	let command: ((args: string, ctx: ExtensionContext) => Promise<void>) | undefined;
	const model = { provider: "openai-codex", id: "gpt-6-luna", contextWindow: 256_000, maxTokens: 32_000 };
	const ctx = {
		cwd, hasUI: false,
		model,
		isIdle: () => idle,
		hasPendingMessages: () => pending,
		getContextUsage: () => ({ tokens, contextWindow: 256_000, percent: tokens / 2560 }),
		compact: (options: typeof compactCalls[number]) => { compactCalls.push(options); },
		sessionManager: { getBranch: () => branch, getSessionId: () => sessionId, getSessionFile: () => path.join(cwd, "session.jsonl") },
		modelRegistry: {
			find: (provider: string, id: string) => { assert.equal(provider, "openai-codex"); assert.equal(id, "gpt-6-luna"); return model; },
			streamSimple: (_model: unknown, context: typeof calls[number]["context"], options: typeof calls[number]["options"] & { signal: AbortSignal }) => ({
				result: () => new Promise<Response>((resolve, reject) => {
					calls.push({ resolve, signal: options.signal, context, options });
					if (!ignoreAbort) options.signal.addEventListener("abort", () => reject(new Error("Aborted")), { once: true });
				}),
			}),
		},
		ui: { setStatus: (_key: string, value?: string) => statuses.push(value), notify: (text: string) => notices.push(text) },
	} as unknown as ExtensionContext;
	extension({
		on: (event: string, handler: typeof listeners extends Map<string, infer H> ? H : never) => listeners.set(event, handler),
		appendEntry: (customType: string, data: unknown) => branch.push({ type: "custom", id: `custom-${branch.length}`, parentId: branch.at(-1)?.id ?? null, timestamp: "", customType, data }),
		registerCommand: (_name: string, options: { handler: typeof command }) => { command = options.handler; },
	} as unknown as ExtensionAPI);
	const event = (name: string, value: unknown = {}) => {
		const listener = listeners.get(name);
		assert.ok(listener, `listener ${name}`);
		return listener(value, ctx);
	};
	t.after(async () => { event("session_shutdown"); await tick(); rmSync(cwd, { recursive: true, force: true }); });
	return {
		ctx, calls, event, compactCalls, statuses, notices,
		setNativeEnabled: (enabled: boolean) => {
			mkdirSync(path.join(cwd, ".pi"), { recursive: true });
			writeFileSync(path.join(cwd, ".pi", "settings.json"), JSON.stringify({ compaction: { enabled } }));
		},
		get branch() { return branch; },
		set branch(value: SessionEntry[]) { branch = linkEntries(value); },
		set sessionId(value: string) { sessionId = value; },
		set idle(value: boolean) { idle = value; },
		set pending(value: boolean) { pending = value; },
		set tokens(value: number) { tokens = value; },
		complete: async (index = 0, response: Response = { content: [{ type: "text", text: summary }], stopReason: "stop" }) => {
			calls[index].resolve(response);
			await tick();
		},
		hook: (reason = "threshold", customInstructions?: string) => event("session_before_compact", {
			reason, customInstructions, preparation: { tokensBefore: tokens }, branchEntries: branch,
		}),
		status: async () => { assert.ok(command); await command("", ctx); },
	};
}

test("worker is detached, singleton, separately configured and does not rewrite the live context", async t => {
	const app = setup(t);
	const before = [...app.branch];
	assert.equal(app.event("session_start"), undefined);
	assert.equal(app.calls.length, 1);
	assert.equal(app.event("turn_end"), undefined);
	assert.equal(app.calls.length, 1);
	assert.deepEqual(app.branch, before);
	assert.equal(app.calls[0].options.reasoning, "low");
	assert.equal(app.calls[0].options.cacheRetention, "none");
	assert.equal(app.calls[0].options.disableContinuation, true);
	assert.equal(app.calls[0].options.sessionId, "checkpoint-session-one");
	assert.ok(app.calls[0].context.messages[0].content.includes('entry="message-0"'));
	await app.complete();
	const checkpoint = latestCheckpoint(app.branch);
	assert.ok(checkpoint);
	assert.equal(checkpoint.summary.trim(), summary.trim());
	assert.deepEqual(app.branch.filter(item => item.type !== "custom"), before);
	assert.equal(app.compactCalls.length, 0);
	if (app.calls.length > 1) {
		const nextInput = app.calls[1].context.messages[0].content;
		assert.ok(nextInput.includes(summary.trim()));
		assert.ok(!nextInput.includes('entry="message-0"'));
	}
});

test("short conversations do not spend summary requests", t => {
	const app = setup(t, conversation(4, 100));
	app.event("session_start");
	app.event("turn_end");
	assert.equal(app.calls.length, 0);
});

test("manual compaction is untouched; automatic compaction uses a saved checkpoint without awaiting a worker", t => {
	const branch = conversation();
	const checkpoint = checkpointFor(branch);
	const app = setup(t, [...branch, storedCheckpoint(checkpoint)]);
	app.event("session_start");
	assert.equal(app.hook("manual", "Focus on my request"), undefined);
	assert.equal(app.calls[0]?.signal.aborted, true);
	app.event("session_compact_failed");
	const result = app.hook() as { compaction?: { summary: string; firstKeptEntryId: string } };
	assert.ok(result.compaction);
	assert.equal(result.compaction.firstKeptEntryId, checkpoint.firstKeptEntryId);
	assert.equal(result.compaction.summary.trim(), summary.trim());
});

test("missing or unsafe checkpoints preserve the native threshold and overflow fallback", t => {
	const app = setup(t);
	app.event("session_start");
	assert.equal(app.hook("threshold"), undefined);
	app.event("session_compact_failed");
	assert.equal(app.hook("overflow"), undefined);
	const checkpoint = checkpointFor(conversation());
	app.branch = [...conversation(), storedCheckpoint(checkpoint), entry("oversized", "user", "x".repeat(1_000_000))];
	app.tokens = 350_000;
	assert.equal(app.hook("overflow"), undefined);
});

test("branch switches and reloads abort workers; even a provider ignoring abort cannot persist stale results", async t => {
	const app = setup(t, conversation(), true);
	app.event("session_start");
	app.event("session_before_tree");
	assert.equal(app.calls[0].signal.aborted, true);
	app.branch = conversation(2, 100);
	app.event("session_tree");
	await app.complete();
	assert.ok(!app.branch.some(item => item.type === "custom" && item.customType === CHECKPOINT_TYPE));
	app.branch = conversation();
	app.event("session_start");
	assert.equal(app.calls.length, 2);
	app.event("session_shutdown");
	await app.complete(1);
	assert.ok(!app.branch.some(item => item.type === "custom" && item.customType === CHECKPOINT_TYPE));
});

test("session identity and changed source are rechecked before persisting", async t => {
	const app = setup(t, conversation(), true);
	app.event("session_start");
	app.sessionId = "new-session";
	await app.complete();
	assert.equal(app.branch.length, 20);
	app.event("session_start");
	app.branch[0] = entry("message-0", "user", "Different user constraints");
	await app.complete(1);
	assert.equal(app.branch.length, 20);
});

test("truncated, failed and malformed summaries leave originals and native fallback intact", async t => {
	for (const response of [
		{ content: [{ type: "text", text: summary }], stopReason: "length" },
		{ content: [], stopReason: "error", errorMessage: "provider unavailable" },
		{ content: [{ type: "text", text: "missing structured state" }], stopReason: "stop" },
		{ content: [{ type: "toolCall" }], stopReason: "toolUse" },
	]) {
		const app = setup(t);
		app.event("session_start");
		await app.complete(0, response);
		assert.equal(app.branch.length, 20);
		app.event("turn_end");
		assert.equal(app.calls.length, 1, "failures back off rather than retrying every tool turn");
		assert.equal(app.hook(), undefined);
		await app.status();
		assert.ok(app.notices.at(-1)?.includes("Last error:"));
	}
});

test("proactive idle swaps use an identifiable marker, not the manual /compact path", async t => {
	const branch = conversation();
	const checkpoint = checkpointFor(branch);
	const app = setup(t, [...branch, storedCheckpoint(checkpoint)]);
	app.tokens = 210_000;
	app.event("session_start");
	app.event("agent_settled");
	await new Promise(resolve => setTimeout(resolve, 15));
	assert.equal(app.compactCalls.length, 1);
	const request = app.compactCalls[0];
	const result = app.hook("manual", request.customInstructions) as { compaction?: unknown };
	assert.ok(result.compaction);
	request.onComplete();
});

test("idle swaps recheck queued messages, active runs and source validity", async t => {
	for (const mode of ["busy", "pending", "changed", "input"] as const) {
		const branch = conversation();
		const app = setup(t, [...branch, storedCheckpoint(checkpointFor(branch))]);
		app.tokens = 210_000;
		app.event("session_start");
		app.event("agent_settled");
		if (mode === "busy") app.idle = false;
		if (mode === "pending") app.pending = true;
		if (mode === "changed") app.branch[0] = entry("message-0", "user", "changed");
		if (mode === "input") app.event("input");
		await new Promise(resolve => setTimeout(resolve, 10));
		assert.equal(app.compactCalls.length, 0, mode);
	}
});

test("a checkpoint invalidated between the proactive request and its hook cancels instead of blocking", async t => {
	const branch = conversation();
	const app = setup(t, [...branch, storedCheckpoint(checkpointFor(branch))]);
	app.tokens = 210_000;
	app.event("session_start");
	app.event("agent_settled");
	await new Promise(resolve => setTimeout(resolve, 10));
	assert.equal(app.compactCalls.length, 1);
	app.branch[0] = entry("message-0", "user", "edited");
	assert.deepEqual(app.hook("manual", app.compactCalls[0].customInstructions), { cancel: true });
});

test("native auto-compaction settings refresh without a reload, abort preparation and prevent idle swaps", async t => {
	const branch = conversation();
	const app = setup(t, [...branch, storedCheckpoint(checkpointFor(branch))], true);
	app.tokens = 210_000;
	app.event("session_start");
	assert.equal(app.calls.length, 1);
	app.setNativeEnabled(false);
	app.event("turn_end");
	assert.equal(app.calls[0].signal.aborted, true);
	app.event("agent_settled");
	await app.complete();
	await new Promise(resolve => setTimeout(resolve, 10));
	assert.equal(app.compactCalls.length, 0);
	assert.equal(app.branch.filter(item => item.type === "custom" && item.customType === CHECKPOINT_TYPE).length, 1);
	app.setNativeEnabled(true);
	app.event("turn_end");
	assert.equal(app.calls.length, 2, "re-enabling does not need /reload");
});

test("the background source includes full tool outputs rather than Pi's native truncated serialization", t => {
	const longResult = "HEAD" + "x".repeat(80_000) + "IMPORTANT_TAIL_EVIDENCE";
	const branch = linkEntries([
		entry("request", "user", "Read the log and preserve the final diagnostic."),
		entry("call", "assistant", "", { content: [{ type: "toolCall", id: "read-log", name: "read", arguments: { path: "build.log" } }] }),
		entry("result", "toolResult", longResult, { toolCallId: "read-log", toolName: "read" }),
		...conversation(12, 20_000),
	]);
	const app = setup(t, branch);
	app.event("session_start");
	assert.equal(app.calls.length, 1);
	const input = app.calls[0].context.messages[0].content;
	assert.ok(input.includes(longResult));
	assert.ok(input.includes("session.jsonl"));
});

test("the extension is explicitly enabled only in main and uses an independent model configuration", () => {
	const root = path.resolve(import.meta.dirname, "../..");
	for (const profile of ["main", "librarian", "builder", "explorer", "planner", "reviewer"]) {
		const frontmatter = readFileSync(path.join(root, "agents", `${profile}.md`), "utf8").split("---")[1];
		assert.equal(frontmatter.includes("precomputed-compaction"), profile === "main", profile);
	}
	const own = JSON.parse(readFileSync(new URL("./config.json", import.meta.url), "utf8"));
	assert.equal(own.provider, "openai-codex");
	assert.equal(own.model, "gpt-6-luna");
});
