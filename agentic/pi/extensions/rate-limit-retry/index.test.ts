import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import thinkingStatus from "../thinking-status/index.ts";
import rateLimitRetry, { isTransientWebSocketClosure, RETRY_STATE_EVENT } from "./index.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

function harness(wait: (delay: number, signal: AbortSignal | undefined) => Promise<boolean> = async () => true) {
	const handlers = new Map<string, Handler>();
	const workingLabels: Array<string | undefined> = [];
	const retryStates: boolean[] = [];
	const delays: number[] = [];
	const messages: Array<{ customType: string; content: string; display: boolean }> = [];
	let command: ((args: string, ctx: unknown) => void) | undefined;
	const ctx = {
		signal: new AbortController().signal,
		ui: {},
	};
	const pi = {
		events: {
			emit: (name: string, data: { label?: string; retrying?: boolean }) => {
				if (name === RETRY_STATE_EVENT) retryStates.push(data.retrying ?? false);
				else {
					assert.equal(name, "thinking-status:override");
					workingLabels.push(data.label);
				}
			},
		},
		on: (name: string, handler: Handler) => {
			handlers.set(name, handler);
		},
		sendMessage: (message: { customType: string; content: string; display: boolean }) => {
			messages.push(message);
		},
		registerCommand: (_name: string, options: { handler: (args: string, ctx: unknown) => void }) => {
			command = options.handler;
		},
	} as unknown as ExtensionAPI;
	rateLimitRetry(pi, async (delay, signal) => {
		delays.push(delay);
		return wait(delay, signal);
	});
	return {
		workingLabels,
		retryStates,
		delays,
		messages,
		emit: async (name: string, event: unknown = {}) => {
			const handler = handlers.get(name);
			assert.ok(handler, `Missing ${name} handler`);
			return await handler(event, ctx);
		},
		command: (args: string) => {
			assert.ok(command);
			command(args, ctx);
		},
	};
}

