import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import generateImage from "./index.ts";
import thinkingStatus from "../thinking-status/index.ts";

function setup(exec: ExtensionAPI["exec"]) {
	let tool: Parameters<ExtensionAPI["registerTool"]>[0] | undefined;
	const messages: string[] = [];
	const statuses: (string | undefined)[] = [];
	const working: (string | undefined)[] = [];
	const visible: boolean[] = [];
	const pi = {
		registerCommand: () => assert.fail("Image generation must not register a slash command"),
		registerTool: (definition: Parameters<ExtensionAPI["registerTool"]>[0]) => {
			assert.equal(definition.name, "generate_image");
			assert.equal(tool, undefined);
			tool = definition;
		},
		exec,
		sendMessage: (message: { content: string }) => messages.push(message.content),
	} as unknown as ExtensionAPI;
	const ctx = {
		ui: {
			setStatus: (_key: string, value: string | undefined) => statuses.push(value),
			setWorkingMessage: (value?: string) => working.push(value),
			setWorkingVisible: (value: boolean) => visible.push(value),
		},
	} as ExtensionContext;
	generateImage(pi);
	assert.ok(tool);
	assert.doesNotMatch(JSON.stringify(tool.parameters), /"seed"/);
	assert.match(JSON.stringify(tool.parameters), /"num"/);
	assert.match(JSON.stringify(tool.parameters), /default 512x512/);
	assert.match(tool.description, /photos.*photorealistic.*crisp.*sharp.*soft-focus blur/i);
	return { tool, ctx, messages, statuses, working, visible };
}

test("registers only the generate_image tool, without a slash command", () => {
	setup(async () => assert.fail("Registration must not generate images"));
});

test("empty prompts and invalid counts do not run the generator", async () => {
	const state = setup(async () => assert.fail("Invalid input must not generate images"));
	for (const params of [
		{ prompt: "  " },
		...[0, 11, 2.5].map((num) => ({ prompt: "A teapot", num })),
	]) {
		const result = await state.tool.execute("call-1", params, undefined, undefined, state.ctx);
		assert.equal(result.isError, true);
	}
	assert.deepEqual(state.working, []);
});

test("tool starts generation without the enhancement phase", async () => {
	const directory = mkdtempSync(path.join(os.tmpdir(), "pi-generate-test-"));
	const output = path.join(directory, "image.png");
	writeFileSync(output, "png");
	try {
		const state = setup(async (_command, args) => {
			assert.deepEqual(args.slice(5), ["--skip-enhancement", "--num", "1"]);
			return { code: 0, stdout: JSON.stringify({ paths: [output], compiled_prompt: "A sunlit garden." }), stderr: "", killed: false };
		});
		await state.tool.execute("call-1", { prompt: "A sunlit garden." }, undefined, undefined, state.ctx);
		assert.deepEqual(state.working, ["Generating image..."]);
		assert.deepEqual(state.visible, []);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("tool returns the path without sending an agent message", async () => {
	const directory = mkdtempSync(path.join(os.tmpdir(), "pi-generate-test-"));
	const output = path.join(directory, "image.png");
	writeFileSync(output, "png");
	try {
		const state = setup(async (command, args) => {
			assert.equal(command, "uv");
			assert.equal(args[4], "A blue teapot");
			assert.deepEqual(args.slice(5), ["--skip-enhancement", "--size", "768x1024", "--num", "1"]);
			return { code: 0, stdout: JSON.stringify({ paths: [output], compiled_prompt: "A blue teapot" }), stderr: "", killed: false };
		});
		const updates: unknown[] = [];
		const result = await state.tool.execute("call-1", { prompt: "A blue teapot", size: "768x1024" }, undefined, (partial) => updates.push(partial), state.ctx);
		assert.deepEqual(updates, [{ content: [], details: undefined }]);
		assert.equal(result.isError, undefined);
		assert.deepEqual(result.content, [{ type: "text", text: `Prompt:\nA blue teapot\n\nImage: ${output}` }]);
		assert.deepEqual(result.details, { count: 1 });
		assert.deepEqual(state.working, ["Generating image..."]);
		assert.deepEqual(state.messages, []);
		assert.deepEqual(state.statuses, []);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("tool returns all batch paths in one directory", async () => {
	const directory = mkdtempSync(path.join(os.tmpdir(), "pi-generate-test-"));
	const outputs = [1, 2, 3].map((index) => path.join(directory, `image-0${index}.png`));
	outputs.forEach((output) => writeFileSync(output, "png"));
	try {
		const state = setup(async (_command, args, options) => {
			assert.deepEqual(args.slice(5), ["--skip-enhancement", "--num", "3"]);
			assert.equal(options?.timeout, 2_750_000);
			return { code: 0, stdout: JSON.stringify({ paths: outputs, compiled_prompt: "A garden" }), stderr: "", killed: false };
		});
		const result = await state.tool.execute("call-1", { prompt: "A garden", num: 3 }, undefined, undefined, state.ctx);
		assert.deepEqual(result.content, [{ type: "text", text: `Prompt:\nA garden\n\nImages:\n${outputs.join("\n")}` }]);
		assert.deepEqual(result.details, { count: 3 });
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

test("tool result has a live label and a concise collapsed summary", () => {
	const state = setup(async () => ({ code: 1, stdout: "", stderr: "", killed: false }));
	assert.ok(state.tool.renderCall);
	assert.ok(state.tool.renderResult);
	const theme = { fg: (colour: string, text: string) => `[${colour}]${text}`, bold: (text: string) => text };
	const render = (result: { content: Array<{ type: "text"; text: string }> }, expanded: boolean, isPartial: boolean, isError = false, count = 1) =>
		state.tool.renderResult!({ ...result, details: { count } }, { expanded, isPartial }, theme as never, { isError, args: { num: count } } as never).render(120).map((line) => line.trimEnd()).join("\n");
	assert.equal(state.tool.renderCall({}, theme as never, {} as never).render(120).join("").trimEnd(), "[toolTitle]generate_image");
	assert.equal(render({ content: [] }, false, true), "[warning]⋯ Generating image");
	assert.equal(render({ content: [] }, false, true, false, 3), "[warning]⋯ Generating images");
	const success = { content: [{ type: "text" as const, text: "Prompt:\nA garden\n\nImage: /tmp/image.png" }] };
	assert.equal(render(success, false, false), "[success]✓ Generated image");
	assert.equal(render(success, false, false, false, 3), "[success]✓ Generated 3 images");
	assert.equal(render(success, true, false), success.content[0].text);
	const error = { content: [{ type: "text" as const, text: "router unavailable" }] };
	assert.equal(render(error, false, false, true), "[error]✗ image generation failed");
	assert.equal(render(error, true, false, true), "router unavailable");
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
