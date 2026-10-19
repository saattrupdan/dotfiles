import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import generateImage from "./index.ts";
import thinkingStatus from "../thinking-status/index.ts";

function setup(exec: ExtensionAPI["exec"], cwd = process.cwd()) {
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
		cwd,
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
					assert.match(lines[0], /\[accent\].*\[muted\](Enhancing image-generation prompt|Generating image)\.\.\./);
					assert.equal(lines[1], "");
					const original = component.setMessage.bind(component);
					component.setMessage = (label: string) => {
						widgets.push(label);
						original(label);
						assert.match(component.render(120)[0], /\[muted\]/);
						assert.equal(component.render(120)[1], "");
					};
					loader = component;
					widgets.push(lines[0].includes("Enhancing image-generation prompt...") ? "Enhancing image-generation prompt..." : "Generating image...");
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
	assert.doesNotMatch(JSON.stringify(tool.parameters), /"seed"/);
	assert.match(JSON.stringify(tool.parameters), /"num"/);
	assert.match(JSON.stringify(tool.parameters), /default 512x512/);
	assert.match(tool.description, /photos.*photorealistic.*crisp.*sharp.*soft-focus blur/i);
	return { handler, tool, ctx, messages, notifications, statuses, working, visible, widgets };
}

test("command sends the whole brief as one argument and returns the path", async () => {
	const directory = mkdtempSync(path.join(os.tmpdir(), "pi-generate-test-"));
	const output = path.join(directory, "image.png");
	writeFileSync(output, "png");
	try {
		const brief = `A cat saying "hello"; don't change the words`;
		const state = setup(async (command, args, options) => {
			assert.equal(command, "uv");
			assert.equal(options?.timeout, 2_150_000);
			assert.deepEqual(args.slice(0, 3), ["run", "--no-project", "python3"]);
			assert.match(args[3], /generate-image\/scripts\/enhance_and_generate\.py$/);
			assert.equal(args[4], brief);
			assert.ok(!args.includes("--size"));
			assert.deepEqual(args.slice(-2), ["--num", "1"]);
			return { code: 0, stdout: JSON.stringify({ paths: [output], compiled_prompt: "A detailed cat." }), stderr: "", killed: false };
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

test("--no-enhance generates directly and labels the result without an enhanced stage", async () => {
	const directory = mkdtempSync(path.join(os.tmpdir(), "pi-generate-test-"));
	const output = path.join(directory, "image.png");
	writeFileSync(output, "png");
	try {
		const prompt = "A crisp, photorealistic teapot";
		const state = setup(async (_command, args) => {
			assert.equal(args[4], prompt);
			assert.deepEqual(args.slice(5), ["--skip-enhancement", "--num", "1"]);
			return { code: 0, stdout: JSON.stringify({ paths: [output], compiled_prompt: prompt }), stderr: "", killed: false };
		});
		await state.handler(`--no-enhance ${prompt}`, state.ctx);
		assert.deepEqual(state.messages, [`Prompt:\n${prompt}\n\nImage: ${output}`]);
		assert.deepEqual(state.widgets, ["Generating image...", "Generating image...", undefined]);
		assert.deepEqual(state.statuses, []);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("@relative file loads the prompt before enhancement", async () => {
	const directory = mkdtempSync(path.join(os.tmpdir(), "pi-generate-test-"));
	const prompts = path.join(directory, "prompts");
	mkdirSync(prompts);
	writeFileSync(path.join(prompts, "photo.md"), "  A crisp portrait\n");
	const outputs = [path.join(directory, "image-01.png"), path.join(directory, "image-02.png")];
	outputs.forEach((output) => writeFileSync(output, "png"));
	try {
		const state = setup(async (_command, args) => {
			assert.equal(args[4], "A crisp portrait");
			assert.equal(args[5], "--phase-file");
			assert.deepEqual(args.slice(-4), ["--size", "768x1024", "--num", "2"]);
			return { code: 0, stdout: JSON.stringify({ paths: outputs, compiled_prompt: "A sharp portrait" }), stderr: "", killed: false };
		}, directory);
		await state.handler("--size 768x1024 --num 2 @prompts/photo.md", state.ctx);
		assert.deepEqual(state.messages, [`Original prompt:\nA crisp portrait\n\nEnhanced prompt:\nA sharp portrait\n\nImages:\n${outputs.join("\n")}`]);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("bare and quoted file paths work with --no-enhance", async () => {
	const directory = mkdtempSync(path.join(os.tmpdir(), "pi-generate-test-"));
	const file = path.join(directory, "photo prompt.txt");
	const prompt = "Photorealistic flower in clear focus";
	writeFileSync(file, `${prompt}\n`);
	const output = path.join(directory, "image.png");
	writeFileSync(output, "png");
	try {
		for (const input of ["photo prompt.txt", `"${file}"`, `@"${file}"`]) {
			const state = setup(async (_command, args) => {
				assert.equal(args[4], prompt);
				assert.deepEqual(args.slice(5), ["--skip-enhancement", "--num", "1"]);
				return { code: 0, stdout: JSON.stringify({ paths: [output], compiled_prompt: prompt }), stderr: "", killed: false };
			}, directory);
			await state.handler(`--no-enhance ${input}`, state.ctx);
			assert.deepEqual(state.messages, [`Prompt:\n${prompt}\n\nImage: ${output}`]);
		}
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("missing, empty and oversized explicit files fail before generation", async () => {
	const directory = mkdtempSync(path.join(os.tmpdir(), "pi-generate-test-"));
	writeFileSync(path.join(directory, "empty.txt"), " \n");
	writeFileSync(path.join(directory, "large.txt"), "x".repeat(64 * 1024 + 1));
	let calls = 0;
	try {
		for (const [input, message] of [["@missing.txt", "ENOENT"], ["@empty.txt", "empty"], ["@large.txt", "64 KB"], ["@.", "not a file"]]) {
			const state = setup(async () => { calls++; return { code: 0, stdout: "", stderr: "", killed: false }; }, directory);
			await state.handler(input, state.ctx);
			assert.match(state.notifications[0], new RegExp(message));
			assert.deepEqual(state.widgets, []);
		}
		assert.equal(calls, 0);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("--size, --num and --no-enhance work in any leading order", async () => {
	const directory = mkdtempSync(path.join(os.tmpdir(), "pi-generate-test-"));
	const outputs = [path.join(directory, "image-01.png"), path.join(directory, "image-02.png")];
	outputs.forEach((output) => writeFileSync(output, "png"));
	try {
		for (const [input, size] of [
			["--num 2 --no-enhance --size 512x512 A garden", "512x512"],
			["--no-enhance --size 512x512 --num 2 A garden", "512x512"],
			["--size 1024x1024 --num 2 --no-enhance A garden", "1024x1024"],
		]) {
			const state = setup(async (_command, args) => {
				assert.equal(args[4], "A garden");
				assert.deepEqual(args.slice(5), ["--skip-enhancement", "--size", size, "--num", "2"]);
				return { code: 0, stdout: JSON.stringify({ paths: outputs, compiled_prompt: "A garden" }), stderr: "", killed: false };
			});
			await state.handler(input, state.ctx);
			assert.deepEqual(state.messages, [`Prompt:\nA garden\n\nImages:\n${outputs.join("\n")}`]);
		}
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
			return { code: 0, stdout: JSON.stringify({ paths: [output], compiled_prompt: "A sunlit garden." }), stderr: "", killed: false };
		});
		await state.handler("A garden", state.ctx);
		assert.deepEqual(state.working, []);
		assert.deepEqual(state.visible, []);
		assert.deepEqual(state.widgets, ["Enhancing image-generation prompt...", "Enhancing image-generation prompt...", "Generating image...", undefined]);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
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

test("empty brief does not run the generator", async () => {
	let calls = 0;
	const state = setup(async () => {
		calls++;
		return { code: 0, stdout: "", stderr: "", killed: false };
	});
	await state.handler("  ", state.ctx);
	assert.equal(calls, 0);
	assert.deepEqual(state.notifications, ["Usage: /generate-image [--no-enhance] [--num N] [--size WIDTHxHEIGHT] <prompt|@file|file>"]);
	assert.deepEqual(state.working, []);
	assert.deepEqual(state.visible, []);
	assert.deepEqual(state.widgets, []);
});

test("--no-enhance without a prompt does not run the generator", async () => {
	let calls = 0;
	const state = setup(async () => {
		calls++;
		return { code: 0, stdout: "", stderr: "", killed: false };
	});
	await state.handler("--no-enhance", state.ctx);
	assert.equal(calls, 0);
	assert.deepEqual(state.notifications, ["Usage: /generate-image [--no-enhance] [--num N] [--size WIDTHxHEIGHT] <prompt|@file|file>"]);
	assert.deepEqual(state.widgets, []);
});

test("invalid counts do not start image generation", async () => {
	let calls = 0;
	for (const value of ["0", "11", "oops", "2.5", "", "2 --num 3"]) {
		const state = setup(async () => { calls++; return { code: 0, stdout: "", stderr: "", killed: false }; });
		await state.handler(`--num ${value} A teapot`, state.ctx);
		assert.match(state.notifications[0], /--num must be an integer from 1 to 10/);
		assert.deepEqual(state.widgets, []);
	}
	assert.equal(calls, 0);
});

test("invalid sizes fail before image generation", async () => {
	let calls = 0;
	for (const value of [
		"511x512", "1025x512", "512x511", "512x1025", "513x512", "512x513",
		"512X512", "512x512x512", "1.5x512", "-512x512", "oops", "",
		"512x512 --size 768x1024",
	]) {
		const state = setup(async () => { calls++; return { code: 0, stdout: "", stderr: "", killed: false }; });
		await state.handler(`--size ${value} A teapot`, state.ctx);
		assert.match(state.notifications[0], /--size must be WIDTHxHEIGHT/);
		assert.deepEqual(state.widgets, []);
	}
	assert.equal(calls, 0);
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
