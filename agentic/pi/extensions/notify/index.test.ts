import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { setLoopActive } from "../_loop_state/state.ts";
import notifyExtension, { createDismissalTracker } from "./index.ts";
import { RETRY_STATE_EVENT } from "../rate-limit-retry/index.ts";

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
