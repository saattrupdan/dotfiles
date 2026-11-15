import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { setLoopActive } from "../_loop_state/state.ts";
import notifyExtension, { createDismissalTracker } from "./index.ts";
import { RETRY_STATE_EVENT } from "../rate-limit-retry/index.ts";
import { createNotificationDelivery } from "./delivery.ts";

const ORIGIN = { cwd: "/vault/original", conversationId: "pi-conversation" };
const HOLI_SESSION = { id: "p0123456789ab", provider: "pi", conversationId: ORIGIN.conversationId };
const ITERM_ENV = { TERM_PROGRAM: "iTerm.app", ITERM_SESSION_ID: "w1:original-pane" };

function deliveryFixture(sessions: unknown = [HOLI_SESSION], env: NodeJS.ProcessEnv = {}, unavailable = false) {
	const calls: Array<{ args: string[]; cwd: string }> = [];
	const iterm: string[][] = [];
	let time = 1_000;
	let fail = unavailable;
	const { send } = createNotificationDelivery(ORIGIN, {
		env,
		now: () => time,
		sendITerm: (title, body, sound) => { iterm.push([title, body, sound]); },
		runHoli: async (args, cwd) => {
			calls.push({ args, cwd });
			if (fail) throw new Error("Holi unavailable");
			return args[1] === "sessions" ? JSON.stringify(sessions) : "notified";
		},
	});
	return {
		send, calls, iterm,
		advance: () => { time += 400; },
		fail: () => { fail = true; },
	};
}

test("matches the originating Holi Pi session, preserving vault and click target", async () => {
	const f = deliveryFixture([
		{ ...HOLI_SESSION, id: "p111111111111", conversationId: "another-conversation" },
		HOLI_SESSION,
	], ITERM_ENV);
	await f.send("Session — Pi finished", "Ready for your next prompt.", "Glass");
	assert.deepEqual(f.calls, [
		{ args: ["agent", "sessions", "--json"], cwd: ORIGIN.cwd },
		{
			args: ["agent", "notify", "--title=Session — Pi finished", "--line=Ready for your next prompt.", "--session", HOLI_SESSION.id],
			cwd: ORIGIN.cwd,
		},
	]);
	assert.deepEqual(f.iterm, [], "Holi takes precedence over inherited iTerm variables");
	f.advance();
	await f.send("Pi has a question", "Choose an option", "Tink");
	assert.equal(f.calls.length, 3, "the originating Holi route is retained without re-querying");
	assert.equal(f.calls[2].cwd, ORIGIN.cwd);
	assert.equal(f.calls[2].args.at(-1), HOLI_SESSION.id);
});

test("installed Holi alone never captures an ordinary iTerm session", async () => {
	for (const sessions of [
		[], null, {}, [null],
		[{ ...HOLI_SESSION, conversationId: "unrelated" }],
		[{ ...HOLI_SESSION, provider: "claude" }],
		[{ ...HOLI_SESSION, id: "../../wrong" }],
		[{ ...HOLI_SESSION, closed: true }],
		[HOLI_SESSION, { ...HOLI_SESSION, id: "p111111111111" }],
	]) {
		const f = deliveryFixture(sessions, ITERM_ENV);
		await f.send("Pi finished", "Done", "Glass");
		assert.deepEqual(f.iterm, [["Pi finished", "Done", "Glass"]]);
		assert.equal(f.calls.length, 1, "no Holi notice for absent, invalid, or ambiguous matches");
	}
});

test("missing Holi leaves iTerm routing unchanged and other terminals silent", async () => {
	for (const env of [ITERM_ENV, {}, { TERM_PROGRAM: "iTerm.app" }]) {
		const f = deliveryFixture([], env, true);
		await f.send("Pi failed", "Failure", "Basso");
		assert.equal(f.iterm.length, env === ITERM_ENV ? 1 : 0);
	}
});

test("a failed Holi delivery stays quiet instead of redirecting to an inherited pane", async () => {
	const f = deliveryFixture([HOLI_SESSION], ITERM_ENV);
	await f.send("Pi finished", "Done", "Glass");
	f.advance();
	f.fail();
	await assert.doesNotReject(async () => { await f.send("Pi failed", "Failure", "Basso"); });
	assert.equal(f.calls.length, 3);
	assert.deepEqual(f.iterm, []);
});

