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


test("only failed nested bash rows mute the failure label and use normal grey", () => {
	const view = new ActivityView();
	const failure = { content: [{ type: "text" as const, text: "Command exited with code 1" }], details: undefined,
		isError: true, durationMs: 42 };
	const before = structuredClone(failure);
	const main = new ToolExecutionComponent("bash", "main-bash", { command: "exit 1" },
		{ showImages: false, outputPad: 1 }, bashToolRenderers, { requestRender() {} } as TUI, process.cwd());
	main.markExecutionStarted();
	main.updateResult(failure, false);
	for (const expanded of [false, true, false]) {
		main.setExpanded(expanded);
		const mainLines = main.render(100);
		assert.ok(mainLines.join("\n").includes(theme.getBgAnsi("toolErrorBg")), "main bash retains its red failure background");
		view.update([{ type: "toolCall", id: "child-bash", name: "bash", args: { command: "exit 1" }, result: failure, isPartial: false }],
			{ theme, expanded, cwd: process.cwd(), showImages: false, outputPad: 1, resolve: toolRenderers });
		const lines = view.render(100), raw = lines.join("\n");
		assert.ok(!raw.includes(theme.getBgAnsi("toolErrorBg")), "nested bash should not retain the red background");
		assert.ok(raw.includes(theme.getBgAnsi("toolSuccessBg")), "nested bash keeps the normal grey background");
		assert.match(stripVTControlCharacters(raw), expanded ? /Command exited with code 1/ : /bash failed/);
		if (!expanded) {
			assert.ok(!raw.includes(theme.getFgAnsi("error")), "nested bash failure label is not bright red");
			const status = lines.find((line) => stripVTControlCharacters(line).includes("✗ bash failed"))!;
			assert.ok(status.includes(theme.getFgAnsi("muted")), "nested bash failure label is muted grey");
			assert.ok(mainLines.join("\n").includes(theme.getFgAnsi("error")), "main bash keeps its red failure label");
		}
		const expected = mainLines.map(stripVTControlCharacters);
		while (expected.length && !expected[0].trim()) expected.shift();
		while (expected.length && !expected.at(-1)!.trim()) expected.pop();
		assert.deepEqual(lines.map(stripVTControlCharacters), expected, "only styling changes, not layout or failure output");
	}
	assert.deepEqual(failure, before, "presentation does not change the error flag or payload");
	view.dispose();
});

test("nested non-bash failures keep their existing backgrounds", () => {
	const view = new ActivityView();
	view.update([{ type: "toolCall", id: "child-read", name: "read", args: { path: "missing.ts" }, isPartial: false,
		result: { content: [{ type: "text", text: "File not found" }], details: undefined, isError: true } }],
		{ theme, expanded: false, cwd: process.cwd(), showImages: false, outputPad: 1, resolve: toolRenderers });
	assert.ok(view.render(100).join("\n").includes(theme.getBgAnsi("toolErrorBg")));
	view.dispose();
});

test("the outer subagent retains its native grey shell and blank padding rows", () => {
	const renderers = createSubagentRenderers();
	assert.equal(renderers.renderShell, undefined, "do not override the native outer shell");
	const details = base();
	details.messages = [assistant([{ type: "toolCall", id: "child", name: "bash", arguments: { command: "exit 1" } }]),
		{ role: "toolResult", toolCallId: "child", toolName: "bash", content: [{ type: "text", text: "Command exited with code 1" }],
			details: undefined, isError: true } as Message];
	const parent = new ToolExecutionComponent("subagent", "parent", { agent: "reviewer", taskName: "Check bash", task: "Run exit 1" },
		{ showImages: false }, renderers as never, { requestRender() {} } as TUI, process.cwd());
	parent.markExecutionStarted();
	parent.updateResult({ content: [], details, isError: false }, true);
	for (const expanded of [false, true]) {
		parent.setExpanded(expanded);
		const lines = parent.render(100);
		for (const line of [lines[1]!, lines.at(-1)!]) {
			assert.equal(stripVTControlCharacters(line).trim(), "");
			assert.ok(line.includes(theme.getBgAnsi("toolPendingBg")), "native blank padding rows retain the grey background");
		}
		assert.ok(!lines.join("\n").includes(theme.getBgAnsi("toolErrorBg")), "the child does not add red inside the outer grey card");
	}
	renderers.dispose();
});


test("nested search success statuses are grey while main-agent search stays green", () => {
	for (const collapsed of ["Found 0 files, 0 defs, 13 refs", undefined]) {
		const result = { content: [{ type: "text" as const, text: "Full search output" }], details: collapsed ? { collapsed } : undefined, isError: false };
		const before = structuredClone(result), view = new ActivityView();
		const main = new ToolExecutionComponent("search", "main-search", { query: "needle" }, {},
			toolRenderers("search"), { requestRender() {} } as TUI, process.cwd());
		main.updateResult(result, false);
		const mainBefore = main.render(100).join("\n");
		assert.ok(mainBefore.includes(theme.getFgAnsi("success")), "main search keeps its green status");
		view.update([{ type: "toolCall", id: "child-search", name: "search", args: { query: "needle" }, result, isPartial: false }],
			{ theme, expanded: false, cwd: process.cwd(), showImages: false, outputPad: 1, resolve: toolRenderers });
		const lines = view.render(100), status = lines.find((line) => stripVTControlCharacters(line).includes("✓"))!;
		assert.ok(status.includes(theme.getFgAnsi("muted")), "child search status is grey");
		assert.ok(!status.includes(theme.getFgAnsi("success")), "child search status is not green");
		assert.ok(stripVTControlCharacters(status).includes(collapsed ?? "search completed"));
		assert.ok(lines.join("\n").includes(theme.getBgAnsi("toolSuccessBg")), "normal grey background remains");
		assert.equal(main.render(100).join("\n"), mainBefore);
		assert.deepEqual(result, before, "only presentation changes, not search results");
		view.dispose();
	}
});


