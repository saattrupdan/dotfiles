import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import generateImage from "./index.ts";

function setup(exec: ExtensionAPI["exec"]) {
	let handler: ((args: string, ctx: ExtensionContext) => Promise<void>) | undefined;
	const messages: string[] = [];
	const notifications: string[] = [];
	const statuses: (string | undefined)[] = [];
	const pi = {
		registerCommand: (name: string, options: { handler: typeof handler }) => {
			assert.equal(name, "generate-image");
			handler = options.handler;
		},
		exec,
		sendMessage: (message: { content: string }) => messages.push(message.content),
	} as unknown as ExtensionAPI;
	const ctx = {
		ui: {
			notify: (message: string) => notifications.push(message),
			setStatus: (_key: string, value: string | undefined) => statuses.push(value),
		},
	} as ExtensionContext;
	generateImage(pi);
	assert.ok(handler);
	return { handler, ctx, messages, notifications, statuses };
}

test("command sends the whole brief as one argument and returns the file URL", async () => {
	const directory = mkdtempSync(path.join(os.tmpdir(), "pi-generate-test-"));
	const output = path.join(directory, "image.png");
	writeFileSync(output, "png");
	try {
		const brief = `A cat saying "hello"; don't change the words`;
		const state = setup(async (command, args) => {
			assert.equal(command, "uv");
			assert.deepEqual(args.slice(0, 3), ["run", "--no-project", "python3"]);
			assert.match(args[3], /generate-image\/scripts\/enhance_and_generate\.py$/);
			assert.equal(args[4], brief);
			return { code: 0, stdout: `${output}\n`, stderr: "", killed: false };
		});
		await state.handler(brief, state.ctx);
		assert.deepEqual(state.messages, [new URL(`file://${output}`).href]);
		assert.equal(state.statuses.at(-1), undefined);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("empty brief does not run the generator", async () => {
	let calls = 0;
	const state = setup(async () => {
		calls++;
		return { code: 0, stdout: "", stderr: "", killed: false };
	});
	await state.handler("  ", state.ctx);
	assert.equal(calls, 0);
	assert.deepEqual(state.notifications, ["Usage: /generate-image <prompt>"]);
});

test("generation errors display without triggering an agent turn", async () => {
	const state = setup(async () => ({
		code: 1,
		stdout: "",
		stderr: "local llama.cpp is unavailable\n",
		killed: false,
	}));
	await state.handler("A teapot", state.ctx);
	assert.deepEqual(state.messages, ["local llama.cpp is unavailable"]);
	assert.equal(state.statuses.at(-1), undefined);
});