test("Holi versions rejecting interactive session links still receive exactly one notice", async () => {
	const calls: string[][] = [];
	let time = 1_000;
	const { ready, send } = createNotificationDelivery(ORIGIN, {
		env: ITERM_ENV,
		now: () => time,
		sendITerm: () => { assert.fail("never redirect to iTerm"); },
		runHoli: async (args) => {
			calls.push(args);
			if (args[1] === "sessions") return JSON.stringify([HOLI_SESSION]);
			if (args.includes("--session")) {
				throw Object.assign(new Error("CLI validation rejected session"), {
					stderr: `holi agent notify: BAD_REQUEST: not a session id: ${HOLI_SESSION.id}\n`,
				});
			}
			return "notified";
		},
	});
	await ready;
	await send("Pi finished", "Done", "Glass");
	assert.deepEqual(calls[1].slice(0, 4), calls[2]);
	assert.equal(calls[1].at(-1), HOLI_SESSION.id);
	assert.ok(!calls[2].includes("--session"));
	time += 400;
	await send("Pi has a question", "Question", "Tink");
	assert.equal(calls.length, 4, "remember the host's unsupported link format");
	assert.ok(!calls[3].includes("--session"));
});

test("Holi titles and lines respect CLI limits and preserve leading option characters as data", async () => {
	const f = deliveryFixture();
	await f.send("--vault=" + "x".repeat(200), "--help; $(touch /tmp/nope)\n" + "y".repeat(500), "Tink");
	const args = f.calls[1].args;
	assert.equal(args[2].slice("--title=".length).length, 120);
	assert.equal(args[3].slice("--line=".length).length, 400);
	assert.ok(args[2].startsWith("--title=--vault="));
	assert.ok(args[3].startsWith("--line=--help; $(touch /tmp/nope)\n"));
});

test("back-to-back notifications share discovery and keep the existing minimum gap", async () => {
	const f = deliveryFixture();
	await Promise.all([
		f.send("Pi has a question", "Question", "Tink"),
		f.send("Pi finished", "Done", "Glass"),
	]);
	assert.equal(f.calls.length, 2, "one probe and one notice");
	f.advance();
	await f.send("Pi finished", "Done", "Glass");
	assert.equal(f.calls.length, 3);
});

test("discovery failures and malformed responses can recover on a later event", async () => {
	for (const initial of ["not JSON", "[]"]) {
		let probes = 0;
		const calls: string[][] = [];
		const { send } = createNotificationDelivery(ORIGIN, {
			env: {},
			sendITerm: () => { assert.fail("not iTerm"); },
			runHoli: async (args) => {
				calls.push(args);
				if (args[1] === "sessions") return ++probes === 1 ? initial : JSON.stringify([HOLI_SESSION]);
				return "notified";
			},
		});
		await send("Pi has a question", "Question", "Tink");
		await send("Pi finished", "Done", "Glass");
		assert.equal(probes, 2);
		assert.equal(calls.filter((args) => args[1] === "notify").length, 1);
	}
});

