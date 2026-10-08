import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import loopExtension, { parseDuration, parseLoopArgs } from "./index.ts";
import { parseVerdict, type Verdict } from "./checker.ts";
import { isLoopActive, onLoopChange } from "../_loop_state/state.ts";
import { NON_INTERACTIVE_BANNER } from "../non-interactive/prompt.ts";

test("duration accepts ordered h/m/s components and rejects invalid values", () => {
	assert.equal(parseDuration("1h2m3s"), 3_723_000);
	assert.equal(parseDuration("1m30s"), 90_000);
	assert.equal(parseDuration("1s"), 1_000);
	for (const value of ["", "0s", "2m1h", "1m1m", "30", "25h", "1.5m", "2ms"]) {
		assert.equal(parseDuration(value), undefined, value);
	}
});

test("parses optional duration, cap and finish condition", () => {
	assert.deepEqual(parseLoopArgs("fix errors"), { intervalMs: 0, prompt: "fix errors", condition: undefined, maxRuns: undefined });
	assert.deepEqual(parseLoopArgs("1m30s --max-runs 2 fix errors --until tests pass"), {
		intervalMs: 90_000, prompt: "fix errors", condition: "tests pass", maxRuns: 2,
	});
	assert.equal(parseLoopArgs("fix errors --until tests pass").maxRuns, 20);
	for (const value of ["", "0s fix errors", "1.5m fix errors", "1m", "--max-runs 0 fix", "fix --until ", "fix --until done --until more"]) {
		assert.throws(() => parseLoopArgs(value), value);
	}
});

