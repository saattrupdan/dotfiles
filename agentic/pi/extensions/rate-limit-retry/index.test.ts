import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import rateLimitRetry from "./index.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

function harness(wait: (delay: number, signal: AbortSignal | undefined) => Promise<boolean> = async () => true) {
	const handlers = new Map<string, Handler>();
	const statuses = new Map<string, string>();
	const delays: number[] = [];
	const messages: Array<{ customType: string; content: string; display: boolean }> = [];
	let command: ((args: string, ctx: unknown) => void) | undefined;
	const ctx = {
		signal: new AbortController().signal,
		ui: {
			setStatus: (key: string, text: string | undefined) => {
				if (text === undefined) statuses.delete(key);
				else statuses.set(key, text);
			},
		},
	};
	const pi = {
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
		statuses,
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
		assert.equal(run.statuses.get("rate-limit-retry"), `Retrying for the ${n}${["st", "nd", "rd"][n - 1] ?? "th"} time...`);
		const result = await run.emit("turn_end") as { continue: boolean; entries: Array<{ display: boolean }> };
		assert.equal(result.continue, true);
		assert.equal(result.entries[0].display, false);
	}
	assert.deepEqual(run.delays, [2000, 4000, 8000, 16000, 32000, 60000]);
	assert.equal(run.messages.length, 0, "no standalone retry turns or displayed prompts");
	await run.emit("message_end", success());
	assert.equal(run.statuses.has("rate-limit-retry"), false);
	assert.equal(await run.emit("turn_end"), undefined);
	await run.emit("message_end", rateLimited());
	assert.equal(run.statuses.get("rate-limit-retry"), "Retrying for the 1st time...");
});

test("other errors and partial rate-limit responses keep Pi's normal rendering", async () => {
	const run = harness();
	const otherError = { message: { role: "assistant", stopReason: "error", errorMessage: "HTTP 500", content: [] } };
	assert.equal(await run.emit("message_end", otherError), undefined);
	assert.equal(await run.emit("turn_end"), undefined);
	const partial = { message: { ...rateLimited().message, content: [{ type: "text", text: "partial" }] } };
	assert.equal(await run.emit("message_end", partial), undefined);
	assert.equal(await run.emit("turn_end"), undefined);
	assert.equal(run.statuses.size, 0);
});

test("off and abort cancel pending retries", async () => {
	const run = harness(async () => false);
	await run.emit("message_end", rateLimited());
	assert.equal(await run.emit("turn_end"), undefined);
	assert.equal(run.statuses.size, 0);
	run.command("off");
	assert.equal(await run.emit("message_end", rateLimited()), undefined);
	assert.equal(run.statuses.size, 0);
});