test("verified Holi origin survives new, fork, reload, and a worktree process handoff", { skip: process.platform !== "darwin" }, async () => {
	const root = globalThis as typeof globalThis & { __piNotifyHost?: { origin?: typeof ORIGIN } };
	const previousOrigin = root.__piNotifyHost?.origin;
	const calls: Array<{ args: string[]; cwd: string }> = [];
	let entries: Array<{ type: "custom"; customType: string; data: unknown }> = [];
	let conversationId = ORIGIN.conversationId;
	let cwd = ORIGIN.cwd;
	let handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	const ctx = () => ({
		hasUI: true, cwd,
		sessionManager: {
			getSessionName: () => "Lifecycle test",
			getSessionId: () => conversationId,
			getEntries: () => entries,
		},
	}) as unknown as ExtensionContext;
	const register = () => {
		handlers = new Map();
		const pi = {
			on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(name, handler),
			events: { on: () => {} },
			appendEntry: (customType: string, data: unknown) => { entries.push({ type: "custom", customType, data }); },
		} as unknown as ExtensionAPI;
		notifyExtension(pi, undefined, (origin, deps) => createNotificationDelivery(origin, {
			...deps, env: {},
			runHoli: async (args, runCwd) => {
				calls.push({ args, cwd: runCwd });
				assert.equal(runCwd, ORIGIN.cwd, "always route through the original vault");
				return args[1] === "sessions" ? JSON.stringify([HOLI_SESSION]) : "notified";
			},
		}));
	};
	const start = async () => { await handlers.get("session_start")!({}, ctx()); };
	try {
		if (root.__piNotifyHost) delete root.__piNotifyHost.origin;
		register();
		await start();
		assert.deepEqual(entries.map((entry) => entry.data), [ORIGIN], "record identity before the first notification");
		// /new writes the verified host identity into the fresh transcript.
		entries = [];
		conversationId = "new-pi-conversation";
		await start();
		assert.deepEqual(entries.map((entry) => entry.data), [ORIGIN]);
		// /fork carries custom entries, /reload evaluates a fresh delivery instance.
		conversationId = "forked-pi-conversation";
		entries = structuredClone(entries);
		if (root.__piNotifyHost) delete root.__piNotifyHost.origin;
		register();
		await start();
		assert.equal(entries.length, 1, "do not duplicate the origin on reload");
		// A worktree successor has no in-process state and is outside the managed vault.
		cwd = "/worktree/outside-the-vault";
		if (root.__piNotifyHost) delete root.__piNotifyHost.origin;
		register();
		await start();
		await handlers.get("agent_end")!({ messages: [{ role: "assistant", stopReason: "stop", content: [] }] }, ctx());
		assert.equal(calls.at(-1)?.args[1], "notify");
		assert.equal(calls.at(-1)?.args.at(-1), HOLI_SESSION.id);
	} finally {
		if (root.__piNotifyHost) root.__piNotifyHost.origin = previousOrigin;
	}
});

test("headless sessions never discover Holi or deliver notifications", { skip: process.platform !== "darwin" }, async () => {
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	const pi = {
		on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(name, handler),
		events: { on: () => {} },
	} as unknown as ExtensionAPI;
	notifyExtension(pi, undefined, () => { assert.fail("headless sessions must not initialize notification delivery"); });
	const ctx = { hasUI: false, sessionManager: { getSessionName: () => "Headless" } } as unknown as ExtensionContext;
	await handlers.get("session_start")!({}, ctx);
	await handlers.get("tool_call")!({ toolName: "question", input: {} }, ctx);
	await handlers.get("agent_end")!({ messages: [] }, ctx);
});

test("dismisses only the originating pane's pending alerts when it becomes active", () => {
	const removed: string[] = [];
	const checks: Array<{ sessionID: string; done: (focused: boolean) => void }> = [];
	const polls: Array<() => void> = [];
	let cancelled = 0;
	const focus = (sessionID: string, done: (focused: boolean) => void) => { checks.push({ sessionID, done }); };
	const schedule = (poll: () => void) => {
		polls.push(poll);
		return () => { cancelled++; };
	};
	const trackFirst = createDismissalTracker("pane-1", focus, (group) => { removed.push(group); }, schedule);
	const trackSecond = createDismissalTracker("pane-2", focus, (group) => { removed.push(group); }, schedule);
	trackFirst("first-alert");
	trackFirst("second-alert");
	trackSecond("other-pane-alert");
	assert.equal(polls.length, 2, "one poller per pane, not per alert");
	polls[0]();
	polls[0]();
	assert.equal(checks.length, 1, "focus checks must not overlap");
	assert.equal(checks[0].sessionID, "pane-1");
	checks[0].done(false);
	assert.deepEqual(removed, []);
	polls[0]();
	trackFirst("alert-arriving-during-focus-check");
	checks[1].done(true);
	assert.deepEqual(removed, ["first-alert", "second-alert", "alert-arriving-during-focus-check"]);
	assert.equal(cancelled, 1);
	polls[1]();
	assert.equal(checks[2].sessionID, "pane-2");
	checks[2].done(true);
	assert.deepEqual(removed.at(-1), "other-pane-alert");
	assert.equal(cancelled, 2);
	trackFirst("new-alert");
	assert.equal(polls.length, 3, "polling resumes when a new alert arrives");
	polls[2]();
	checks[3].done(true);
	assert.equal(removed.at(-1), "new-alert");
});

