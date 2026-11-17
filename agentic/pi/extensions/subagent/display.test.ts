import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { initTheme, ToolExecutionComponent, type Theme } from "@earendil-works/pi-coding-agent";
import { Text, foregroundAnsi, mixColors, type TUI } from "@earendil-works/pi-tui";
import type { Message } from "@earendil-works/pi-ai";
import { ActivityView } from "../_tool-display/activity.ts";
import { toolRenderers, bashToolRenderers, writeToolRenderers } from "../_tool-display/catalog.ts";
import type { DisplayContext } from "../_tool-display/types.ts";
import { createSubagentRenderers, type SingleResult } from "./display.ts";
import { TranscriptArchive, type ActivityItem } from "./transcript.ts";
import { compactResult } from "./compact-result.ts";
import bashOutput from "../bash-output/index.ts";
import { registerAutoloadRenderOverrides } from "../skill/render-overrides.ts";

initTheme("dark");
let theme: Theme;
new ToolExecutionComponent("capture", "capture", {}, {}, {
	renderCall(_args, value) { theme = value; return new Text(""); },
}, { requestRender() {} } as TUI, process.cwd());
const plain = (value: { render(width: number): string[] }, width = 100) => value.render(width).map(stripVTControlCharacters).join("\n");
const assistant = (content: unknown[]): Message => ({ role: "assistant", content }) as Message;
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
const base = (): SingleResult => ({ agent: "explorer", agentSource: "user", task: "Inspect output", exitCode: 0, messages: [], stderr: "", usage });
const context = (): DisplayContext => ({ toolCallId: "parent", state: {}, cwd: process.cwd(), outputPad: 1, showImages: false }) as DisplayContext;

for (const name of ["read", "write", "edit", "bash", "codemode", "python", "search", "recall_memory", "unknown"]) {
	test(`child ${name} uses the native tool row in collapsed and expanded modes`, () => {
		const item: ActivityItem = { type: "toolCall", id: name, name,
			args: { path: "file.ts", code: "text(42)", command: "printf hello", query: "needle", text: "question", description: "Run code" },
			result: { content: [{ type: "text", text: "full output\nsecond line" }], details: { diff: "-old\n+new", firstChangedLine: 1, collapsed: "found 1 result" }, isError: false, durationMs: 42 }, isPartial: false };
		for (const expanded of [false, true, false, true]) {
			const view = new ActivityView();
			view.update([item], { expanded, cwd: process.cwd(), showImages: false, outputPad: 1, resolve: toolRenderers });
			const expected = new ToolExecutionComponent(name, name, item.args, { showImages: false, outputPad: 1 },
				toolRenderers(name), { requestRender() {} } as TUI, process.cwd());
			expected.markExecutionStarted();
			expected.setExpanded(expanded);
			expected.updateResult(item.result!, false);
			const native = expected.render(100);
			while (native.length && !stripVTControlCharacters(native[0]).trim()) native.shift();
			while (native.length && !stripVTControlCharacters(native.at(-1)!).trim()) native.pop();
			assert.deepEqual(view.render(100), native);
			view.dispose();
		}
	});
}

test("main bash and write registrations use the exact shared renderer functions", () => {
	const definitions: Array<{ name: string; renderCall: unknown; renderResult: unknown }> = [];
	const pi = { registerTool(definition: typeof definitions[number]) { definitions.push(definition); } };
	bashOutput(pi as never);
	registerAutoloadRenderOverrides(pi as never);
	for (const [index, shared] of [bashToolRenderers, writeToolRenderers].entries()) {
		assert.equal(definitions[index].renderCall, shared.renderCall);
		assert.equal(definitions[index].renderResult, shared.renderResult);
	}
});