test("a .txt path loads the prompt once for every run", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-loop-"));
	const file = join(dir, "prompt with spaces.txt");
	try {
		await writeFile(file, "Fix errors\nwith context\n");
		const h = harness(undefined, { cwd: dir });
		await h.command('--max-runs 2 "prompt with spaces.txt"');
		assert.deepEqual(h.sent, ["Fix errors\nwith context\n"]);
		await writeFile(file, "changed later");
		await h.finish();
		h.tick(); // skip compaction for a short session
		h.tick(); // start the next run
		assert.deepEqual(h.sent, ["Fix errors\nwith context\n", "Fix errors\nwith context\n"]);
		await h.command("stop");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("missing or empty .txt files do not start a loop; prose remains a prompt", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-loop-"));
	try {
		const h = harness();
		await h.command(join(dir, "missing.txt"));
		assert.match(h.notices.at(-1) ?? "", /Unable to read prompt file/);
		assert.deepEqual(h.sent, []);
		const file = join(dir, "empty.txt");
		await writeFile(file, " \n");
		await h.command(file);
		assert.match(h.notices.at(-1) ?? "", /file is empty/);
		assert.deepEqual(h.sent, []);
		await h.command("read notes.txt");
		assert.deepEqual(h.sent, ["read notes.txt"]);
		await h.command("stop");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("checker verdict is strict and needs evidence", () => {
	assert.deepEqual(parseVerdict('{"done":true,"evidence":"typecheck passed"}'), { done: true, evidence: "typecheck passed" });
	for (const value of ["yes", "```json\n{}\n```", '{"done":"true","evidence":"ok"}', '{"done":true,"evidence":""}']) {
		assert.throws(() => parseVerdict(value), value);
	}
});

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
function harness(
	check?: (condition: string, output: string, ctx: ExtensionContext, signal: AbortSignal) => Promise<Verdict>,
	options: { mode?: "tui" | "rpc" | "print"; autoStart?: boolean; compact?: "complete" | "small" | "fail" | "pending"; contextTokens?: number; cwd?: string } = {},
) {
	const handlers = new Map<string, Handler>();
	const sent: string[] = [];
	const rawSent: string[] = [];
	const notices: string[] = [];
	const timers = new Map<number, { callback: () => void; delay: number }>();
	let nextTimer = 0;
	let busy = false;
	let pending = false;
	let compactions = 0;
	let finishCompaction: (() => void) | undefined;
	let handler: ((args: string, ctx: ExtensionContext) => Promise<void>) | undefined;
	const ctx = {
		mode: options.mode ?? "tui",
		cwd: options.cwd ?? process.cwd(),
		ui: { setStatus: () => {} },
		isIdle: () => !busy,
		hasPendingMessages: () => pending,
		getContextUsage: () => options.contextTokens === undefined ? undefined : {
			tokens: options.contextTokens, contextWindow: 128_000, percent: options.contextTokens / 1_280,
		},
		compact: (callbacks: { onComplete?: () => void; onError?: (error: Error) => void }) => {
			compactions++;
			if (options.compact === "small") callbacks.onError?.(new Error("Nothing to compact (session too small)"));
			else if (options.compact === "fail") callbacks.onError?.(new Error("provider failed"));
			else if (options.compact === "pending") finishCompaction = () => callbacks.onComplete?.();
			else callbacks.onComplete?.();
		},
	} as unknown as ExtensionContext;
	const pi = {
		getSettings: () => ({ compaction: { keepRecentTokens: 20_000 } }),
		on: (name: string, callback: Handler) => { handlers.set(name, callback); },
		registerCommand: (name: string, options: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => {
			assert.equal(name, "loop");
			handler = options.handler;
		},
		sendUserMessage: (prompt: string) => {
			rawSent.push(prompt);
			sent.push(prompt.replace(`${NON_INTERACTIVE_BANNER}\n\n`, ""));
			busy = true;
			if (options.autoStart !== false) void handlers.get("agent_start")?.({}, ctx);
		},
		sendMessage: (message: { content: string }) => { notices.push(message.content); },
	} as unknown as ExtensionAPI;
	loopExtension(pi, {
		check,
		setTimer: (callback, delay) => {
			const id = ++nextTimer;
			timers.set(id, { callback, delay });
			return id as unknown as ReturnType<typeof setTimeout>;
		},
		clearTimer: (id) => { timers.delete(id as unknown as number); },
	});
	return {
		sent, rawSent, notices, timers,
		compactions: () => compactions,
		finishCompaction: () => finishCompaction?.(),
		setBusy: (value: boolean) => { busy = value; },
		setPending: (value: boolean) => { pending = value; },
		command: async (args: string) => { assert.ok(handler); await handler(args, ctx); },
		input: async (source: "interactive" | "rpc", text: string) => {
			await handlers.get("input")?.({ source, text }, ctx);
		},
		emit: async (name: string, event: unknown = {}) => {
			const callback = handlers.get(name);
			assert.ok(callback, name);
			return callback(event, ctx);
		},
		finish: async (output = "work complete", reason = "stop") => {
			busy = false;
			await handlers.get("agent_end")?.({ messages: [{ role: "assistant", stopReason: reason, content: [{ type: "text", text: output }] }] }, ctx);
			await handlers.get("agent_settled")?.({}, ctx);
		},
		tick: () => {
			const [id, timer] = [...timers][0] ?? [];
			assert.ok(timer);
			timers.delete(id);
			timer.callback();
			return timer.delay;
		},
	};
}

test("loop signals its entire lifetime and instructs each iteration not to ask questions", async () => {
	const transitions: boolean[] = [];
	onLoopChange("loop-test", (active) => transitions.push(active));
	const h = harness();
	await h.command("--max-runs 2 fix errors");
	assert.equal(isLoopActive(), true);
	assert.equal(h.rawSent[0], `${NON_INTERACTIVE_BANNER}\n\nfix errors`);
	await h.finish();
	assert.equal(isLoopActive(), true); // still live while waiting and compacting
	h.tick();
	h.tick();
	assert.equal(h.rawSent[1], `${NON_INTERACTIVE_BANNER}\n\nfix errors`);
	await h.finish();
	assert.equal(isLoopActive(), false);
	assert.deepEqual(transitions, [true, false]);
});

test("runs immediately, waits until settled, then schedules next run without duration", async () => {
	const h = harness();
	await h.command("--max-runs 2 fix errors");
	assert.deepEqual(h.sent, ["fix errors"]);
	assert.equal(h.timers.size, 0);
	await h.finish();
	assert.equal(h.tick(), 0); // compact after the first run
	assert.deepEqual(h.sent, ["fix errors"]);
	assert.equal(h.compactions(), 1);
	assert.equal(h.tick(), 0); // next run follows compaction
	assert.deepEqual(h.sent, ["fix errors", "fix errors"]);
	await h.finish();
	assert.equal(h.timers.size, 0);
	assert.match(h.notices.at(-1) ?? "", /maximum of 2/);
});

test("duration applies after settled and defers while another turn is busy", async () => {
	const h = harness();
	await h.command("1m30s fix errors");
	await h.finish();
	h.setBusy(true);
	assert.equal(h.tick(), 90_000);
	assert.deepEqual(h.sent, ["fix errors"]);
	h.setBusy(false);
	h.setPending(true);
	assert.equal(h.tick(), 1_000);
	h.setPending(false);
	assert.equal(h.tick(), 1_000);
	assert.equal(h.compactions(), 1);
	assert.equal(h.tick(), 0);
	assert.equal(h.sent.length, 2);
	await h.command("stop");
	assert.equal(h.timers.size, 0);
});

test("until checker sees final response and stops only on done", async () => {
	const calls: string[] = [];
	const h = harness(async (condition, output) => {
		calls.push(`${condition}: ${output}`);
		return { done: calls.length === 2, evidence: "confirmed by check" };
	});
	await h.command("fix errors --until tests pass");
	await h.finish("first result");
	assert.equal(h.tick(), 0);
	assert.equal(h.tick(), 0);
	await h.finish("second result");
	assert.deepEqual(calls, ["tests pass: first result", "tests pass: second result"]);
	assert.equal(h.timers.size, 0);
	assert.match(h.notices.at(-1) ?? "", /Loop complete after 2 run/);
});

test("small context skips unnecessary compaction attempts", async () => {
	const h = harness(undefined, { contextTokens: 2_000 });
	await h.command("--max-runs 2 work");
	await h.finish();
	assert.equal(h.tick(), 0);
	assert.equal(h.compactions(), 0);
	assert.equal(h.tick(), 0);
	assert.equal(h.sent.length, 2);
	await h.finish();
});

test("too-small compaction is skipped; other failures stop the loop", async () => {
	const small = harness(undefined, { compact: "small" });
	await small.command("--max-runs 2 work");
	await small.finish();
	assert.equal(small.tick(), 0);
	assert.equal(small.tick(), 0);
	assert.equal(small.sent.length, 2);
	await small.finish();

	const failed = harness(undefined, { compact: "fail" });
	await failed.command("work");
	await failed.finish();
	failed.tick();
	assert.equal(failed.sent.length, 1);
	assert.equal(failed.timers.size, 0);
	assert.match(failed.notices.at(-1) ?? "", /compaction failed/);
});

test("stop during compaction invalidates its eventual callback", async () => {
	const h = harness(undefined, { compact: "pending" });
	await h.command("work");
	await h.finish();
	h.tick();
	await h.command("stop");
	h.finishCompaction();
	assert.equal(h.timers.size, 0);
	assert.equal(h.sent.length, 1);
});

test("checker error and aborted iteration fail closed", async () => {
	const h = harness(async () => { throw new Error("unavailable"); });
	await h.command("work --until good");
	await h.finish();
	assert.equal(h.timers.size, 0);
	assert.match(h.notices.at(-1) ?? "", /completion check failed/);
	await h.command("work");
	await h.finish("oops", "error");
	assert.equal(h.timers.size, 0);
	assert.match(h.notices.at(-1) ?? "", /iteration failed/);
});

test("user messages do not stop a running or waiting loop", async () => {
	for (const source of ["interactive", "rpc"] as const) {
		const h = harness(undefined, { contextTokens: 2_000 });
		await h.command("1m work");
		await h.input(source, "additional instructions");
		await h.finish();
		assert.equal(h.timers.size, 1);
		await h.input(source, "a new task");
		h.setPending(true);
		assert.equal(h.tick(), 60_000);
		h.setPending(false);
		assert.equal(h.tick(), 1_000);
		assert.equal(h.tick(), 0);
		assert.deepEqual(h.sent, ["work", "work"]);
		await h.command("stop");
		assert.equal(h.timers.size, 0);
	}
});

test("stop and session shutdown invalidate timers", async () => {
	const h = harness();
	await h.command("work");
	await h.finish();
	await h.command("stop");
	assert.equal(h.timers.size, 0);
	await h.command("work");
	await h.finish();
	await h.emit("session_shutdown");
	assert.equal(h.timers.size, 0);
});

test("session startup clears a loop signal left by a reloaded extension", async () => {
	const h = harness();
	await h.command("work");
	const reloaded = harness();
	await reloaded.emit("session_start");
	assert.equal(isLoopActive(), false);
	await h.command("stop");
});

test("a turn that never starts stops instead of leaving the loop armed", async () => {
	const h = harness(undefined, { autoStart: false });
	await h.command("work");
	assert.equal(h.tick(), 60_000);
	assert.match(h.notices.at(-1) ?? "", /did not start/);
	assert.equal(h.timers.size, 0);
});

test("print mode cannot silently start an unobserved loop", async () => {
	const h = harness(undefined, { mode: "print" });
	const original = console.error;
	const errors: string[] = [];
	console.error = (message: string) => { errors.push(message); };
	try { await h.command("work"); } finally { console.error = original; }
	assert.equal(h.sent.length, 0);
	assert.match(errors[0], /interactive Pi/);
});

test("stop during checker aborts it and cannot schedule a stale next run", async () => {
	let resolveCheck: ((verdict: Verdict) => void) | undefined;
	let signal: AbortSignal | undefined;
	const h = harness(async (_condition, _output, _ctx, controller) => {
		signal = controller;
		return new Promise<Verdict>((resolve) => { resolveCheck = resolve; });
	});
	await h.command("work --until done");
	h.setBusy(false);
	await h.emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "ok" }] }] });
	const settling = h.emit("agent_settled");
	await h.command("stop");
	assert.equal(signal?.aborted, true);
	resolveCheck?.({ done: false, evidence: "not yet" });
	await settling;
	assert.equal(h.timers.size, 0);
});
