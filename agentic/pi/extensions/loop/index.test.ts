import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { setImmediate as settle } from "node:timers/promises";
import net from "node:net";
import { once } from "node:events";
import remoteControl from "../remote-control/index.ts";
import { markGuard } from "../_remote_bridge/guards.ts";
import { invokeRemoteCommand } from "../_remote_bridge/commands.ts";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import loopExtension, { parseDuration, parseLoopArgs } from "./index.ts";
import { loopHandoffEnv } from "../git-worktree-isolation/index.ts";
import { createLaunchPlan, prepareBranchReturn } from "../git-worktree-isolation/git.ts";
import { checkCondition, parseVerdict, type Verdict } from "./checker.ts";
import { getLoopHandoff, isLoopActive, LOOP_HANDOFF_ENV, LOOP_MAIN_DIRTY, onLoopChange, onLoopCompletion, currentLoopCompletion, setLoopReturnToBase, suspendLoopForHandoff } from "../_loop_state/state.ts";
import notifyExtension from "../notify/index.ts";
import rateLimitRetry from "../rate-limit-retry/index.ts";
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
	assert.equal(parseLoopArgs("fix errors --until tests pass").maxRuns, undefined);
	for (const value of ["", "0s fix errors", "1.5m fix errors", "1m", "--max-runs 0 fix", "fix --until ", "fix --until done --until more"]) {
		assert.throws(() => parseLoopArgs(value), value || "empty arguments");
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

test("@-prefixed .txt paths load prompts with relative, quoted, and absolute paths", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-loop-"));
	try {
		const file = join(dir, "prompt with spaces.txt");
		await writeFile(file, "Fix errors from file");
		await writeFile(join(dir, "prompt.txt"), "Fix errors from file");
		const h = harness(undefined, { cwd: dir });
		for (const path of ["@prompt.txt", '@"prompt with spaces.txt"', `@${join(dir, "prompt.txt")}`]) {
			await h.command(path);
			assert.equal(h.sent.at(-1), "Fix errors from file");
			await h.finish();
			await h.command("stop");
		}
		await h.command("@missing.txt");
		assert.match(h.notices.at(-1) ?? "", /Unable to read prompt file missing\.txt/);
		assert.equal(h.sent.length, 3);
		await h.command("read @prompt.txt");
		assert.equal(h.sent.at(-1), "read @prompt.txt");
		await h.command("stop");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("~/ prompt paths expand home with optional @ and quotes", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-loop-"));
	const originalHome = process.env.HOME;
	try {
		const home = join(dir, "home");
		const cwd = join(dir, "cwd");
		await mkdir(home);
		await mkdir(cwd);
		await writeFile(join(home, "prompt.txt"), "Prompt from home");
		await writeFile(join(home, "prompt with spaces.txt"), "Prompt from home");
		await writeFile(join(home, "empty.txt"), " \n");
		process.env.HOME = home;
		const h = harness(undefined, { cwd });
		for (const path of ["@~/prompt.txt", "~/prompt.txt", '@"~/prompt with spaces.txt"', "'~/prompt with spaces.txt'"]) {
			await h.command(path);
			assert.equal(h.sent.at(-1), "Prompt from home");
			await h.finish();
			await h.command("stop");
		}
		await h.command("@~/missing.txt");
		assert.match(h.notices.at(-1) ?? "", /Unable to read prompt file ~\/missing\.txt/);
		await h.command("@~/empty.txt");
		assert.match(h.notices.at(-1) ?? "", /file is empty/);
		assert.equal(h.sent.length, 4);
		await h.command("read @~/prompt.txt");
		assert.equal(h.sent.at(-1), "read @~/prompt.txt");
		await h.command("stop");
	} finally {
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
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

test("checker process receives the full loop prompt as reference context", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-loop-checker-"));
	const originalPath = process.env.PATH;
	try {
		await writeFile(join(dir, "pi"), `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync("checker-args.json", JSON.stringify(process.argv.slice(2)));
console.log(JSON.stringify({ done: true, evidence: "verified" }));
`, { mode: 0o755 });
		process.env.PATH = `${dir}:${originalPath ?? ""}`;
		const prompt = `First requirement\n${"details ".repeat(1_500)}\nLast requirement`;
		const output = `Old output${"x".repeat(8_000)}Latest result`;
		const ctx = { cwd: dir } as ExtensionContext;
		assert.deepEqual(await checkCondition("all requirements in the loop prompt are met", prompt, output, ctx, new AbortController().signal), {
			done: true, evidence: "verified",
		});
		const args = JSON.parse(await readFile(join(dir, "checker-args.json"), "utf8")) as string[];
		assert.ok(args.includes("--no-session"));
		const request = args.at(-1)!;
		assert.ok(request.includes(prompt), "the loop prompt is not truncated");
		assert.ok(request.includes("all requirements in the loop prompt are met"));
		assert.ok(request.includes(output.slice(-8_000)), "the checker receives the latest result");
	} finally {
		if (originalPath === undefined) delete process.env.PATH;
		else process.env.PATH = originalPath;
		await rm(dir, { recursive: true, force: true });
	}
});

test("checker keeps the captured file prompt across iterations", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-loop-"));
	const prompts: string[] = [];
	const h = harness(async (_condition, prompt) => {
		prompts.push(prompt);
		return { done: prompts.length === 2, evidence: "checked requirements" };
	}, { cwd: dir, contextTokens: 2_000 });
	try {
		await writeFile(join(dir, "prompt.txt"), "Implement the two requirements\nKeep this context\n");
		await h.command("prompt.txt --until both requirements are met");
		await writeFile(join(dir, "prompt.txt"), "Replacement instructions");
		await h.finish();
		h.tick();
		h.tick();
		await h.finish();
		assert.deepEqual(prompts, Array(2).fill("Implement the two requirements\nKeep this context\n"));
	} finally {
		await h.command("stop");
		await rm(dir, { recursive: true, force: true });
	}
});

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
type CompactionCallbacks = { onComplete?: () => void; onError?: (error: Error) => void };
function harness(
	check?: typeof checkCondition,
	options: { sessionId?: string; plugins?: Array<(pi: ExtensionAPI) => void>; notifications?: string[]; mode?: "tui" | "rpc" | "print"; autoStart?: boolean; compact?: "complete" | "small" | "fail" | "pending" | "rateOnce" | ((callbacks: CompactionCallbacks, attempt: number) => void); contextTokens?: number; cwd?: string; listIssues?: (cwd: string, signal?: AbortSignal) => Promise<number[]> } = {},
) {
	const handlers = new Map<string, Handler[]>();
	const emit = async (name: string, event: unknown = {}) => {
		let result: unknown;
		for (const callback of handlers.get(name) ?? []) {
			const value = await callback(event, ctx);
			if (value !== undefined) result = value;
			// Pi applies message_end replacements before the agent sees the result.
			if (name === "message_end" && value && typeof value === "object" && "message" in value) {
				Object.assign((event as { message: object }).message, value.message);
			}
		}
		return result;
	};
	const sent: string[] = [];
	const rawSent: string[] = [];
	const notices: string[] = [];
	const statuses: (string | undefined)[] = [];
	const timers = new Map<number, { callback: () => void; delay: number }>();
	const intervals = new Map<number, () => void>();
	let clock = 0;
	let nextTimer = 0;
	let busy = false;
	let pending = false;
	let compactions = 0;
	let finishCompaction: (() => void) | undefined;
	const commands = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>();
	const ctx = {
		hasUI: true,
		mode: options.mode ?? "tui",
		cwd: options.cwd ?? process.cwd(),
		sessionManager: { getSessionId: () => options.sessionId ?? "loop-fixture", getSessionFile: () => "/tmp/pi-loop-handoff-session.jsonl", buildSessionProjection: () => ({ messages: [] }) },
		ui: { setStatus: (_key: string, value?: string) => { statuses.push(value); } },
		isIdle: () => !busy,
		hasPendingMessages: () => pending,
		getContextUsage: () => options.contextTokens === undefined ? undefined : {
			tokens: options.contextTokens, contextWindow: 128_000, percent: options.contextTokens / 1_280,
		},
		compact: (callbacks: CompactionCallbacks) => {
			compactions++;
			if (typeof options.compact === "function") options.compact(callbacks, compactions);
			else if (options.compact === "rateOnce" && compactions === 1) callbacks.onError?.(new Error('429: {"detail":"Rate limit exceeded"}'));
			else if (options.compact === "small") callbacks.onError?.(new Error("Nothing to compact (session too small)"));
			else if (options.compact === "fail") callbacks.onError?.(new Error("provider failed"));
			else if (options.compact === "pending") finishCompaction = () => callbacks.onComplete?.();
			else callbacks.onComplete?.();
		},
	} as unknown as ExtensionContext;
	const pi = {
		getCommands: () => [],
		getSessionName: () => "Loop fixture",
		getThinkingLevel: () => "off",
		getSettings: () => ({ compaction: { keepRecentTokens: 20_000 } }),
		on: (name: string, callback: Handler) => { handlers.set(name, [...handlers.get(name) ?? [], callback]); },
		events: { on: () => {}, emit: () => {} },
		registerCommand: (name: string, options: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => {
			assert.ok(name === "loop" || name === "implement-all-issues" || name === "rate-limit-retry");
			commands.set(name, options.handler);
		},
		sendUserMessage: (prompt: string) => {
			rawSent.push(prompt);
			sent.push(prompt.replace(`${NON_INTERACTIVE_BANNER}\n\n`, ""));
			busy = true;
			if (options.autoStart !== false) void emit("agent_start");
		},
		sendMessage: (message: { content: string }) => { notices.push(message.content); },
	} as unknown as ExtensionAPI;
	loopExtension(pi, {
		check,
		listIssues: options.listIssues ?? (async () => [2, 4]),
		setTimer: (callback, delay) => {
			const id = ++nextTimer;
			timers.set(id, { callback, delay });
			return id as unknown as ReturnType<typeof setTimeout>;
		},
		clearTimer: (id) => { timers.delete(id as unknown as number); },
		setInterval: (callback, delay) => {
			assert.equal(delay, 1_000);
			const id = ++nextTimer;
			intervals.set(id, callback);
			return id as unknown as ReturnType<typeof setInterval>;
		},
		clearInterval: (id) => { intervals.delete(id as unknown as number); },
		now: () => clock,
	});
	for (const plugin of options.plugins ?? []) plugin(pi);
	if (options.notifications) notifyExtension(pi, (title) => { options.notifications!.push(title); });
	return {
		sent, rawSent, notices, statuses, timers, intervals,
		advance: (ms: number) => { clock += ms; for (const callback of [...intervals.values()]) callback(); },
		compactions: () => compactions,
		finishCompaction: () => finishCompaction?.(),
		setBusy: (value: boolean) => { busy = value; },
		setPending: (value: boolean) => { pending = value; },
		command: async (args: string, name = "loop") => {
			const handler = commands.get(name);
			assert.ok(handler, name);
			await handler(args, ctx);
		},
		remoteCommand: (args: string, name = "implement-all-issues") => invokeRemoteCommand(name, args, ctx),
		input: async (source: "interactive" | "rpc", text: string) => {
			await emit("input", { source, text });
		},
		emit: async (name: string, event: unknown = {}) => {
			assert.ok(handlers.has(name), name);
			return emit(name, event);
		},
		finish: async (output = "work complete", reason = "stop") => {
			busy = false;
			await emit("agent_end", { messages: [{ role: "assistant", stopReason: reason, content: [{ type: "text", text: output }] }] });
			await emit("agent_settled");
		},
		tick: () => {
			const [id, timer] = [...timers][0] ?? [];
			assert.ok(timer);
			timers.delete(id);
			clock += timer.delay;
			timer.callback();
			return timer.delay;
		},
	};
}

test("opaque Codex Bad Request recovery keeps the loop in the same iteration", async () => {
	const delays: number[] = [];
	const h = harness(undefined, { plugins: [(pi) => rateLimitRetry(pi, async (delay) => {
		delays.push(delay);
		return true;
	})] });
	await h.command("--max-runs 1 finish the task");
	const failed = { message: {
		role: "assistant", provider: "openai-codex", stopReason: "error",
		errorMessage: '{"detail":"Bad Request"}', content: [],
	} };
	await h.emit("message_start", { message: { ...failed.message } });
	await h.emit("message_end", failed);
	assert.equal(failed.message.stopReason, "stop");
	const continuation = await h.emit("turn_end") as { continue: boolean; entries: Array<{ display: boolean }> };
	assert.equal(continuation.continue, true);
	assert.equal(continuation.entries[0].display, false);
	assert.deepEqual(delays, [2000]);
	await h.emit("message_end", { message: {
		role: "assistant", stopReason: "stop", content: [{ type: "text", text: "task finished" }],
	} });
	assert.equal(await h.emit("turn_end"), undefined);
	await h.finish("task finished");
	assert.deepEqual(h.sent, ["finish the task"], "recovery must not rerun the iteration prompt");
	assert.match(h.notices.at(-1) ?? "", /Loop complete after 1 run/);
	assert.ok(!h.notices.some((notice) => /iteration failed/.test(notice)));
});

test("persistent opaque Codex Bad Requests still stop the loop after bounded recovery", async () => {
	const h = harness(undefined, { plugins: [(pi) => rateLimitRetry(pi, async () => true)] });
	await h.command("finish the task");
	for (let attempt = 0; attempt < 4; attempt++) {
		const failed = { message: {
			role: "assistant", provider: "openai-codex", stopReason: "error",
			errorMessage: '{"detail":"Bad Request"}', content: [],
		} };
		await h.emit("message_end", failed);
		const continuation = await h.emit("turn_end") as { continue: boolean } | undefined;
		assert.equal(continuation?.continue, attempt < 3 ? true : undefined);
		assert.equal(failed.message.stopReason, attempt < 3 ? "stop" : "error");
	}
	await h.finish("", "error");
	assert.match(h.notices.at(-1) ?? "", /Loop stopped: iteration failed/);
	assert.equal(h.sent.length, 1);
});

for (const remote of [false, true]) {
	test(`implement-all-issues appends literal instructions to every ${remote ? "remote" : "local"} iteration`, async () => {
		const instruction = "Write PR descriptions in Danish.\nKeep --until and --max-runs literal; do not merge.";
		const checks: string[] = [];
		const h = harness(async (condition) => {
			checks.push(condition);
			return { done: false, evidence: "another issue remains" };
		}, { contextTokens: 2_000, mode: remote ? "rpc" : "tui" });
		try {
			if (remote) await h.remoteCommand(`  ${instruction}  `);
			else await h.command(`  ${instruction}  `, "implement-all-issues");
			await h.finish("PR created");
			h.tick();
			h.tick();
			await Promise.resolve();
			assert.equal(h.sent.length, 2);
			for (const prompt of h.sent) {
				assert.ok(prompt.includes(instruction), "each iteration receives the user's literal instructions");
			}
			assert.equal(checks.length, 1);
			assert.ok(!checks[0]!.includes(instruction));
		} finally {
			await h.command("stop");
		}
	});
}

test("an unfinished issue continues to another issue, then stops when no work remains", async () => {
	let checks = 0;
	let selections = 0;
	const outcomes: string[] = [];
	const unsubscribe = onLoopCompletion("issue-handoff-test", (completion) => { outcomes.push(completion.outcome); });
	const h = harness(async () => ({
		done: ++checks > 1,
		evidence: checks > 1 ? "no actionable issues remain" : "another issue remains",
	}), { contextTokens: 2_000, listIssues: async () => { selections++; return [2, 4]; } });
	try {
		await h.command("", "implement-all-issues");
		await h.finish("Checkpointed unfinished work and released the issue assignment.");
		assert.equal(isLoopActive(), true);
		assert.deepEqual(outcomes, [], "unfinished work is not loop completion");
		h.tick();
		h.tick();
		await Promise.resolve();
		assert.equal(h.sent.length, 2);
		assert.equal(selections, 2, "the next iteration fetches fresh candidates");
		await h.finish("The remaining issue was delivered.");
		assert.equal(checks, 2);
		assert.equal(isLoopActive(), false);
		assert.deepEqual(outcomes, ["finished"]);
		assert.equal(h.timers.size, 0);
	} finally {
		unsubscribe();
		await h.command("stop");
	}
});

test("blank instructions preserve the default issue prompt", async () => {
	const h = harness();
	await h.command("", "implement-all-issues");
	const prompt = h.sent[0];
	await h.command("stop");
	h.setBusy(false);
	await h.command(" \n\t ", "implement-all-issues");
	assert.equal(h.sent[1], prompt);
	await h.command("stop");
});

test("issue selection refreshes eligible candidates for each iteration", async () => {
	let calls = 0;
	const h = harness(async () => ({ done: false, evidence: "another leaf remains" }), {
		contextTokens: 2_000,
		listIssues: async () => ++calls === 1 ? [12] : [14],
	});
	await h.command("", "implement-all-issues");
	assert.match(h.sent[0] ?? "", /#12\b/);
	await h.finish("PR created");
	h.tick(); // short context skips compaction
	h.tick(); // fetch next candidate
	await Promise.resolve();
	assert.equal(calls, 2);
	assert.match(h.sent[1] ?? "", /#14\b/);
	assert.doesNotMatch(h.sent[1] ?? "", /#12\b/);
	await h.command("stop");
});

test("a user turn during issue selection cannot complete or duplicate the issue run", async () => {
	let resolveSelection: ((issues: number[]) => void) | undefined;
	let lookups = 0;
	const h = harness(undefined, {
		listIssues: async () => {
			lookups++;
			return new Promise<number[]>((resolve) => { resolveSelection = resolve; });
		},
	});
	await h.command("", "implement-all-issues");
	assert.equal(h.sent.length, 0);
	assert.match(h.statuses.at(-1) ?? "", /selecting/);
	await h.finish("another user turn finished");
	assert.equal(h.timers.size, 0, "the unrelated turn must not schedule another issue");
	h.setBusy(true);
	resolveSelection?.([7]);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(h.sent.length, 0);
	assert.equal(h.timers.size, 1);
	h.setBusy(false);
	h.setPending(true);
	h.tick();
	assert.equal(h.sent.length, 0);
	h.setPending(false);
	h.tick();
	assert.equal(h.sent.length, 1);
	assert.match(h.sent[0] ?? "", /#7\b/);
	assert.equal(lookups, 1);
	await h.command("stop");
});

test("a GitHub unexpected EOF pauses and retries selection without consuming another iteration", async () => {
	let attempts = 0;
	const h = harness(undefined, {
		listIssues: async () => {
			if (++attempts === 1) throw new Error('Command failed: gh api graphql\nPost "https://api.github.com/graphql": unexpected EOF');
			return [17];
		},
	});
	try {
		await h.command("", "implement-all-issues");
		assert.equal(isLoopActive(), true, "a dropped GitHub connection must not stop the loop");
		assert.equal(h.sent.length, 0, "never guess candidates after a failed fetch");
		assert.match(h.statuses.at(-1) ?? "", /GitHub unavailable.*1m/);
		assert.equal(h.tick(), 60_000);
		await settle();
		assert.equal(attempts, 2);
		assert.equal(h.sent.length, 1);
		assert.match(h.sent[0] ?? "", /#17\b/);
		await h.command("status");
		assert.match(h.notices.at(-1) ?? "", /run 1,/);
	} finally {
		await h.command("stop");
	}
});

for (const failure of [
	new Error('Get "https://api.github.com/graphql": EOF'),
	new Error("gh: Bad Gateway (HTTP 502)"),
	new Error("gh: Service Unavailable (HTTP 503)"),
	Object.assign(new Error("gh exited"), { stderr: "read: connection reset by peer" }),
	Object.assign(new Error("gh exited"), { code: "ETIMEDOUT" }),
	Object.assign(new Error("gh timed out"), { killed: true, signal: "SIGTERM" }),
	new Error("API rate limit exceeded (HTTP 403)"),
]) {
	test(`transient GitHub selection failures wait rather than stop: ${failure.message}`, async () => {
		const h = harness(undefined, { listIssues: async () => { throw failure; } });
		try {
			await h.command("", "implement-all-issues");
			assert.equal(isLoopActive(), true);
			assert.equal(h.sent.length, 0);
			assert.equal(h.timers.size, 1);
			assert.equal(h.intervals.size, 1);
		} finally {
			await h.command("stop");
		}
	});
}

for (const failure of ["gh: Bad credentials (HTTP 401)", "gh: Resource not accessible (HTTP 403)",
	"GraphQL: syntax error", "GitHub omitted or returned invalid assignment or sub-issue completion counts.",
	"Unexpected end of JSON input"]) {
	test(`non-transient GitHub selection errors still fail closed: ${failure}`, async () => {
		const h = harness(undefined, { listIssues: async () => { throw new Error(failure); } });
		await h.command("", "implement-all-issues");
		assert.equal(isLoopActive(), false);
		assert.equal(h.sent.length, 0);
		assert.equal(h.timers.size, 0);
		assert.match(h.notices.at(-1) ?? "", /issue selection failed/);
	});
}

test("persistent GitHub outages use capped backoff without incrementing the run counter", async () => {
	let attempts = 0;
	const h = harness(undefined, { listIssues: async () => { attempts++; throw new Error("unexpected EOF"); } });
	try {
		await h.command("", "implement-all-issues");
		for (const delay of [60_000, 120_000, 240_000, 300_000, 300_000]) {
			assert.equal(h.tick(), delay);
			await settle();
			assert.equal(isLoopActive(), true);
		}
		assert.equal(attempts, 6);
		assert.equal(h.sent.length, 0);
		await h.command("status");
		assert.match(h.notices.at(-1) ?? "", /run 1,/);
	} finally {
		await h.command("stop");
	}
});

for (const shutdown of [false, true]) {
	test(`GitHub retry backoff is cancelled by ${shutdown ? "session shutdown" : "stop"}`, async () => {
		let attempts = 0;
		const h = harness(undefined, { listIssues: async () => { attempts++; throw new Error("unexpected EOF"); } });
		await h.command("", "implement-all-issues");
		const staleRetry = [...h.timers.values()][0]?.callback;
		assert.ok(staleRetry);
		if (shutdown) await h.emit("session_shutdown");
		else await h.command("stop");
		assert.equal(h.timers.size, 0);
		assert.equal(h.intervals.size, 0);
		staleRetry();
		await settle();
		assert.equal(attempts, 1);
		assert.equal(h.sent.length, 0);
		assert.equal(isLoopActive(), false);
	});
}

test("stopping a retried in-flight GitHub fetch aborts it and discards a late response", async () => {
	let attempts = 0;
	let signal: AbortSignal | undefined;
	let resolveSelection: ((issues: number[]) => void) | undefined;
	const h = harness(undefined, { listIssues: async (_cwd, nextSignal) => {
		if (++attempts === 1) throw new Error("unexpected EOF");
		signal = nextSignal;
		return new Promise<number[]>((resolve) => { resolveSelection = resolve; });
	} });
	await h.command("", "implement-all-issues");
	h.tick();
	await settle();
	assert.equal(signal?.aborted, false);
	await h.command("stop");
	assert.equal(signal?.aborted, true);
	resolveSelection?.([42]);
	await settle();
	assert.equal(h.sent.length, 0);
	assert.equal(h.timers.size, 0);
});

test("GitHub outages during completion checking retry the check, not the implementation", async () => {
	let checks = 0;
	let selections = 0;
	const h = harness(async () => {
		if (++checks === 1) throw new Error("unexpected EOF");
		return { done: true, evidence: "no actionable issues remain" };
	}, { listIssues: async () => {
		if (++selections === 1) throw new Error("unexpected EOF");
		return [42];
	} });
	await h.command("", "implement-all-issues");
	assert.equal(h.tick(), 60_000);
	await settle();
	await h.finish("PR created");
	assert.equal(isLoopActive(), true);
	assert.match(h.statuses.at(-1) ?? "", /GitHub unavailable/);
	assert.equal(h.tick(), 60_000, "successful selection resets the retry backoff");
	await settle();
	assert.equal(checks, 2);
	assert.equal(selections, 2);
	assert.equal(h.sent.length, 1);
	assert.equal(isLoopActive(), false);
	assert.match(h.notices.at(-1) ?? "", /Loop complete after 1 run/);
});

test("GitHub selection errors stop the issue loop without guessing a parent", async () => {
	const h = harness(undefined, {
		listIssues: async () => { throw new Error("GitHub sub-issues unavailable"); },
	});
	await h.command("", "implement-all-issues");
	assert.deepEqual(h.sent, []);
	assert.equal(isLoopActive(), false);
	assert.match(h.notices.at(-1) ?? "", /issue selection failed.*GitHub sub-issues unavailable/);
});

test("stopping during GitHub selection cannot send a stale issue prompt", async () => {
	let resolveSelection: ((issues: number[]) => void) | undefined;
	const h = harness(undefined, {
		listIssues: async () => new Promise<number[]>((resolve) => { resolveSelection = resolve; }),
	});
	await h.command("", "implement-all-issues");
	await h.command("stop");
	resolveSelection?.([9]);
	await Promise.resolve();
	assert.deepEqual(h.sent, []);
	assert.equal(h.timers.size, 0);
});

test("a branch relaunch resumes the running issue iteration, then checks completion", async () => {
	const original = process.env[LOOP_HANDOFF_ENV];
	const parent = harness();
	try {
		await parent.command("", "implement-all-issues");
		const snapshot = getLoopHandoff("/tmp/pi-loop-handoff-session.jsonl");
		assert.equal(snapshot?.phase, "running");
		const env = loopHandoffEnv("/tmp/pi-loop-handoff-session.jsonl", true);
		assert.deepEqual(JSON.parse(env[LOOP_HANDOFF_ENV]!), JSON.parse(JSON.stringify(snapshot)));
		process.env[LOOP_HANDOFF_ENV] = env[LOOP_HANDOFF_ENV];
		assert.equal(isLoopActive(), false, "the old process must release its loop power hold");
		assert.match(parent.statuses.at(-1) ?? "", /↻ 1 switching branches/, "the parent footer must show the handoff");
		assert.equal(parent.timers.size, 0, "the old process must release its watchdog");
		await parent.emit("session_shutdown");
		const checked: string[] = [];
		const child = harness(async (condition, prompt) => {
			assert.equal(prompt, snapshot?.prompt, "the checker receives the captured prompt after handoff");
			checked.push(condition);
			return { done: true, evidence: "all issues assigned" };
		});
		await child.emit("session_start", { reason: "startup" });
		assert.equal(isLoopActive(), true, "the child owns the running loop");
		assert.match(child.statuses.at(-1) ?? "", /↻ 1 running/, "the child footer restores the live loop");
		assert.deepEqual(child.sent, [], "the handoff continues the existing run, not a second issue");
		await child.finish("PR created");
		assert.equal(checked.length, 1);
		assert.match(child.notices.at(-1) ?? "", /Loop complete after 1 run/);
	} finally {
		if (original === undefined) delete process.env[LOOP_HANDOFF_ENV];
		else process.env[LOOP_HANDOFF_ENV] = original;
		await parent.command("stop");
	}
});

test("issue loop returns to main after a PR and starts the next issue there", async () => {
	const original = process.env[LOOP_HANDOFF_ENV];
	let returned = false;
	const instruction = "Write every PR description in Danish.";
	const branch = harness(async () => ({ done: false, evidence: "more unassigned issues" }), { contextTokens: 2_000 });
	try {
		setLoopReturnToBase(async (ctx) => {
			returned = true;
			const snapshot = getLoopHandoff(ctx.sessionManager.getSessionFile()!);
			assert.equal(snapshot?.phase, "waiting");
			assert.equal(snapshot?.runs, 1);
			assert.equal(snapshot?.instruction, instruction);
			process.env[LOOP_HANDOFF_ENV] = loopHandoffEnv(ctx.sessionManager.getSessionFile()!, true)[LOOP_HANDOFF_ENV];
			assert.equal(isLoopActive(), false, "the previous process releases its hold");
		});
		await branch.command(instruction, "implement-all-issues");
		await branch.finish("PR created");
		assert.equal(returned, true);
		assert.equal(branch.timers.size, 0, "the branch must not start the next issue");
		await branch.emit("session_shutdown");
		setLoopReturnToBase(undefined);
		const main = harness(undefined, { contextTokens: 2_000 });
		await main.emit("session_start", { reason: "startup" });
		assert.equal(main.timers.size, 1);
		main.tick(); // context is too small to compact
		main.tick(); // next issue fetches fresh candidates back on main
		await Promise.resolve();
		assert.equal(main.sent.length, 1);
		assert.ok(main.sent[0]!.includes(instruction), "user instructions survive returning to the base checkout");
		await main.command("stop");
	} finally {
		setLoopReturnToBase(undefined);
		if (original === undefined) delete process.env[LOOP_HANDOFF_ENV];
		else process.env[LOOP_HANDOFF_ENV] = original;
		await branch.command("stop");
	}
});

for (const done of [false, true]) {
	test(`issue loop waits for dirty main before ${done ? "final" : "next issue"} handoff`, async () => {
		const container = await mkdtemp(join(tmpdir(), "pi-loop-dirty-main-"));
		const root = join(container, "repo");
		const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
		const h = harness(async () => ({ done, evidence: done ? "no issues remain" : "more issues remain" }));
		let attempt: Promise<string> | undefined;
		let returned = false;
		try {
			await mkdir(root);
			git("init", "-b", "main");
			git("config", "user.email", "pi@example.invalid");
			git("config", "user.name", "Pi Test");
			await writeFile(join(root, "base.txt"), "base\n");
			git("add", ".");
			git("commit", "-m", "chore: initial");
			const plan = await createLaunchPlan(root, join(container, "agent"), "feat/loop-retry");
			await writeFile(join(root, "base.txt"), "staged work\n");
			git("add", "base.txt");
			await writeFile(join(root, "base.txt"), "unstaged work\n");
			await writeFile(join(root, "untracked.txt"), "untracked work\n");
			const status = git("status", "--porcelain=v1");
			const staged = git("diff", "--cached");
			setLoopReturnToBase(async () => {
				attempt = prepareBranchReturn(plan.manifest);
				await attempt;
				returned = true;
				suspendLoopForHandoff();
			});
			await h.command("", "implement-all-issues");
			await h.finish("PR created");
			await attempt?.catch(() => undefined);
			await settle();
			assert.equal(isLoopActive(), true, "dirty main must pause, not stop, the loop");
			assert.match(h.notices.at(-1) ?? "", /waiting.*main.*uncommitted changes/i);
			assert.equal(returned, false);
			assert.equal(git("status", "--porcelain=v1"), status);
			assert.equal(git("diff", "--cached"), staged);
			assert.equal(await readFile(join(root, "base.txt"), "utf8"), "unstaged work\n");
			assert.equal(await readFile(join(root, "untracked.txt"), "utf8"), "untracked work\n");
			assert.equal(getLoopHandoff("/tmp/pi-loop-handoff-session.jsonl")?.phase, done ? "complete" : "waiting");
			assert.equal(h.sent.length, 1, "no issue may start in the feature worktree");
			// Simulate the other session finishing its work on main.
			git("add", ".");
			git("commit", "-m", "chore: finish concurrent work");
			assert.equal(h.tick(), 30_000);
			await attempt;
			await settle();
			assert.equal(returned, true);
			assert.equal(isLoopActive(), false);
			assert.equal(h.timers.size, 0);
			assert.equal(h.sent.length, 1);
			assert.equal(execFileSync("git", ["branch", "--show-current"], {
				cwd: plan.manifest.worktreeRoot, encoding: "utf8",
			}).trim(), "feat/loop-retry", "the completed PR branch remains intact");
		} finally {
			await h.command("stop");
			setLoopReturnToBase(undefined);
			await rm(container, { recursive: true, force: true });
		}
	});
}

for (const cancel of ["stop", "session_shutdown"]) {
	test(`dirty main retries remain cancellable via ${cancel}`, async () => {
		const h = harness(async () => ({ done: false, evidence: "more issues remain" }));
		let attempts = 0;
		try {
			setLoopReturnToBase(async () => {
				attempts++;
				throw Object.assign(new Error("main has uncommitted changes"), { code: LOOP_MAIN_DIRTY });
			});
			await h.command("", "implement-all-issues");
			await h.finish();
			await settle();
			assert.equal(attempts, 1);
			assert.equal(isLoopActive(), true);
			h.setBusy(true);
			assert.equal(h.tick(), 30_000);
			assert.equal(attempts, 1, "do not hand off during another turn");
			h.setBusy(false);
			assert.equal(h.tick(), 1_000);
			await settle();
			assert.equal(attempts, 2);
			assert.equal(h.timers.size, 1, "dirty main may require more than one retry");
			assert.equal(h.sent.length, 1);
			const staleRetry = [...h.timers.values()][0]!.callback;
			if (cancel === "stop") await h.command("stop");
			else await h.emit("session_shutdown");
			assert.equal(isLoopActive(), false);
			assert.equal(h.timers.size, 0);
			assert.equal(h.intervals.size, 0);
			staleRetry();
			await settle();
			assert.equal(attempts, 2, "a cancelled timer cannot return a stopped loop");
		} finally {
			await h.command("stop");
			setLoopReturnToBase(undefined);
		}
	});
}

test("return errors other than dirty main stop without retrying", async () => {
	const h = harness(async () => ({ done: false, evidence: "more issues remain" }));
	try {
		setLoopReturnToBase(async () => { throw new Error("The managed worktree is not clean; the feature branch was preserved."); });
		await h.command("", "implement-all-issues");
		await h.finish();
		await settle();
		assert.equal(isLoopActive(), false);
		assert.equal(h.timers.size, 0);
		assert.match(h.notices.at(-1) ?? "", /Loop stopped: could not return to main.*managed worktree is not clean/);
	} finally {
		await h.command("stop");
		setLoopReturnToBase(undefined);
	}
});

test("the final issue returns to main without scheduling another run", async () => {
	const original = process.env[LOOP_HANDOFF_ENV];
	const completions: string[] = [];
	const off = onLoopCompletion("handoff-test", (completion) => { completions.push(completion.id); });
	const branch = harness(async () => ({ done: true, evidence: "no unassigned issues" }));
	try {
		setLoopReturnToBase(async (ctx) => {
			const snapshot = getLoopHandoff(ctx.sessionManager.getSessionFile()!);
			assert.equal(snapshot?.phase, "complete");
			process.env[LOOP_HANDOFF_ENV] = JSON.stringify(snapshot);
			suspendLoopForHandoff();
		});
		await branch.command("", "implement-all-issues");
		await branch.finish("last PR created");
		assert.equal(isLoopActive(), false);
		assert.match(branch.notices.at(-1) ?? "", /Loop complete after 1 run/);
		assert.deepEqual(completions, [], "handoff itself is not completion");
		const expectedId = JSON.parse(process.env[LOOP_HANDOFF_ENV]!).completionId;
		const main = harness();
		await main.emit("session_start", { reason: "startup" });
		assert.equal(main.timers.size, 0);
		assert.deepEqual(main.sent, []);
		assert.equal(isLoopActive(), false);
		assert.deepEqual(completions, [expectedId]);
		assert.equal(currentLoopCompletion()?.outcome, "finished");
	} finally {
		off();
		setLoopReturnToBase(undefined);
		if (original === undefined) delete process.env[LOOP_HANDOFF_ENV];
		else process.env[LOOP_HANDOFF_ENV] = original;
		await branch.command("stop");
	}
});

test("unrelated sessions ignore a handoff marker", async () => {
	const original = process.env[LOOP_HANDOFF_ENV];
	try {
		process.env[LOOP_HANDOFF_ENV] = JSON.stringify({
			sessionFile: "/tmp/other-session.jsonl", prompt: "work", intervalMs: 0,
			runs: 1, phase: "waiting", returnToBase: true,
		});
		const h = harness();
		await h.emit("session_start", { reason: "startup" });
		assert.equal(isLoopActive(), false);
		assert.equal(h.timers.size, 0);
		assert.equal(process.env[LOOP_HANDOFF_ENV], undefined);
	} finally {
		if (original === undefined) delete process.env[LOOP_HANDOFF_ENV];
		else process.env[LOOP_HANDOFF_ENV] = original;
	}
});

test("implement-all-issues cannot replace an active loop even with an instruction", async () => {
	const h = harness();
	await h.command("work");
	await h.command("Use Danish for PR descriptions.", "implement-all-issues");
	assert.deepEqual(h.sent, ["work"]);
	assert.match(h.notices.at(-1) ?? "", /already active/);
	await h.command("stop");
});

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
	assert.match(h.notices.at(-1) ?? "", /Loop complete after 2 run/);
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

test("status counts down only during the delay and clears on expiry or stop", async () => {
	const h = harness(undefined, { contextTokens: 2_000 });
	await h.command("1m30s --max-runs 3 work");
	assert.equal(h.statuses.at(-1), "↻ 1/3 running");
	assert.equal(h.intervals.size, 0);
	await h.finish();
	assert.equal(h.statuses.at(-1), "↻ 1/3 waiting 1m30s");
	assert.equal(h.intervals.size, 1);
	h.advance(1_000);
	assert.equal(h.statuses.at(-1), "↻ 1/3 waiting 1m29s");
	h.advance(89_000);
	assert.equal(h.statuses.at(-1), "↻ 1/3 waiting");
	assert.equal(h.intervals.size, 0);
	h.tick(); // expiry; skip compaction for a short session
	h.tick(); // next run
	assert.equal(h.statuses.at(-1), "↻ 2/3 running");
	await h.finish();
	assert.equal(h.statuses.at(-1), "↻ 2/3 waiting 1m30s");
	await h.command("stop");
	assert.equal(h.statuses.at(-1), undefined);
	assert.equal(h.intervals.size, 0);
});

test("countdown ends at the deadline even if pending messages defer the next run", async () => {
	const h = harness(undefined, { contextTokens: 2_000 });
	await h.command("1s work");
	await h.finish();
	h.setPending(true);
	assert.equal(h.tick(), 1_000);
	assert.equal(h.statuses.at(-1), "↻ 1 waiting");
	assert.equal(h.intervals.size, 0);
	await h.command("stop");
});

test("rate-limit retry shows a countdown and stop cancels it", async () => {
	const h = harness(undefined, { compact: "rateOnce" });
	await h.command("work");
	await h.finish();
	h.tick(); // compaction hits a rate limit
	assert.equal(h.statuses.at(-1), "↻ 1 rate limited 1m0s");
	h.advance(1_000);
	assert.equal(h.statuses.at(-1), "↻ 1 rate limited 59s");
	await h.command("stop");
	assert.equal(h.intervals.size, 0);
	assert.equal(h.statuses.at(-1), undefined);
});

test("until loops keep running beyond 20 checks without an explicit cap", async () => {
	let checks = 0;
	const h = harness(async () => ({ done: ++checks === 21, evidence: "confirmed" }), { contextTokens: 2_000 });
	await h.command("work --until done");
	for (let run = 1; run <= 21; run++) {
		await h.finish();
		if (run < 21) {
			h.tick(); // skip compaction for a short session
			h.tick(); // start the next run
		}
	}
	assert.equal(checks, 21);
	assert.equal(h.sent.length, 21);
	assert.match(h.notices.at(-1) ?? "", /Loop complete after 21 run\(s\)/);
});

test("until checker sees loop prompt and final response and stops only on done", async () => {
	const calls: string[] = [];
	const h = harness(async (condition, prompt, output) => {
		assert.equal(prompt, "fix errors");
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

test("rate-limited compaction retries the same run after backoff", async () => {
	const h = harness(undefined, { compact: "rateOnce" });
	await h.command("--max-runs 2 work");
	await h.finish();
	h.tick();
	assert.equal(h.tick(), 60_000);
	assert.equal(h.compactions(), 2);
	assert.equal(h.tick(), 0);
	assert.equal(h.sent.length, 2);
	await h.finish();
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

test("checker timeout retries the same completed iteration", async () => {
	let checks = 0;
	const h = harness(async (_condition, _prompt, output) => {
		assert.equal(output, "completed work");
		if (++checks === 1) throw new Error("Checker timed out.");
		return { done: true, evidence: "verified after retry" };
	});
	try {
		await h.command("--max-runs 1 work --until good");
		await h.finish("completed work");
		assert.equal(isLoopActive(), true, "a checker timeout must not terminate the loop");
		assert.equal(h.tick(), 60_000);
		await settle();
		assert.equal(checks, 2);
		assert.deepEqual(h.sent, ["work"], "the completed work must not be repeated");
		assert.match(h.notices.at(-1) ?? "", /complete after 1 run/);
	} finally {
		await h.command("stop");
	}
});

test("compaction timeout retries before starting the next iteration", async () => {
	const h = harness(undefined, { compact: (callbacks, attempt) => {
		if (attempt === 1) callbacks.onError?.(new Error("Request timed out."));
		else callbacks.onComplete?.();
	} });
	try {
		await h.command("--max-runs 2 work");
		await h.finish();
		h.tick();
		assert.equal(isLoopActive(), true, "a compaction timeout must not terminate the loop");
		assert.deepEqual(h.sent, ["work"]);
		assert.equal(h.tick(), 60_000);
		assert.equal(h.compactions(), 2);
		assert.equal(h.tick(), 0);
		assert.deepEqual(h.sent, ["work", "work"]);
		await h.finish();
		assert.match(h.notices.at(-1) ?? "", /complete after 2 run/);
	} finally {
		await h.command("stop");
	}
});

for (const failure of [
	new Error("Request timeout."),
	Object.assign(new Error("deadline exceeded"), { name: "TimeoutError" }),
	Object.assign(new Error("deadline exceeded"), { name: "APIConnectionTimeoutError" }),
	Object.assign(new Error("connect failed"), { code: "ETIMEDOUT" }),
	Object.assign(new Error("headers stalled"), { code: "UND_ERR_HEADERS_TIMEOUT" }),
	new Error("Checker exited 1: APIConnectionTimeoutError: request stalled"),
]) {
	test(`checker retries timeout variants: ${failure.name}: ${failure.message} ${"code" in failure ? failure.code : ""}`, async () => {
		let checks = 0;
		const h = harness(async () => {
			if (++checks === 1) throw failure;
			return { done: true, evidence: "verified" };
		});
		try {
			await h.command("--max-runs 1 work --until done");
			await h.finish();
			assert.equal(h.statuses.at(-1), "↻ 1/1 timed out 1m0s");
			assert.equal(h.tick(), 60_000);
			await settle();
			assert.equal(checks, 2);
			assert.equal(h.sent.length, 1);
			assert.match(h.notices.at(-1) ?? "", /complete after 1 run/);
		} finally {
			await h.command("stop");
		}
	});
	for (const throws of [false, true]) {
		test(`compaction ${throws ? "throws" : "reports"} timeout: ${failure.name}: ${failure.message} ${"code" in failure ? failure.code : ""}`, async () => {
			const h = harness(undefined, { compact: (callbacks, attempt) => {
				if (attempt > 1) callbacks.onComplete?.();
				else if (throws) throw failure;
				else callbacks.onError?.(failure);
			} });
			try {
				await h.command("--max-runs 2 work");
				await h.finish();
				h.tick();
				assert.equal(h.statuses.at(-1), "↻ 1/2 timed out 1m0s");
				assert.equal(h.tick(), 60_000);
				assert.equal(h.compactions(), 2);
				h.tick();
				assert.equal(h.sent.length, 2);
				await h.finish();
				assert.match(h.notices.at(-1) ?? "", /complete after 2 run/);
			} finally {
				await h.command("stop");
			}
		});
	}
}

for (const command of ["loop", "implement-all-issues"]) {
	test(`${command} recovers checker and compaction timeouts and resets backoff after success`, async () => {
		let checks = 0;
		const outputs: string[] = [];
		const h = harness(async (_condition, _prompt, output) => {
			outputs.push(output);
			if (++checks % 2 === 1) throw new Error("Checker timed out.");
			return { done: checks === 4, evidence: "checked current state" };
		}, { compact: (callbacks, attempt) => {
			if (attempt === 1) callbacks.onError?.(new Error("Request timed out."));
			else callbacks.onComplete?.();
		} });
		try {
			await h.command(command === "loop" ? "--max-runs 2 work --until done" : "", command);
			await h.finish("first result");
			assert.equal(h.tick(), 60_000);
			await settle();
			assert.equal(h.tick(), 0); // attempt compaction only after the check succeeds
			assert.equal(h.sent.length, 1);
			assert.equal(h.tick(), 60_000, "successful checking resets the backoff for compaction");
			assert.equal(h.tick(), 0); // start the second iteration after successful compaction
			await settle();
			assert.equal(h.sent.length, 2);
			await h.finish("second result");
			assert.equal(h.tick(), 60_000, "successful compaction resets the backoff for the next check");
			await settle();
			assert.deepEqual(outputs, ["first result", "first result", "second result", "second result"]);
			assert.equal(h.compactions(), 2);
			assert.equal(h.timers.size, 0);
			assert.equal(h.intervals.size, 0);
			assert.match(h.notices.at(-1) ?? "", /complete after 2 run/);
		} finally {
			await h.command("stop");
		}
	});
}

for (const stage of ["checker", "compaction"] as const) {
	test(`persistent ${stage} timeouts use capped backoff without completion or extra iterations`, async () => {
		let attempts = 0;
		const completions: string[] = [];
		const off = onLoopCompletion("timeout-backoff-test", (event) => { completions.push(event.outcome); });
		const h = harness(async () => {
			attempts++;
			throw new Error("Checker timed out.");
		}, stage === "compaction" ? { compact: (callbacks) => {
			attempts++;
			callbacks.onError?.(new Error("Request timed out."));
		} } : {});
		try {
			await h.command(stage === "checker" ? "work --until done" : "work");
			await h.finish();
			if (stage === "compaction") h.tick();
			for (const delay of [60_000, 120_000, 240_000, 300_000, 300_000]) {
				assert.equal(h.tick(), delay);
				await settle();
				assert.equal(isLoopActive(), true);
				assert.match(h.statuses.at(-1) ?? "", /^↻ 1 timed out/);
			}
			assert.equal(attempts, 6);
			assert.deepEqual(h.sent, ["work"]);
			assert.deepEqual(completions, [], "a timeout is neither success nor terminal failure");
		} finally {
			await h.command("stop");
			off();
		}
	});

	for (const cancel of ["stop", "session_shutdown", "session_start"] as const) {
		test(`${stage} timeout retry is cancelled by ${cancel} and cannot affect a replacement loop`, async () => {
			let attempts = 0;
			let checkerSignal: AbortSignal | undefined;
			const h = harness(async (_condition, _prompt, _output, _ctx, signal) => {
				checkerSignal = signal;
				attempts++;
				throw new Error("Checker timed out.");
			}, stage === "compaction" ? { compact: (callbacks) => {
				attempts++;
				callbacks.onError?.(new Error("Request timed out."));
			} } : {});
			try {
				await h.command(stage === "checker" ? "work --until done" : "work");
				await h.finish();
				if (stage === "compaction") h.tick();
				const staleRetry = [...h.timers.values()][0]?.callback;
				assert.ok(staleRetry);
				if (cancel === "stop") await h.command("stop");
				else await h.emit(cancel);
				assert.equal(isLoopActive(), false);
				assert.equal(h.timers.size, 0);
				assert.equal(h.intervals.size, 0);
				if (stage === "checker") assert.equal(checkerSignal?.aborted, true);
				await h.command("replacement");
				staleRetry();
				await settle();
				assert.equal(attempts, 1);
				assert.deepEqual(h.sent, ["work", "replacement"]);
				assert.match(h.statuses.at(-1) ?? "", /^↻ 1 running$/);
			} finally {
				await h.command("stop");
			}
		});
	}
}

for (const failure of [
	new Error("Checker did not return JSON."),
	new Error("Checker verdict needs a boolean done and nonempty evidence."),
	new Error("401: authentication failed"),
	Object.assign(new Error("Request timed out."), { name: "AbortError" }),
	new Error("Compaction cancelled"),
	new Error("Invalid timeout configuration"),
]) {
	test(`non-transient stage failure remains terminal: ${failure.name}: ${failure.message}`, async () => {
		const check = harness(async () => { throw failure; });
		await check.command("work --until done");
		await check.finish();
		assert.equal(isLoopActive(), false);
		assert.equal(check.timers.size, 0);
		assert.match(check.notices.at(-1) ?? "", /completion check failed/);

		const compact = harness(undefined, { compact: (callbacks) => callbacks.onError?.(failure) });
		await compact.command("work");
		await compact.finish();
		compact.tick();
		assert.equal(isLoopActive(), false);
		assert.equal(compact.timers.size, 0);
		assert.match(compact.notices.at(-1) ?? "", /compaction failed/);
	});
}

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

test("checker rate limits retry without using another run; stop cancels retry", async () => {
	let checks = 0;
	const h = harness(async () => {
		checks++;
		if (checks < 3) throw new Error('Checker exited 1: {"detail":"Rate limit exceeded"}');
		return { done: true, evidence: "verified" };
	});
	await h.command("work --until good");
	await h.finish();
	assert.equal(h.tick(), 60_000);
	await Promise.resolve();
	assert.equal(h.tick(), 120_000);
	await Promise.resolve();
	assert.equal(checks, 3);
	assert.match(h.notices.at(-1) ?? "", /complete after 1 run/);
	assert.equal(h.timers.size, 0);

	const stopped = harness(async () => { throw new Error("429 Too Many Requests"); });
	await stopped.command("work --until good");
	await stopped.finish();
	await stopped.command("stop");
	assert.equal(stopped.timers.size, 0);
});

test("a recovered provider error does not stop the loop", async () => {
	const h = harness(undefined, { contextTokens: 2_000 });
	await h.command("--max-runs 2 work");
	await h.emit("agent_end", { messages: [{ role: "assistant", stopReason: "error", content: [] }] });
	await h.emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "recovered" }] }] });
	h.setBusy(false);
	await h.emit("agent_settled");
	assert.equal(h.notices.length, 0);
	h.tick(); // skip compaction for a short session
	h.tick(); // start run two
	assert.deepEqual(h.sent, ["work", "work"]);
	await h.finish();
	assert.match(h.notices.at(-1) ?? "", /Loop complete after 2 run/);
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
	await h.command("1m work");
	await h.finish();
	assert.equal(h.intervals.size, 1);
	await h.command("stop");
	assert.equal(h.timers.size, 0);
	assert.equal(h.intervals.size, 0);
	await h.command("1m work");
	await h.finish();
	assert.equal(h.intervals.size, 1);
	await h.emit("session_shutdown");
	assert.equal(h.timers.size, 0);
	assert.equal(h.intervals.size, 0);
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
	const h = harness(async (_condition, _prompt, _output, _ctx, controller) => {
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


test("laptop notifies once only after the asynchronous until verdict completes the loop", { skip: process.platform !== "darwin" }, async () => {
	const notifications: string[] = [];
	let verdict!: (value: Verdict) => void;
	const h = harness(async () => new Promise<Verdict>((resolve) => { verdict = resolve; }), { notifications, contextTokens: 2_000 });
	try {
		await h.command("finish the work --until all work is done");
		await h.finish();
		assert.deepEqual(notifications, [], "checking is not completion");
		verdict({ done: false, evidence: "more work remains" });
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.deepEqual(notifications, [], "an intermediate iteration must stay silent");
		h.tick();
		h.tick();
		await h.finish();
		assert.deepEqual(notifications, [], "the final check must settle first");
		verdict({ done: true, evidence: "all work is done" });
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.deepEqual(notifications, ["Pi finished"], "the final loop completion needs one laptop alert");
		await h.emit("agent_settled");
		assert.deepEqual(notifications, ["Pi finished"]);
	} finally { await h.command("stop"); }
});


test("loop stops, cancellation and failures are not successful completion", async () => {
	const outcomes: string[] = [];
	const off = onLoopCompletion("outcome-test", (completion) => { outcomes.push(completion.outcome); });
	try {
		const capped = harness(async () => ({ done: false, evidence: "unfinished" }));
		await capped.command("--max-runs 1 work --until complete");
		await capped.finish();
		assert.deepEqual(outcomes, ["failed"], "a cap must not certify an unmet until condition");
		const failed = harness(async () => { throw new Error("checker unavailable"); });
		await failed.command("work --until complete");
		await failed.finish();
		assert.deepEqual(outcomes, ["failed", "failed"]);
		const stopped = harness();
		await stopped.command("work --until complete");
		await stopped.command("stop");
		assert.deepEqual(stopped.notices, [], "manual stop must not inject a message into the current iteration");
		await stopped.finish();
		assert.equal(stopped.timers.size, 0);
		assert.deepEqual(stopped.sent, ["work"]);
		const aborted = harness();
		await aborted.command("work --until complete");
		await aborted.finish("", "aborted");
		assert.deepEqual(outcomes, ["failed", "failed"], "manual stop and abort are silent");
		const count = harness();
		await count.command("--max-runs 1 work");
		await count.finish();
		assert.deepEqual(outcomes, ["failed", "failed", "finished"]);
	} finally { off(); }
});

test("native bridge marks iterations and replays only the terminal loop verdict on registration", async () => {
	const root = await mkdtemp("/tmp/pi-loop-wire-");
	const previous = { data: process.env.PI_REMOTE_DATA_DIR, child: process.env.PI_SUBAGENT_CHILD, private: process.env.PI_INCOGNITO_MODE };
	process.env.PI_REMOTE_DATA_DIR = root;
	delete process.env.PI_SUBAGENT_CHILD;
	delete process.env.PI_INCOGNITO_MODE;
	const rows: Array<{ type: string; kind?: string; data?: Record<string, unknown> }> = [];
	let peer!: net.Socket;
	let acknowledge = true;
	let verdict!: (value: Verdict) => void;
	const server = net.createServer((socket) => {
		peer = socket;
		let buffer = "";
		socket.setEncoding("utf8");
		socket.on("data", (chunk) => {
			buffer += chunk;
			let index: number;
			while ((index = buffer.indexOf("\n")) >= 0) {
				const row = JSON.parse(buffer.slice(0, index));
				buffer = buffer.slice(index + 1);
				rows.push(row);
				if (row.secret) socket.write('{"type":"ready"}\n');
				if (row.type === "register" && acknowledge) socket.write('{"type":"registered","epoch":1}\n');
			}
		});
	});
	const wait = async (ready: () => boolean) => {
		for (let n = 0; n < 200; n++) {
			if (ready()) return;
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		assert.fail("native loop notification event did not arrive");
	};
	let h: ReturnType<typeof harness> | undefined;
	try {
		await writeFile(join(root, "ipc.key"), "fixture");
		server.listen(join(root, "broker.sock"));
		await once(server, "listening");
		for (const name of ["file-protection", "caffeinate", "question", "conversation-name", "incognito"]) markGuard(name);
		h = harness(async () => new Promise<Verdict>((resolve) => { verdict = resolve; }), { sessionId: "bridge-loop-fixture", plugins: [remoteControl], contextTokens: 2_000 });
		await h.emit("session_start", { reason: "startup" });
		await wait(() => rows.some((row) => row.kind === "snapshot"));
		await h.command("work --until complete");
		await h.finish();
		await wait(() => rows.some((row) => row.kind === "agent_settled"));
		assert.equal(rows.find((row) => row.kind === "agent_settled")?.data?.loopIteration, true);
		assert.equal(rows.filter((row) => row.kind === "loop_completed").length, 0);
		verdict({ done: false, evidence: "more work" });
		await new Promise<void>((resolve) => setImmediate(resolve));
		h.tick(); h.tick();
		// Lose registration while the final asynchronous checker is in flight.
		acknowledge = false;
		const registrations = rows.filter((row) => row.type === "register").length;
		peer.write('{"type":"ready"}\n');
		await wait(() => rows.filter((row) => row.type === "register").length > registrations);
		await h.finish();
		verdict({ done: true, evidence: "complete" });
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(rows.filter((row) => row.kind === "loop_completed").length, 0);
		peer.write('{"type":"registered","epoch":2}\n');
		await wait(() => rows.some((row) => row.kind === "loop_completed"));
		const completion = rows.find((row) => row.kind === "loop_completed")!.data!;
		assert.deepEqual(completion, { id: currentLoopCompletion()?.id, outcome: "finished" });
		const before = rows.length;
		peer.write('{"type":"registered","epoch":2}\n');
		await wait(() => rows.slice(before).some((row) => row.kind === "loop_completed"));
		assert.deepEqual(rows.filter((row) => row.kind === "loop_completed").map((row) => row.data), [completion, completion], "reconnect retains the same deduplication ID");
		await h.command("work --until complete");
		assert.equal(currentLoopCompletion(), undefined, "a new loop cannot replay an older completion");
		await h.command("stop");
	} finally {
		await h?.emit("session_shutdown");
		peer?.destroy();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		for (const [key, value] of [["PI_REMOTE_DATA_DIR", previous.data], ["PI_SUBAGENT_CHILD", previous.child], ["PI_INCOGNITO_MODE", previous.private]]) {
			if (value === undefined) delete process.env[key!]; else process.env[key!] = value;
		}
		await rm(root, { recursive: true, force: true });
	}
});


test("aborted settlement after successful output cannot check, continue or complete a loop", async () => {
	const outcomes: string[] = [];
	const off = onLoopCompletion("settlement-abort-test", (completion) => { outcomes.push(completion.outcome); });
	try {
		for (const args of ["work --until complete", "--max-runs 1 work", "work"]) {
			let checks = 0;
			const h = harness(async () => { checks++; return { done: true, evidence: "complete" }; });
			try {
				await h.command(args);
				await h.emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Done" }] }] });
				await h.emit("agent_settled", { aborted: true });
				assert.equal(checks, 0, "cancelled finalization must not run the until checker");
				assert.deepEqual(outcomes, [], "cancellation is never completion");
				assert.equal(isLoopActive(), false);
				assert.equal(h.timers.size, 0);
			} finally { await h.command("stop"); }
		}
	} finally { off(); }
});