test("collapsed live display keeps five complete entries; expanded includes all narration and native results", () => {
	const renderers = createSubagentRenderers(), ctx = context(), details = base();
	details.messages = [assistant([{ type: "text", text: "discarded narration" }])];
	for (let n = 0; n < 5; n++) {
		details.messages.push(assistant([{ type: "toolCall", id: `tool-${n}`, name: "python", arguments: { description: `step-${n}`, code: `print(${n})` } }]));
		details.messages.push({ role: "toolResult", toolCallId: `tool-${n}`, toolName: "python", content: [{ type: "text", text: `output-${n}` }], details: undefined, isError: false } as Message);
	}
	details.messages.push(assistant([{ type: "text", text: "line-one\nline-two\nline-three\nline-four\nline-five\nline-six" }]));
	const result = { content: [{ type: "text" as const, text: "final answer" }], details };
	const collapsed = plain(renderers.renderResult!(result, { expanded: false, isPartial: true }, theme, ctx));
	assert.doesNotMatch(collapsed, /discarded narration|step-0/);
	assert.match(collapsed, /step-1/);
	assert.match(collapsed, /line-six/);
	assert.doesNotMatch(collapsed, /output-1/);
	const expanded = plain(renderers.renderResult!(result, { expanded: true, isPartial: false }, theme, ctx));
	assert.match(expanded, /discarded narration/);
	assert.match(expanded, /print\(0\)/);
	assert.match(expanded, /output-0/);
	assert.match(expanded, /final answer/);
	assert.match(plain(renderers.renderResult!(result, { expanded: false, isPartial: false }, theme, ctx)), /✓ All done/);
	details.exitCode = 1;
	const failed = plain(renderers.renderResult!(result, { expanded: false, isPartial: false }, theme, ctx));
	assert.match(failed, /done with errors/);
	assert.doesNotMatch(failed, /step-|output-|final answer/);
});

test("expanded replay reads complete archived history and does not duplicate the final answer", (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-display-test-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const archive = new TranscriptArchive(root), writer = archive.create(), details = base();
	for (let n = 0; n < 220; n++) writer.append(assistant([{ type: "text", text: `message-${n}` }]));
	writer.append(assistant([{ type: "text", text: "final answer" }]));
	writer.finish();
	details.transcriptId = writer.id;
	const renderers = createSubagentRenderers(undefined, archive);
	const result = { content: [{ type: "text" as const, text: "final answer" }], details: compactResult(details) };
	const output = plain(renderers.renderResult!(result, { expanded: true, isPartial: false }, theme, context()));
	assert.match(output, /message-0\b/);
	assert.match(output, /message-219/);
	assert.equal(output.match(/final answer/g)?.length, 1);
	fs.rmSync(path.join(root, `${writer.id}.jsonl`));
	assert.match(plain(renderers.renderResult!(result, { expanded: true, isPartial: false }, theme, context())), /History unavailable/);
});

test("native renderer state survives expand-collapse-expand without falling back", () => {
	const view = new ActivityView();
	const item: ActivityItem = { type: "toolCall", id: "bash", name: "bash", args: { command: "echo state" }, isPartial: false,
		result: { content: [{ type: "text", text: "state output" }], details: undefined, isError: false, durationMs: 42 } };
	for (const expanded of [true, false, true]) {
		view.update([item], { expanded, cwd: process.cwd(), showImages: false, outputPad: 1, resolve: toolRenderers });
		const output = plain(view);
		assert.match(output, expanded ? /Took 0\.0s/ : /✓ bash executed/);
		assert.doesNotMatch(output, /"command":/);
	}
	view.dispose();
});


test("native parent redraws do not recursively invalidate child rows", async () => {
	let redraws = 0;
	const parent = new ToolExecutionComponent("subagent", "parent", { agent: "explorer", taskName: "Inspect" },
		{ showImages: false }, createSubagentRenderers() as never,
		{ requestRender() { redraws++; } } as TUI, process.cwd());
	parent.markExecutionStarted();
	const details = base();
	details.messages.push(assistant([{ type: "toolCall", id: "python", name: "python", arguments: { description: "Running" } }]));
	parent.updateResult({ content: [], details, isError: false }, true);
	assert.match(plain(parent), /python/);
	parent.invalidate();
	assert.match(plain(parent, 45), /python/);
	await Promise.resolve();
	assert.ok(redraws < 10, `Unexpected redraw loop: ${redraws}`);
	parent.updateResult({ content: [], details, isError: false }, false);
	assert.match(plain(parent), /All done/);
});

test("expanded streaming native clocks stop on collapse, eviction, completion, and shutdown", (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const renderers = createSubagentRenderers(), ctx = context();
	let invalidations = 0;
	ctx.invalidate = () => { invalidations++; };
	const details = base();
	details.messages = [assistant([{ type: "toolCall", id: "bash", name: "bash", arguments: { command: "sleep 1" } }])];
	details.partialResults = { bash: { content: [{ type: "text", text: "progress" }], details: undefined, isError: false } };
	const result = { content: [], details };
	const expanded = () => renderers.renderResult!(result, { expanded: true, isPartial: true }, theme, ctx);
	assert.match(plain(expanded()), /progress/);
	t.mock.timers.tick(1000);
	renderers.renderResult!(result, { expanded: false, isPartial: true }, theme, ctx);
	t.mock.timers.tick(1000);
	assert.match(plain(expanded()), /progress/);
	renderers.dispose();
	t.mock.timers.tick(5000);
	assert.equal(invalidations, 0); // A disposed view cancels its queued redraw too.
});

