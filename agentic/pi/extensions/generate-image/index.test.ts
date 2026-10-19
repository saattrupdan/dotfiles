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
	const working: (string | undefined)[] = [];
	const visible: boolean[] = [];
	const widgets: (string | undefined)[] = [];
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
	let loader: { setMessage: (label: string) => void; stop: () => void } | undefined;
	const ctx = {
		mode: "tui",
		ui: {
			notify: (message: string) => notifications.push(message),
			setStatus: (_key: string, value: string | undefined) => statuses.push(value),
			setWorkingMessage: (value?: string) => working.push(value),
			setWorkingVisible: (value: boolean) => visible.push(value),
			setWidget: (key: string, content: unknown, options?: { placement?: string }) => {
				assert.equal(key, "generate-image:progress");
				if (typeof content === "function") {
					assert.equal(options?.placement, "aboveEditor");
					const component = content({ requestRender: () => {} }, { fg: (colour: string, text: string) => `[${colour}]${text}` });
					const lines = component.render(120);
					assert.equal(lines.length, 2);
					assert.match(lines[0], /\[accent\].*\[muted\]Enhancing image-generation prompt/);
					assert.equal(lines[1], "");
					const original = component.setMessage.bind(component);
					component.setMessage = (label: string) => {
						widgets.push(label);
						original(label);
						assert.match(component.render(120)[0], /\[muted\]/);
						assert.equal(component.render(120)[1], "");
					};
					loader = component;
					widgets.push("Enhancing image-generation prompt...");
				} else {
					loader?.stop();
					loader = undefined;
					widgets.push(undefined);
				}
			},
		},
	} as ExtensionContext;
	generateImage(pi);
	assert.ok(handler);
	assert.ok(tool);
	return { handler, tool, ctx, messages, notifications, statuses, working, visible, widgets };
}

test("command sends the whole brief as one argument and returns the path", async () => {
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
			return { code: 0, stdout: JSON.stringify({ path: output, enhanced_prompt: "A detailed cat." }), stderr: "", killed: false };
		});
		await state.handler(brief, state.ctx);
		assert.deepEqual(state.messages, [`Original prompt:\n${brief}\n\nEnhanced prompt:\nA detailed cat.\n\nImage: ${output}`]);
		assert.deepEqual(state.working, []);
		assert.deepEqual(state.visible, []);
		assert.deepEqual(state.widgets, ["Enhancing image-generation prompt...", "Enhancing image-generation prompt...", undefined]);
		assert.deepEqual(state.statuses, []);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("command switches from enhancement to generation while running", async () => {
	const directory = mkdtempSync(path.join(os.tmpdir(), "pi-generate-test-"));
	const output = path.join(directory, "image.png");
	writeFileSync(output, "png");
	try {
		const state = setup(async (_command, args) => {
			writeFileSync(args[6], "generating");
			await new Promise((resolve) => setTimeout(resolve, 300));
			return { code: 0, stdout: JSON.stringify({ path: output, enhanced_prompt: "A sunlit garden." }), stderr: "", killed: false };
		});
		await state.handler("A garden", state.ctx);
		assert.deepEqual(state.working, []);
		assert.deepEqual(state.visible, []);
		assert.deepEqual(state.widgets, ["Enhancing image-generation prompt...", "Enhancing image-generation prompt...", "Generating image...", undefined]);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("tool switches from enhancement to generation while running", async () => {
	const directory = mkdtempSync(path.join(os.tmpdir(), "pi-generate-test-"));
	const output = path.join(directory, "image.png");
	writeFileSync(output, "png");
	try {
		const state = setup(async (_command, args) => {
			writeFileSync(args[6], "generating");
			await new Promise((resolve) => setTimeout(resolve, 300));
			return { code: 0, stdout: JSON.stringify({ path: output, enhanced_prompt: "A sunlit garden." }), stderr: "", killed: false };
		});
		await state.tool.execute("call-1", { prompt: "A garden" }, undefined, undefined, state.ctx);
		assert.deepEqual(state.working, ["Enhancing image-generation prompt...", "Generating image..."]);
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
			assert.deepEqual(args.slice(7), ["--size", "768x1024", "--seed", "9"]);
			return { code: 0, stdout: JSON.stringify({ path: output, enhanced_prompt: "A blue ceramic teapot." }), stderr: "", killed: false };
		});
		const result = await state.tool.execute("call-1", { prompt: "A blue teapot", size: "768x1024", seed: 9 }, undefined, undefined, state.ctx);
		assert.equal(result.isError, undefined);
		assert.deepEqual(result.content, [{ type: "text", text: `Original prompt:\nA blue teapot\n\nEnhanced prompt:\nA blue ceramic teapot.\n\nImage: ${output}` }]);
		assert.deepEqual(state.working, ["Enhancing image-generation prompt..."]);
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
	assert.deepEqual(state.working, []);
	assert.deepEqual(state.visible, []);
	assert.deepEqual(state.widgets, []);
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
	assert.deepEqual(state.working, []);
	assert.deepEqual(state.visible, []);
	assert.deepEqual(state.widgets, ["Enhancing image-generation prompt...", "Enhancing image-generation prompt...", undefined]);
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
	assert.deepEqual(working, ["Enhancing image-generation prompt..."]);
	handlers.get("tool_execution_end")?.({ toolCallId: "image-1" }, ctx);
	assert.deepEqual(working, ["Enhancing image-generation prompt...", undefined]);
	assert.deepEqual(footer, []);
});
