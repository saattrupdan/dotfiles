import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import notifyExtension from "./index.ts";
import { RETRY_STATE_EVENT } from "../rate-limit-retry/index.ts";

test("quiet WebSocket retries cause no failure or premature finish notification", { skip: process.platform !== "darwin" }, async () => {
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
	assert.deepEqual(notifications, []);
	listeners.get(RETRY_STATE_EVENT)?.({ retrying: false });
	await emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Done" }] }] });
	assert.deepEqual(notifications, ["Pi finished"]);
});