test("nested bash success labels are grey while main-agent bash stays green", () => {
	const result = { content: [{ type: "text" as const, text: "Success colour check" }], details: undefined, isError: false, durationMs: 42 };
	const before = structuredClone(result), view = new ActivityView();
	const args = { command: "printf 'Success colour check\\n'" };
	const main = new ToolExecutionComponent("bash", "main-bash-success", args, { showImages: false, outputPad: 1 },
		bashToolRenderers, { requestRender() {} } as TUI, process.cwd());
	main.markExecutionStarted();
	main.updateResult(result, false);
	for (const expanded of [false, true, false]) {
		main.setExpanded(expanded);
		const mainLines = main.render(100);
		view.update([{ type: "toolCall", id: "child-bash-success", name: "bash", args, result, isPartial: false }],
			{ theme, expanded, cwd: process.cwd(), showImages: false, outputPad: 1, resolve: toolRenderers });
		const lines = view.render(100);
		if (!expanded) {
			const status = lines.find((line) => stripVTControlCharacters(line).includes("✓ bash executed"))!;
			assert.ok(status.includes(theme.getFgAnsi("muted")), "nested bash success label is grey");
			assert.ok(!status.includes(theme.getFgAnsi("success")), "nested bash success label is not green");
			assert.ok(mainLines.join("\n").includes(theme.getFgAnsi("success")), "main bash success label stays green");
		} else assert.match(plain(view), /Success colour check/);
		assert.ok(lines.join("\n").includes(theme.getBgAnsi("toolSuccessBg")), "normal grey background remains");
		const expected = mainLines.map(stripVTControlCharacters);
		while (expected.length && !expected[0].trim()) expected.shift();
		while (expected.length && !expected.at(-1)!.trim()) expected.pop();
		assert.deepEqual(lines.map(stripVTControlCharacters), expected, "layout and output remain native");
		assert.deepEqual(main.render(100), mainLines, "main bash rendering is unchanged");
	}
	assert.deepEqual(result, before, "presentation does not change success flags or output");
	view.dispose();
});


for (const name of ["skill", "web_search", "python", "code_tree"]) {
	test(`nested ${name} success and error text is grey without changing main-agent colours`, () => {
		for (const outcome of name === "code_tree" ? ["ok", "fallback", "error"] : ["ok", "error"]) {
			const isError = outcome === "error";
			const colour = isError ? "error" : "success";
			const text = isError ? theme.fg("error", `${name} failed`)
				: name === "code_tree" && outcome === "ok" ? "# tree src (2 files, depth 1)\na.ts\nb.ts" : "Full tool output";
			const details = name === "skill" ? (isError ? undefined : { name: "commit" })
				: name === "web_search" ? { status: isError ? "unavailable" : "ok", resultCount: 2 } : undefined;
			const result = { content: [{ type: "text" as const, text }], details, isError };
			const before = structuredClone(result), view = new ActivityView();
			const args = name === "skill" ? { name: "commit" } : name === "web_search" ? { query: "example" }
				: name === "code_tree" ? { path: "src", depth: 1 }
				: { description: "Preview Python status", code: isError ? "raise RuntimeError('check')" : "print('check')" };
			const main = new ToolExecutionComponent(name, `main-${name}`, args, { showImages: false, outputPad: 1 },
				toolRenderers(name), { requestRender() {} } as TUI, process.cwd());
			main.updateResult(result, false);
			for (const expanded of [false, true, false]) {
				main.setExpanded(expanded);
				const mainLines = main.render(100);
				if (!expanded) assert.ok(mainLines.join("\n").includes(theme.getFgAnsi(colour)), "main tool retains its status colour");
				view.update([{ type: "toolCall", id: `child-${name}`, name, args, result, isPartial: false }],
					{ theme, expanded, cwd: process.cwd(), showImages: false, outputPad: 1, resolve: toolRenderers });
				const lines = view.render(100), raw = lines.join("\n");
				assert.ok(!raw.includes(theme.getFgAnsi("success")), "child output is not green");
				assert.ok(!raw.includes(theme.getFgAnsi("error")), "child output is not bright red");
				if (!expanded || isError) assert.ok(raw.includes(theme.getFgAnsi("muted")), "child status text is muted grey");
				assert.ok(raw.includes(theme.getBgAnsi(isError ? "toolErrorBg" : "toolSuccessBg")), "backgrounds are unchanged");
				const expected = mainLines.map(stripVTControlCharacters);
				while (expected.length && !expected[0].trim()) expected.shift();
				while (expected.length && !expected.at(-1)!.trim()) expected.pop();
				assert.deepEqual(lines.map(stripVTControlCharacters), expected, "layout and visible output remain native");
				assert.deepEqual(main.render(100), mainLines, "main-agent rendering is unchanged");
			}
			assert.deepEqual(result, before, "error flags and full payload are preserved");
			view.dispose();
		}
	});
}