const rateLimited = () => ({
	message: { role: "assistant", stopReason: "error", errorMessage: '{"detail":"Rate limit exceeded"}', content: [] },
});
const success = () => ({ message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Done" }] } });

test("masks rate-limit errors, keeps one run, counts each retry and resets on success", async () => {
	const run = harness();
	await run.emit("session_start");
	for (let n = 1; n <= 6; n++) {
		const start = rateLimited();
		await run.emit("message_start", start);
		assert.equal(start.message.stopReason, "pending", "the initial TUI frame must not flash the error");
		assert.equal(start.message.errorMessage, undefined);
		const masked = await run.emit("message_end", rateLimited()) as { message: { stopReason: string; errorMessage?: string } };
		assert.equal(masked.message.stopReason, "stop");
		assert.equal(masked.message.errorMessage, undefined);
		assert.equal(run.workingLabels.at(-1), n === 1 ? "Retrying..." : `Retrying for the ${n}${["st", "nd", "rd"][n - 1] ?? "th"} time...`);
		await run.emit("message_update", { message: { role: "assistant" }, assistantMessageEvent: { type: "start" } });
		assert.equal(run.workingLabels.at(-1), n === 1 ? "Retrying..." : `Retrying for the ${n}${["st", "nd", "rd"][n - 1] ?? "th"} time...`);
		const result = await run.emit("turn_end") as { continue: boolean; entries: Array<{ display: boolean }> };
		assert.equal(result.continue, true);
		assert.equal(result.entries[0].display, false);
	}
	assert.deepEqual(run.delays, [2000, 4000, 8000, 16000, 32000, 60000]);
	assert.equal(run.messages.length, 0, "no standalone retry turns or displayed prompts");
	await run.emit("message_end", success());
	assert.equal(run.workingLabels.at(-1), undefined);
	assert.equal(await run.emit("turn_end"), undefined);
	await run.emit("message_end", rateLimited());
	assert.equal(run.workingLabels.at(-1), "Retrying...");
});

test("first real streamed output ends the retry state before message_end", async () => {
	for (const type of ["text_delta", "thinking_delta", "toolcall_delta"]) {
		const run = harness();
		await run.emit("message_end", rateLimited());
		assert.equal(run.workingLabels.at(-1), "Retrying...");
		await run.emit("turn_end");
		await run.emit("message_update", { message: { role: "assistant" }, assistantMessageEvent: { type } });
		assert.equal(run.workingLabels.at(-1), undefined);
		assert.equal(await run.emit("turn_end"), undefined);
		await run.emit("message_end", rateLimited());
		assert.equal(run.workingLabels.at(-1), "Retrying...", "retries after recovery start at one again");
	}
});

test("empty transient transport errors retry until connectivity returns", async () => {
	const run = harness();
	for (const error of ["fetch failed", "connect ETIMEDOUT 1.2.3.4:443", "getaddrinfo EAI_AGAIN example.com", "socket hang up"]) {
		const failed = { message: { role: "assistant", stopReason: "error", errorMessage: error, content: [] } };
		await run.emit("message_start", failed);
		assert.equal(failed.message.stopReason, "pending");
		const result = await run.emit("message_end", { message: { ...failed.message, stopReason: "error", errorMessage: error } }) as { message: { stopReason: string } };
		assert.equal(result.message.stopReason, "stop");
		assert.equal((await run.emit("turn_end") as { continue: boolean }).continue, true);
	}
	assert.deepEqual(run.delays, [2000, 4000, 8000, 16000]);
	await run.emit("message_end", success());
	assert.equal(await run.emit("turn_end"), undefined);
});

test("empty server overload errors retry quietly until recovery", async () => {
	const run = harness();
	for (const error of [
		"Error: Codex error: Our servers are currently overloaded. Please try again later.",
		"Service is overloaded. Please try again later.",
	]) {
		const failed = { message: { role: "assistant", stopReason: "error", errorMessage: error, content: [] } };
		await run.emit("message_start", failed);
		assert.equal(failed.message.stopReason, "pending");
		assert.equal(failed.message.errorMessage, undefined);
		const masked = await run.emit("message_end", { message: { ...failed.message, stopReason: "error", errorMessage: error } }) as { message: { stopReason: string; errorMessage?: string } };
		assert.equal(masked.message.stopReason, "stop");
		assert.equal(masked.message.errorMessage, undefined);
		assert.equal((await run.emit("turn_end") as { continue: boolean }).continue, true);
	}
	assert.deepEqual(run.delays, [2000, 4000]);
	assert.equal(run.workingLabels.at(-1), "Retrying for the 2nd time...");
	await run.emit("message_end", success());
	assert.equal(await run.emit("turn_end"), undefined);
});

test("WebSocket 1000 closes with empty thinking retry quietly without a budget", async () => {
	const run = harness();
	for (let n = 0; n < 6; n++) {
		const error = "WebSocket closed 1000";
		const failed = () => ({ message: {
			role: "assistant", stopReason: "error", errorMessage: error,
			content: [{ type: "thinking", thinking: "" }],
		} });
		const start = failed();
		await run.emit("message_start", start);
		assert.equal(start.message.stopReason, "pending");
		assert.equal(start.message.errorMessage, undefined);
		const masked = await run.emit("message_end", failed()) as { message: {
			stopReason: string; errorMessage?: string; content: unknown[];
		} };
		assert.equal(masked.message.stopReason, "stop");
		assert.equal(masked.message.errorMessage, undefined);
		assert.deepEqual(masked.message.content, []);
		assert.equal((await run.emit("turn_end") as { continue: boolean }).continue, true);
	}
	assert.deepEqual(run.delays, [2000, 4000, 8000, 16000, 32000, 60000]);
	assert.equal(run.messages.length, 0);
	assert.equal(run.retryStates.at(-1), true);
	await run.emit("message_end", success());
	assert.equal(run.retryStates.at(-1), false);
	assert.equal(await run.emit("turn_end"), undefined);
});

test("only transient WebSocket close codes are suppressed by retry and notify", async () => {
	for (const error of ["WebSocket closed 1000", "Error: WebSocket closed 1006"]) {
		assert.equal(isTransientWebSocketClosure(error), true);
	}
	const run = harness();
	for (const error of ["WebSocket closed 1008", "WebSocket closed 1009 message too big", "WebSocket closed 4001 authentication failed"]) {
		assert.equal(isTransientWebSocketClosure(error), false);
		const failed = { message: { role: "assistant", stopReason: "error", errorMessage: error, content: [] } };
		assert.equal(await run.emit("message_end", failed), undefined);
		assert.equal(await run.emit("turn_end"), undefined);
	}
	assert.deepEqual(run.delays, []);
});

test("other errors and partial retryable responses keep Pi's normal rendering", async () => {
	const run = harness();
	const otherError = { message: { role: "assistant", stopReason: "error", errorMessage: "HTTP 500", content: [] } };
	assert.equal(await run.emit("message_end", otherError), undefined);
	assert.equal(await run.emit("turn_end"), undefined);
	for (const error of [rateLimited().message.errorMessage, "fetch failed", "WebSocket closed 1000", "Our servers are currently overloaded. Please try again later."]) {
		const partial = { message: { ...rateLimited().message, errorMessage: error, content: [{ type: "text", text: "partial" }] } };
		assert.equal(await run.emit("message_end", partial), undefined);
		assert.equal(await run.emit("turn_end"), undefined);
	}
	const partialThinking = { message: { role: "assistant", stopReason: "error", errorMessage: "WebSocket closed 1000", content: [{ type: "thinking", thinking: "reasoning" }] } };
	assert.equal(await run.emit("message_end", partialThinking), undefined);
	assert.equal(await run.emit("turn_end"), undefined);
	const toolCall = { message: { role: "assistant", stopReason: "error", errorMessage: "WebSocket closed 1000", content: [{ type: "toolCall", name: "bash" }] } };
	assert.equal(await run.emit("message_end", toolCall), undefined);
	assert.equal(await run.emit("turn_end"), undefined);
	assert.equal(run.workingLabels.length, 0);
});

test("off and abort cancel pending retries", async () => {
	const run = harness(async () => false);
	await run.emit("message_end", rateLimited());
	assert.equal(await run.emit("turn_end"), undefined);
	assert.equal(run.workingLabels.at(-1), undefined);
	run.command("off");
	assert.equal(await run.emit("message_end", rateLimited()), undefined);
	assert.equal(run.workingLabels.at(-1), undefined);
});

test("retry replaces the working spinner even when reasoning resumes", async () => {
	const handlers = new Map<string, Handler[]>();
	const listeners = new Map<string, (data: unknown) => void>();
	let label: string | undefined;
	let visible = false;
	const ctx = {
		signal: new AbortController().signal,
		ui: {
			setHiddenThinkingLabel: (_label: string) => {},
			setWorkingVisible: (value: boolean) => { visible = value; },
			setWorkingMessage: (value?: string) => { label = value; },
		},
	};
	const pi = {
		on: (name: string, handler: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
		events: {
			on: (name: string, listener: (data: unknown) => void) => listeners.set(name, listener),
			emit: (name: string, data: unknown) => listeners.get(name)?.(data),
		},
		registerCommand: () => {},
	} as unknown as ExtensionAPI;
	thinkingStatus(pi);
	rateLimitRetry(pi, async () => true);
	const emit = async (name: string, event: unknown = {}) => {
		for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
	};
	await emit("session_start");
	await emit("message_update", { message: { content: [{ type: "thinking" }] } });
	assert.equal(label, "Thinking...");
	await emit("message_end", rateLimited());
	assert.equal(label, "Retrying...");
	assert.equal(visible, true);
	await emit("message_update", { message: { role: "assistant", content: [] }, assistantMessageEvent: { type: "start" } });
	assert.equal(label, "Retrying...", "a stream start alone is not proof of recovery");
	await emit("message_update", { message: { role: "assistant", content: [{ type: "thinking" }] }, assistantMessageEvent: { type: "thinking_delta" } });
	assert.equal(label, "Thinking...", "the phase label returns on the first streamed output");
	await emit("message_update", { message: { role: "assistant", content: [{ type: "text" }] }, assistantMessageEvent: { type: "text_delta" } });
	assert.equal(label, undefined, "the normal working label returns for text streaming");
	await emit("message_end", success());
	assert.equal(label, undefined);
});
