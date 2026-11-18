import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { Container, Text } from "@earendil-works/pi-tui";
import { getPackageDir } from "@earendil-works/pi-coding-agent";

const root = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(root, "../_outliner/package.json"));
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { moduleCache: false });
const { patchReadGrouping } = await jiti.import(path.join(root, "index.ts"));
const { readCallRenderers } = await jiti.import(path.join(root, "../_tool-display/renderers.ts"));
// Exercise the same bundled classes used by the installed CLI, not a second dist/index.js graph.
const native = await import(pathToFileURL(path.join(getPackageDir(), "dist/bundle/index.js")));
native.initTheme("dark");
assert.equal(patchReadGrouping(native), true);
const plain = (lines) => lines.map(stripVTControlCharacters).join("\n");
let nextId = 0;

function harness({ attach = true } = {}) {
	const chat = new Container();
	const normalRender = chat.render.bind(chat);
	let redraws = 0;
	const mode = {
		chatContainer: chat,
		ui: { requestRender() { redraws++; } },
		outputPad: 1,
		hideThinkingBlock: true,
		hiddenThinkingLabel: "",
		toolOutputExpanded: false,
		pendingTools: new Map(),
		loadedResourcesContainer: new Container(),
		pendingMessagesContainer: new Container(),
		settingsManager: {
			getShowImages: () => false,
			getImageWidthCells: () => 60,
			getShowCacheMissNotices: () => false,
		},
		sessionManager: { getCwd: () => process.cwd(), getEntries: () => [] },
		getRegisteredToolDefinition: (name) => name === "read" ? readCallRenderers : undefined,
		getMarkdownThemeWithSettings: () => native.getMarkdownTheme(),
		getMarkdownTransformers: () => [],
		showStatus() {},
		isInitialized: true,
		footer: { invalidate() {} },
		programStatus: { handleEvent() {} },
		maybeShowInstallChangeWarning() {},
	};
	for (const name of ["addMessageToChat", "renderSessionItems", "setToolsExpanded", "handleEvent"])
		mode[name] = native.InteractiveMode.prototype[name];
	const context = native.InteractiveMode.prototype.createExtensionUIContext.call(mode);
	if (attach) mode.renderSessionItems([]);
	return { chat, normalRender, mode, context, redraws: () => redraws };
}

function read(h, file = "same.ts", { name = "read", complete = true, error = false, symbol } = {}) {
	const row = new native.ToolExecutionComponent(name, `read-${++nextId}`, { path: file, symbol },
		{ showImages: false, outputPad: 1 }, h.mode.getRegisteredToolDefinition(name), h.mode.ui, process.cwd());
	row.markExecutionStarted();
	if (complete) row.updateResult({ content: [{ type: "text", text: `contents of ${file}` }], isError: error });
	h.chat.addChild(row);
	return row;
}

function assistant(h, content = []) {
	const message = { role: "assistant", content, stopReason: "toolUse" };
	h.mode.addMessageToChat(message);
	return message;
}

function click(h, y = 2, width = 120) {
	const lines = h.chat.render(width);
	return h.chat.handleMouse({ type: "click", button: "left", x: 1, y, width, height: lines.length });
}

test("a single read stays byte-for-byte native", () => {
	const h = harness();
	read(h, "one.ts");
	assert.deepEqual(h.chat.render(120), h.normalRender(120));
	assert.match(plain(h.chat.render(120)), /one\.ts/);
});

test("adjacent reads use native title and argument colours and count calls, not paths", () => {
	const h = harness();
	const rows = [read(h), read(h, "same.ts", { symbol: "one" }), read(h, "same.ts", { symbol: "two" })];
	const originalChildren = h.chat.children;
	const lines = h.chat.render(120);
	const theme = h.context.theme;
	assert.match(plain(lines), /read 3 file chunks/);
	assert.ok(lines.join("\n").includes(`${theme.fg("toolTitle", theme.bold("read"))} ${theme.fg("accent", "3 file chunks")}`));
	assert.doesNotMatch(plain(lines), /same\.ts|contents/);
	assert.deepEqual(h.chat.children, rows);
	assert.equal(h.chat.children, originalChildren, "projection must not replace the native children array");
	assert.equal(lines.length, 4, "native separator, grey top padding, summary, and grey bottom padding");
	for (const line of lines.slice(1)) assert.ok(line.includes(theme.getBgAnsi("toolSuccessBg")));
	assert.equal(stripVTControlCharacters(lines[1]).trim(), "");
	assert.equal(stripVTControlCharacters(lines[3]).trim(), "");
});

