import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import rateLimitRetry from "./index.ts";

type Handler = (event?: unknown) => void;

function harness() {
	const handlers = new Map<string, Handler>();
	const messages: Array<{ customType: string; content: string; display: boolean }> = [];
	let command: ((args: string) => void) | undefined;
	const pi = {
		on: (name: string, handler: Handler) => {
			handlers.set(name, handler);
		},
		sendMessage: (message: { customType: string; content: string; display: boolean }) => {
			messages.push(message);
		},
		registerCommand: (_name: string, options: { handler: (args: string) => void }) => {
			command = options.handler;
		},
	} as unknown as ExtensionAPI;
	rateLimitRetry(pi);
	return {
		messages,
		emit: (name: string, event?: unknown) => {
			const handler = handlers.get(name);
			assert.ok(handler, `Missing ${name} handler`);
			handler(event);
		},
		command: (args: string) => {
			assert.ok(command);
			command(args);
		},
	};
}

const rateLimited = { messages: [{ role: "assistant", stopReason: "error", errorMessage: "HTTP 429" }] };
const success = { messages: [{ role: "assistant", stopReason: "stop" }] };
const otherError = { messages: [{ role: "assistant", stopReason: "error", errorMessage: "HTTP 500" }] };

test("waits for settlement after built-in attempts, then retries every exhausted 429", () => {
	const run = harness();
	run.emit("agent_start");
	for (let i = 0; i < 4; i++) run.emit("agent_end", rateLimited);
	assert.equal(run.messages.length, 0);
	run.emit("agent_before_settle", { outcome: "error" });
	run.emit("agent_settled");
	assert.equal(run.messages.length, 1);
	assert.equal(run.messages[0].display, false);

	for (let i = 0; i < 5; i++) {
		run.emit("agent_start");
		run.emit("agent_end", rateLimited);
		run.emit("agent_before_settle", { outcome: "error" });
		run.emit("agent_settled");
	}
	assert.equal(run.messages.length, 6);
	run.emit("agent_start");
	run.emit("agent_end", success);
	run.emit("agent_before_settle", { outcome: "completed" });
	run.emit("agent_settled");
	assert.equal(run.messages.length, 6);
});

test("only the final outcome matters; other errors and the off switch do not retry", () => {
	const run = harness();
	run.emit("agent_start");
	run.emit("agent_end", rateLimited);
	run.emit("agent_end", otherError);
	run.emit("agent_before_settle", { outcome: "error" });
	run.emit("agent_settled");
	assert.equal(run.messages.length, 0);
	run.emit("agent_start");
	run.emit("agent_end", rateLimited);
	run.emit("agent_before_settle", { outcome: "error" });
	run.command("off");
	run.emit("agent_settled");
	assert.equal(run.messages.filter((message) => message.customType === "rate-limit-retry:continue").length, 0);
});

test("aborting during the built-in retry wait does not start another run", () => {
	const run = harness();
	run.emit("agent_start");
	run.emit("agent_end", rateLimited);
	// Abort skips the pre-settlement boundary.
	run.emit("agent_settled");
	assert.equal(run.messages.length, 0);
});