test("an interrupted partial result remains visible as a failed child tool in expanded history", () => {
	const details = base();
	details.exitCode = 1;
	details.messages.push(assistant([{ type: "toolCall", id: "bash", name: "bash", arguments: { command: "sleep 1" } }]));
	details.partialResults = { bash: { content: [{ type: "text", text: "last progress" }], details: undefined, isError: false } };
	const output = plain(createSubagentRenderers().renderResult!({ content: [], details }, { expanded: true, isPartial: false }, theme, context()));
	assert.match(output, /last progress/);
	assert.match(output, /Tool interrupted/);
});


test("nested activity has no empty shell-padding lines between narration and tool calls", () => {
	const details = base();
	details.messages = [assistant([
		{ type: "text", text: "First step." },
		{ type: "toolCall", id: "one", name: "read", arguments: { path: "first.ts" } },
		{ type: "text", text: "Next step." },
		{ type: "toolCall", id: "two", name: "read", arguments: { path: "second.ts" } },
		{ type: "text", text: "Finished." },
	])];
	const output = plain(createSubagentRenderers().renderResult!({ content: [], details },
		{ expanded: false, isPartial: true }, theme, context()));
	assert.deepEqual(output.trim().split("\n").map((line) => line.trim()), [
		"First step.", "read first.ts", "Next step.", "read second.ts", "Finished.",
	]);
});

test("subagent tool names and arguments are muted without altering main-agent rendering", () => {
	const details = base();
	details.messages = [assistant([{ type: "toolCall", id: "read", name: "read", arguments: { path: "file.ts" } }])];
	const main = new ToolExecutionComponent("read", "main", { path: "file.ts" }, { showImages: false }, toolRenderers("read"),
		{ requestRender() {} } as TUI, process.cwd());
	const before = main.render(100).join("\n");
	assert.ok(before.includes(theme.getFgAnsi("toolTitle")));
	assert.ok(before.includes(theme.getFgAnsi("accent")));
	const output = createSubagentRenderers().renderResult!({ content: [], details },
		{ expanded: false, isPartial: true }, theme, context()).render(100).join("\n");
	assert.ok(output.includes(theme.getFgAnsi("muted")));
	assert.ok(!output.includes(theme.getFgAnsi("toolTitle")), "child tool title should not use the main colour");
	assert.ok(!output.includes(theme.getFgAnsi("accent")), "child arguments should not use the main accent");
	assert.equal(main.render(100).join("\n"), before);
});


test("compact activity preserves internal blank lines and visible error colours", () => {
	const view = new ActivityView();
	const item: ActivityItem = { type: "toolCall", id: "failed", name: "unknown", args: {}, isPartial: false,
		result: { content: [{ type: "text", text: "first paragraph\n\nsecond paragraph" }], details: undefined, isError: true } };
	view.update([item], { theme, expanded: true, cwd: process.cwd(), showImages: false, outputPad: 1,
		resolve: () => ({ renderCall: () => new Text("heading"), renderResult: (result, _options, theme) =>
			new Text(theme.fg("error", result.content.map((part) => part.type === "text" ? part.text : "").join(""))) }) });
	const output = view.render(80);
	assert.equal(stripVTControlCharacters(output[0]).trim(), "heading");
	assert.equal(stripVTControlCharacters(output.at(-1)!).trim(), "second paragraph");
	assert.ok(output.some((line) => !stripVTControlCharacters(line).trim()), "internal paragraph spacing remains");
	assert.ok(output.join("\n").includes(theme.getFgAnsi("error")), "errors remain visible");
	view.dispose();
});

test("compact activity forwards mouse events to the uncropped native row coordinates", () => {
	const view = new ActivityView();
	let localY: number | undefined;
	view.update([{ type: "toolCall", id: "click", name: "custom", args: {}, isPartial: true }], {
		theme, expanded: false, cwd: process.cwd(), showImages: false, outputPad: 1,
		resolve: () => ({ renderCall: () => ({
			render: () => ["clickable"], invalidate() {},
			handleMouse(event) { localY = event.y; return { handled: true }; },
		}) }),
	});
	const lines = view.render(80);
	assert.equal(lines.length, 1);
	assert.ok(view.handleMouse({ type: "click", button: "left", x: 2, y: 0, screenX: 2, screenY: 10,
		width: 80, height: 1, shift: false, alt: false, ctrl: false })?.handled);
	assert.equal(localY, 0);
	view.dispose();
});


