import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import loopExtension, { parseDuration, parseLoopArgs } from "./index.ts";
import { parseVerdict, type Verdict } from "./checker.ts";

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

test("checker verdict is strict and needs evidence", () => {
	assert.deepEqual(parseVerdict('{"done":true,"evidence":"typecheck passed"}'), { done: true, evidence: "typecheck passed" });
	for (const value of ["yes", "```json\n{}\n```", '{"done":"true","evidence":"ok"}', '{"done":true,"evidence":""}']) {
		assert.throws(() => parseVerdict(value), value);
	}
});

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
function harness(
	check?: (condition: string, output: string, ctx: ExtensionContext, signal: AbortSignal) => Promise<Verdict>,
	options: { mode?: "tui" | "rpc" | "print"; autoStart?: boolean } = {},
) {
	const handlers = new Map<string, Handler>();
	const sent: string[] = [];
	const notices: string[] = [];
	const timers = new Map<number, { callback: () => void; delay: number }>();
	let nextTimer = 0;
	let busy = false;
	let pending = false;
	let handler: ((args: string, ctx: ExtensionContext) => Promise<void>) | undefined;
	const ctx = {
		mode: options.mode ?? "tui",
		cwd: process.cwd(),
		ui: { setStatus: () => {} },
		isIdle: () => !busy,
		hasPendingMessages: () => pending,
	} as unknown as ExtensionContext;
	const pi = {
		on: (name: string, callback: Handler) => { handlers.set(name, callback); },
		registerCommand: (name: string, options: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => {
			assert.equal(name, "loop");
			handler = options.handler;
		},
		sendUserMessage: (prompt: string) => {
			sent.push(prompt);
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
		sent, notices, timers,
		setBusy: (value: boolean) => { busy = value; },
		setPending: (value: boolean) => { pending = value; },
		command: async (args: string) => { assert.ok(handler); await handler(args, ctx); },
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

test("runs immediately, waits until settled, then schedules next run without duration", async () => {
	const h = harness();
	await h.command("--max-runs 2 fix errors");
	assert.deepEqual(h.sent, ["fix errors"]);
	assert.equal(h.timers.size, 0);
	await h.finish();
	assert.equal(h.tick(), 0);
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
	await h.finish("second result");
	assert.deepEqual(calls, ["tests pass: first result", "tests pass: second result"]);
	assert.equal(h.timers.size, 0);
	assert.match(h.notices.at(-1) ?? "", /Loop complete after 2 run/);
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

test("stop, new input and session shutdown invalidate timers", async () => {
	const h = harness();
	await h.command("work");
	await h.finish();
	await h.command("stop");
	assert.equal(h.timers.size, 0);
	await h.command("work");
	await h.emit("input", { source: "rpc", text: "a new task" });
	await h.finish();
	assert.equal(h.timers.size, 0);
	await h.command("work");
	await h.finish();
	await h.emit("session_shutdown");
	assert.equal(h.timers.size, 0);
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