test("running reads group immediately and update their count without exposing paths or output", () => {
	const h = harness();
	read(h, "first.ts");
	read(h, "active.ts", { complete: false });
	assert.equal(plain(h.chat.render(120)).trim(), "read 2 file chunks");
	read(h, "next.ts", { complete: false });
	assert.equal(plain(h.chat.render(120)).trim(), "read 3 file chunks");
});

test("commentary and other tools break groups", () => {
	const h = harness();
	read(h, "a.ts");
	read(h, "b.ts");
	assistant(h, [{ type: "text", text: "Checking the next files." }]);
	read(h, "c.ts");
	read(h, "d.ts", { name: "search" });
	read(h, "e.ts");
	const text = plain(h.chat.render(120));
	assert.equal(text.match(/read 2 file chunks/g)?.length, 1);
	assert.match(text, /Checking the next files/);
	assert.match(text, /c\.ts/);
	assert.match(text, /e\.ts/);
	assert.doesNotMatch(text, /read [345] file chunks/);
});

test("invisible tool-only assistant rows do not interrupt sequential reads", () => {
	const h = harness();
	read(h);
	assistant(h, [{ type: "thinking", thinking: "hidden reasoning" }, { type: "toolCall", id: "next", name: "read", arguments: {} }]);
	read(h);
	assert.match(plain(h.chat.render(120)), /read 2 file chunks/);
});

test("visible reasoning is preserved and interrupts a group", () => {
	const h = harness();
	read(h, "before.ts");
	assistant(h, [{ type: "thinking", thinking: "visible reasoning" }]);
	h.chat.children.at(-1).setHideThinkingBlock(false);
	read(h, "after.ts");
	assert.deepEqual(h.chat.render(120), h.normalRender(120));
	assert.match(plain(h.chat.render(120)), /visible reasoning/);
});

test("failed reads stay visible and split successful runs", () => {
	const h = harness();
	read(h, "a.ts");
	read(h, "b.ts");
	read(h, "failed.ts", { error: true });
	read(h, "d.ts");
	read(h, "e.ts");
	const text = plain(h.chat.render(120));
	assert.equal(text.match(/read 2 file chunks/g)?.length, 2);
	assert.match(text, /failed\.ts/);
	assert.match(text, /contents of failed\.ts/);
});

test("a running group splits as soon as a read fails", () => {
	const h = harness();
	read(h, "a.ts");
	const failed = read(h, "b.ts", { complete: false });
	read(h, "c.ts");
	assert.match(plain(h.chat.render(120)), /read 3 file chunks/);
	failed.updateResult({ content: [{ type: "text", text: "permission denied" }], isError: true });
	assert.deepEqual(h.chat.render(120), h.normalRender(120));
	assert.match(plain(h.chat.render(120)), /permission denied/);
});

test("native expand/collapse restores exactly the original calls and outputs", () => {
	const h = harness();
	read(h, "a.ts");
	read(h, "b.ts");
	assert.match(plain(h.chat.render(120)), /read 2 file chunks/);
	h.mode.setToolsExpanded(true);
	assert.deepEqual(h.chat.render(120), h.normalRender(120));
	assert.match(plain(h.chat.render(120)), /contents of a\.ts/);
	assert.match(plain(h.chat.render(120)), /contents of b\.ts/);
	h.mode.setToolsExpanded(false);
	assert.match(plain(h.chat.render(120)), /read 2 file chunks/);
});

test("clicking a summary expands all its reads and native row clicks still work", () => {
	const h = harness();
	const a = read(h, "a.ts");
	const b = read(h, "b.ts");
	const before = h.redraws();
	assert.equal(click(h)?.handled, true);
	assert.ok(h.redraws() > before);
	assert.deepEqual(h.chat.render(120), h.normalRender(120));
	assert.equal(a.expanded, true);
	assert.equal(b.expanded, true);
	assert.equal(click(h, 2)?.handled, true);
	assert.equal(a.expanded, false, "expanded native rows must keep their own click handling");
	assert.equal(b.expanded, true);
	assert.equal(click(h, 0), undefined, "the blank separator is not clickable");
});

test("summary wrapping and mouse coordinates follow terminal width and output padding", () => {
	const h = harness();
	const a = read(h);
	read(h);
	a.setOutputPad(3);
	const lines = h.chat.render(16);
	assert.ok(lines.length > 4);
	assert.equal(click(h, lines.length - 2, 16)?.handled, true);
	assert.equal(a.expanded, true);
	assert.deepEqual(h.chat.render(16), h.normalRender(16));
});

