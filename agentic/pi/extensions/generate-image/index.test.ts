import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import generateImage from "./index.ts";
import thinkingStatus from "../thinking-status/index.ts";

function setup(exec: ExtensionAPI["exec"]) {
	let handler: ((args: string, ctx: ExtensionContext) => Promise<void>) | undefined;
	let tool: Parameters<ExtensionAPI["registerTool"]>[0] | undefined;
	const messages: string[] = [];
	const notifications: string[] = [];
	const statuses: (string | undefined)[] = [];
	const pi = {
		registerCommand: (name: string, options: { handler: typeof handler }) => {
			assert.equal(name, "generate-image");
			handler = options.handler;
		},
		registerTool: (definition: Parameters<ExtensionAPI["registerTool"]>[0]) => {
			assert.equal(definition.name, "generate_image");
			tool = definition;
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
	assert.ok(tool);
	return { handler, tool, ctx, messages, notifications, statuses };
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
		assert.deepEqual(state.statuses, []);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("tool returns the path and URL without sending an agent message", async () => {
	const directory = mkdtempSync(path.join(os.tmpdir(), "pi-generate-test-"));
	const output = path.join(directory, "image.png");
	writeFileSync(output, "png");
	try {
		const state = setup(async (command, args) => {
			assert.equal(command, "uv");
			assert.equal(args[4], "A blue teapot");
			assert.deepEqual(args.slice(5), ["--size", "768x1024", "--seed", "9"]);
			return { code: 0, stdout: `${output}\n`, stderr: "", killed: false };
		});
		const result = await state.tool.execute("call-1", { prompt: "A blue teapot", size: "768x1024", seed: 9 }, undefined, undefined, state.ctx);
		assert.equal(result.isError, undefined);
		assert.deepEqual(result.content, [{ type: "text", text: `${output}\n${new URL(`file://${output}`).href}` }]);
		assert.deepEqual(state.messages, []);
		assert.deepEqual(state.statuses, []);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("tool reports failures as tool errors", async () => {
	const state = setup(async () => ({ code: 1, stdout: "", stderr: "router unavailable\n", killed: false }));
	const result = await state.tool.execute("call-1", { prompt: "A teapot" }, undefined, undefined, state.ctx);
	assert.equal(result.isError, true);
	assert.deepEqual(result.content, [{ type: "text", text: "router unavailable" }]);
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
	assert.deepEqual(state.statuses, []);
});

test("tool activity uses the working indicator, not the footer", () => {
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
	const working: (string | undefined)[] = [];
	const footer: string[] = [];
	const pi = {
		on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => void) => handlers.set(event, handler),
		events: { on: () => {} },
	} as unknown as ExtensionAPI;
	const ctx = {
		ui: {
			setWorkingMessage: (message?: string) => working.push(message),
			setStatus: (_key: string, message: string) => footer.push(message),
		},
	} as ExtensionContext;
	thinkingStatus(pi);
	handlers.get("tool_execution_start")?.({ toolName: "generate_image", toolCallId: "image-1" }, ctx);
	assert.deepEqual(working, ["Generating image..."]);
	handlers.get("tool_execution_end")?.({ toolCallId: "image-1" }, ctx);
	assert.deepEqual(working, ["Generating image...", undefined]);
	assert.deepEqual(footer, []);
});