test("quiet WebSocket and Codex retries cause no failure or premature finish notification", { skip: process.platform !== "darwin" }, async () => {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const listeners = new Map<string, (data: unknown) => void>();
	const notifications: string[] = [];
	const pi = {
		on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(event, handler),
		events: { on: (event: string, listener: (data: unknown) => void) => listeners.set(event, listener) },
	} as unknown as ExtensionAPI;
	notifyExtension(pi, (title) => { notifications.push(title); });
	const emit = async (name: string, event: unknown = {}) => {
		const handler = handlers.get(name);
		assert.ok(handler, name);
		await handler(event, { hasUI: true, sessionManager: { getSessionName: () => "Test" } });
	};
	await emit("session_start");
	listeners.get(RETRY_STATE_EVENT)?.({ retrying: true });
	await emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop", content: [] }] });
	await emit("agent_end", { messages: [{ role: "assistant", stopReason: "error", errorMessage: "WebSocket closed 1000", content: [] }] });
	const codexError = "Error: Codex error: An error occurred while processing your request. You can retry your request, or contact us through our help center at help.openai.com if the error persists.";
	await emit("agent_end", { messages: [{ role: "assistant", stopReason: "error", errorMessage: codexError, content: [] }] });
	assert.deepEqual(notifications, []);
	listeners.get(RETRY_STATE_EVENT)?.({ retrying: false });
	await emit("agent_end", { messages: [{ role: "assistant", stopReason: "error", errorMessage: codexError, content: [] }] });
	await emit("agent_end", { messages: [{ role: "assistant", stopReason: "error", errorMessage: "Error: WebSocket closed 1012", content: [] }] });
	assert.deepEqual(notifications, [], "transient errors never send failure notifications");
	await emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Done" }] }] });
	assert.deepEqual(notifications, ["Pi finished"]);
});

test("handoffs stay silent but resumed completions, failures, and failed cleanup remain visible", { skip: process.platform !== "darwin" }, async () => {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const notifications: string[] = [];
	const pi = {
		on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(event, handler),
		events: { on: () => {} },
	} as unknown as ExtensionAPI;
	const ctx = { hasUI: true, sessionManager: { getSessionName: () => "Test" } } as ExtensionContext;
	notifyExtension(pi, (title) => { notifications.push(title); });
	await handlers.get("session_start")!({}, ctx);
	const handoff = {
		role: "toolResult", toolName: "clean_up_isolated_branch", isError: false,
		details: { worktreeHandoff: true }, content: [{ type: "text", text: "Returning to main" }],
	};
	const finish = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Done on main" }] };
	const failure = { role: "assistant", stopReason: "error", errorMessage: "Disk failure", content: [] };
	const end = async (messages: unknown[]) => { await handlers.get("agent_end")!({ messages }, ctx); };
	await end([handoff]);
	assert.deepEqual(notifications, []);
	await end([handoff, finish]);
	await end([handoff, failure]);
	await end([{ ...handoff, isError: true }, failure]);
	await end([{ ...handoff, details: undefined }]);
	assert.deepEqual(notifications, ["Pi finished", "Pi failed", "Pi failed", "Pi finished"]);
	// A handoff in history never suppresses later unrelated requests.
	await end([handoff, finish, { role: "user", content: "Another task" }, finish]);
	assert.equal(notifications.at(-1), "Pi finished");
});

test("agent endings stay silent during an active loop and notify again after it stops", { skip: process.platform !== "darwin" }, async () => {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const notifications: string[] = [];
	const pi = {
		on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(event, handler),
		events: { on: () => {} },
	} as unknown as ExtensionAPI;
	const ctx = { hasUI: true, sessionManager: { getSessionName: () => "Test" } } as ExtensionContext;
	notifyExtension(pi, (title) => { notifications.push(title); });
	const emit = async (name: string, event: unknown = {}) => {
		const handler = handlers.get(name);
		assert.ok(handler, name);
		await handler(event, ctx);
	};
	const success = { messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Done" }] }] };
	const failure = { messages: [{ role: "assistant", stopReason: "error", errorMessage: "Fatal error", content: [] }] };
	await emit("session_start");
	try {
		setLoopActive(true, ctx);
		await emit("agent_end", success);
		await emit("agent_end", failure);
		assert.deepEqual(notifications, []);
	} finally {
		setLoopActive(false, ctx);
	}
	await emit("agent_end", success);
	assert.deepEqual(notifications, ["Pi finished"]);
});
