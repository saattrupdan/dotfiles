import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { setLoopActive } from "../_loop_state/state.ts";
import notifyExtension from "./index.ts";
import { RETRY_STATE_EVENT } from "../rate-limit-retry/index.ts";

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