test("child arguments have a subdued accent distinct from narration in both display modes", () => {
	const details = base();
	details.messages = [assistant([
		{ type: "text", text: "Narration stays muted." },
		{ type: "toolCall", id: "read", name: "read", arguments: { path: "file.ts" } },
		{ type: "toolCall", id: "unknown", name: "unknown", arguments: { path: "other.ts" } },
	])];
	const argumentColor = foregroundAnsi(mixColors(theme.colors.mdLink, theme.colors.muted, 0.5), theme.getColorMode());
	assert.notEqual(argumentColor, theme.getFgAnsi("muted"));
	assert.notEqual(argumentColor, theme.getFgAnsi("accent"));
	for (const expanded of [false, true]) {
		const lines = createSubagentRenderers().renderResult!({ content: [], details },
			{ expanded, isPartial: true }, theme, context()).render(100);
		const narration = lines.find((line) => stripVTControlCharacters(line).includes("Narration stays muted."))!;
		assert.ok(narration.includes(theme.getFgAnsi("muted")));
		assert.ok(!narration.includes(argumentColor));
		for (const path of ["file.ts", "other.ts"]) {
			const argument = lines.find((line) => stripVTControlCharacters(line).includes(path))!;
			assert.ok(argument.includes(argumentColor), `${expanded ? "expanded" : "collapsed"} ${path} should use the argument colour`);
		}
	}
});


test("live collapsed activity separates the preview and footer and marks hidden entries", () => {
	const renderers = createSubagentRenderers(), details = base(), ctx = context();
	details.usage = { ...usage, turns: 5 };
	details.messages = Array.from({ length: 7 }, (_, n) => assistant([{ type: "text", text: `entry-${n}` }]));
	const call = plain(renderers.renderCall!({ agent: "explorer", taskName: "Preview", task: details.task }, theme,
		{ ...ctx, isPartial: true, expanded: false }));
	const body = plain(renderers.renderResult!({ content: [], details }, { expanded: false, isPartial: true }, theme, ctx));
	assert.deepEqual(`${call}\n${body}`.split("\n").map((line) => line.trim()), [
		"subagent explorer: Preview [user]", "Inspect output", "", "(...)",
		"entry-2", "entry-3", "entry-4", "entry-5", "entry-6", "", "5 turns",
	]);
	const expanded = plain(renderers.renderResult!({ content: [], details }, { expanded: true, isPartial: true }, theme, ctx));
	assert.doesNotMatch(expanded, /\(\.\.\.\)/);
	assert.match(expanded, /entry-0/);
	assert.deepEqual(plain(renderers.renderResult!({ content: [], details }, { expanded: false, isPartial: false }, theme, ctx))
		.split("\n").map((line) => line.trimEnd()), ["✓ All done"]);
});

test("omission marker appears only once the five-entry window hides earlier activity", () => {
	for (const count of [0, 1, 5, 6]) {
		const details = base();
		details.messages = Array.from({ length: count }, (_, n) => assistant([{ type: "text", text: `entry-${n}` }]));
		const output = plain(createSubagentRenderers().renderResult!({ content: [], details },
			{ expanded: false, isPartial: true }, theme, context()));
		assert.equal(output.includes("(...)"), count > 5);
	}
});

test("archived and private history indicate hidden entries without rendering more than five", (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-display-window-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const archive = new TranscriptArchive(root);
	for (const persist of [true, false]) {
		const writer = archive.create({ persist }), details = base();
		details.transcriptId = writer.id;
		const renderers = createSubagentRenderers(undefined, archive);
		for (let n = 0; n < 5; n++) writer.append(assistant([{ type: "text", text: `archived-${n}` }]));
		const render = () => plain(renderers.renderResult!({ content: [], details },
			{ expanded: false, isPartial: true }, theme, context()));
		assert.doesNotMatch(render(), /\(\.\.\.\)/);
		writer.append(assistant([{ type: "text", text: "archived-5" }]));
		const output = render();
		assert.match(output, /\(\.\.\.\)/);
		assert.doesNotMatch(output, /archived-0/);
		assert.equal(output.match(/archived-/g)?.length, 5);
		writer.finish();
	}
	archive.clearPrivate();
});