test("native history replay groups without modifying messages, then expands unchanged", () => {
	const h = harness();
	const calls = ["a", "b", "c"].flatMap((id) => [
		{ role: "assistant", content: [{ type: "toolCall", id, name: "read", arguments: { path: `${id}.ts` } }], stopReason: "toolUse" },
		{ role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text: `output ${id}` }], isError: id === "c" },
	]);
	const before = globalThis.structuredClone(calls);
	h.mode.renderSessionItems(calls);
	assert.match(plain(h.chat.render(120)), /read 2 file chunks/);
	assert.match(plain(h.chat.render(120)), /c\.ts/);
	assert.match(plain(h.chat.render(120)), /output c/);
	h.mode.setToolsExpanded(true);
	assert.deepEqual(h.chat.render(120), h.normalRender(120));
	assert.deepEqual(calls, before);
	h.chat.clear();
	h.mode.setToolsExpanded(false);
	h.mode.renderSessionItems(calls);
	assert.match(plain(h.chat.render(120)), /read 2 file chunks/);
});

test("native live tool events create, update, and fail grouped reads", async () => {
	const h = harness();
	for (const id of ["a", "b"]) {
		await h.mode.handleEvent({ type: "tool_execution_start", toolCallId: id, toolName: "read", args: { path: `${id}.ts` } });
	}
	assert.match(plain(h.chat.render(120)), /read 2 file chunks/);
	await h.mode.handleEvent({ type: "tool_execution_end", toolCallId: "a", isError: false,
		result: { content: [{ type: "text", text: "first output" }] } });
	assert.match(plain(h.chat.render(120)), /read 2 file chunks/);
	await h.mode.handleEvent({ type: "tool_execution_end", toolCallId: "b", isError: true,
		result: { content: [{ type: "text", text: "read failed" }] } });
	assert.doesNotMatch(plain(h.chat.render(120)), /file chunks/);
	assert.match(plain(h.chat.render(120)), /read failed/);
});

test("nested subagent rows are not grouped", () => {
	const h = harness();
	const nested = harness();
	read(nested);
	read(nested);
	// An activity display supplies its own container, not the main transcript drawing adapter.
	const activity = new Container();
	for (const row of nested.chat.children) activity.addChild(row);
	h.chat.addChild(activity);
	assert.deepEqual(h.chat.render(120), h.normalRender(120));
	assert.doesNotMatch(plain(h.chat.render(120)), /file chunks/);
});

test("first loading during /reload attaches to an existing chat with a cached UI context", () => {
	const h = harness({ attach: false });
	read(h, "old-a.ts");
	read(h, "old-b.ts");
	assert.deepEqual(h.chat.render(120), h.normalRender(120), "an existing chat has not been attached yet");
	const entries = ["a", "b"].flatMap((id) => [
		{ type: "message", id: `call-${id}`, timestamp: new Date().toISOString(), message: {
			role: "assistant", content: [{ type: "toolCall", id, name: "read", arguments: { path: `${id}.ts` } }], stopReason: "toolUse",
		} },
		{ type: "message", id: `result-${id}`, timestamp: new Date().toISOString(), message: {
			role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text: `output ${id}` }], isError: false,
		} },
	]);
	h.mode.sessionManager.buildContextEntries = () => entries;
	h.mode.renderSessionEntries = native.InteractiveMode.prototype.renderSessionEntries;
	// handleReloadCommand's beforeSessionStart callback takes this exact rebuild path.
	native.InteractiveMode.prototype.rebuildChatFromMessages.call(h.mode);
	assert.match(plain(h.chat.render(120)), /read 2 file chunks/);
	h.mode.setToolsExpanded(true);
	assert.deepEqual(h.chat.render(120), h.normalRender(120));
});

test("reload is idempotent and stale private hooks leave Pi unchanged", () => {
	const h = harness();
	read(h);
	read(h);
	const render = h.chat.render;
	assert.equal(patchReadGrouping(native), true);
	h.mode.renderSessionItems([]);
	assert.equal(h.chat.render, render);
	assert.match(plain(h.chat.render(120)), /read 2 file chunks/);
	assert.equal(patchReadGrouping({}), false);
});

test("non-read transcript mouse handlers still receive their native coordinates", () => {
	const h = harness();
	read(h);
	read(h);
	let received;
	const other = new Text("other row", 0, 0);
	other.handleMouse = (event) => { received = event; return { handled: true }; };
	h.chat.addChild(other);
	assert.equal(click(h, 4)?.handled, true);
	assert.equal(received.y, 0);
	assert.equal(received.height, 1);
});
