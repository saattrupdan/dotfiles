import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { InteractiveMode } from "@earendil-works/pi-coding-agent";

const root = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(root, "..", "_outliner", "package.json"));
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { moduleCache: false });
const thinkingStatus = await jiti.import(path.join(root, "index.ts"), { default: true });
const runtimeRoot = path.dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
const { loadThemeFromPath } = await import(pathToFileURL(path.join(runtimeRoot, "modes/interactive/theme/theme.js")));
const theme = loadThemeFromPath(path.join(root, "../../themes/gruvbox.json"), "truecolor");

function harness({ started = true } = {}) {
	const handlers = new Map();
	const listeners = new Map();
	const mode = {
		ui: { requestRender() {} },
		editor: { embedWorkingStatus: true, borderColor: (text) => theme.fg("muted", text), setWorkingStatusIndicator() {} },
		workingIndicatorOptions: { frames: ["*"] },
		defaultWorkingMessage: "Working...",
		session: { isStreaming: false },
		showStatusIndicator(indicator) { this.activeStatusIndicator = indicator; },
		showWorkingStatusIndicator() { InteractiveMode.prototype.showWorkingStatusIndicator.call(this); },
		setWorkingVisible(visible) { InteractiveMode.prototype.setWorkingVisible.call(this, visible); },
		clearStatusIndicator() { this.activeStatusIndicator = undefined; },
	};
	const ui = InteractiveMode.prototype.createExtensionUIContext.call(mode);
	const ctx = {
		ui: {
			setWorkingMessage: ui.setWorkingMessage,
			setWorkingVisible: ui.setWorkingVisible,
			setHiddenThinkingLabel() {},
			theme,
		},
	};
	thinkingStatus({
		on: (name, handler) => handlers.set(name, handler),
		events: { on: (name, handler) => listeners.set(name, handler) },
	});
	const emit = (name, event = {}) => handlers.get(name)?.(event, ctx);
	emit("session_start");
	if (started) InteractiveMode.prototype.showWorkingStatusIndicator.call(mode);
	return {
		ctx,
		emit,
		override: (label) => listeners.get("thinking-status:override")({ label }),
		mode,
		render: () => mode.activeStatusIndicator.renderInBorder(120),
		setBorderColor(color) {
			mode.editor.borderColor = (text) => theme.fg(color, text);
			mode.activeStatusIndicator.invalidate();
		},
	};
}

function foregroundAt(line, text) {
	const index = line.indexOf(text);
	assert.notEqual(index, -1, `Missing label: ${text}`);
	// eslint-disable-next-line no-control-regex -- Inspect the rendered ANSI foreground at the label.
	return [...line.slice(0, index).matchAll(/\x1b\[([\d;]*)m/g)].at(-1)?.[0];
}

test("cleanup continuation restores the embedded spinner and phase label without turn_start", () => {
	const h = harness({ started: false });
	h.mode.session.isStreaming = true;
	h.emit("agent_start");
	assert.ok(h.mode.activeStatusIndicator, "the resumed agent must show the editor-border spinner");
	h.emit("message_update", { message: { content: [{ type: "thinking" }] } });
	assert.match(h.render(), /Thinking\.\.\./);
	h.emit("tool_execution_start", { toolCallId: "read-on-main", toolName: "read" });
	assert.match(h.render(), /Reading\.\.\./);
	assert.equal(h.mode.activeStatusIndicator.spinnerColorFn("*"), h.mode.editor.borderColor("*"));
	h.mode.session.isStreaming = false;
	h.emit("agent_settled");
	assert.equal(h.mode.activeStatusIndicator, undefined, "even a fast continuation must stop its spinner");
	assert.equal(h.mode.workingVisible, true, "the next ordinary prompt can show its indicator");
});

test("the default Working label stays neutral from startup through fallback transitions", () => {
	const h = harness();
	h.setBorderColor("thinkingHigh");
	assert.equal(foregroundAt(h.render(), "Working..."), theme.getFgAnsi("muted"));
	h.mode.workingMessage = undefined;
	h.mode.activeStatusIndicator.setMessage("Working...");
	h.emit("agent_start");
	assert.equal(foregroundAt(h.render(), "Working..."), theme.getFgAnsi("muted"));
	h.mode.activeStatusIndicator.setMessage("Working...");
	h.emit("tool_execution_start", { toolCallId: "unknown-1", toolName: "unmapped_tool" });
	assert.equal(foregroundAt(h.render(), "Working..."), theme.getFgAnsi("muted"));
	h.emit("message_update", { message: { content: [{ type: "thinking" }] } });
	h.emit("message_update", { message: { content: [{ type: "text", text: "An answer" }] } });
	assert.equal(foregroundAt(h.render(), "Working..."), theme.getFgAnsi("muted"));
	h.emit("tool_execution_start", { toolCallId: "read-1", toolName: "read" });
	h.emit("tool_execution_end", { toolCallId: "read-1" });
	assert.equal(foregroundAt(h.render(), "Working..."), theme.getFgAnsi("muted"));
	h.override("Retrying...");
	h.override(undefined);
	assert.equal(foregroundAt(h.render(), "Working..."), theme.getFgAnsi("muted"));
});

test("background search indexing cannot restore an orange native fallback", { timeout: 10000 }, async () => {
	const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "pi-search-status-"));
	const previousHome = process.env.HOME;
	process.env.HOME = sandbox;
	try {
		const repo = path.join(sandbox, "repo");
		fs.mkdirSync(repo);
		execFileSync("git", ["init", "--quiet", repo]);
		fs.writeFileSync(path.join(repo, "example.ts"), "export const example = 1;\n");
		execFileSync("git", ["add", "."], { cwd: repo });
		const h = harness();
		h.setBorderColor("thinkingHigh");
		const updates = [];
		const completed = Promise.withResolvers();
		const ui = {
			...h.ctx.ui,
			setWorkingMessage(message) {
				h.ctx.ui.setWorkingMessage(message);
				if (message === undefined) completed.resolve();
			},
			setStatus(key, message) {
				updates.push([key, message]);
				if (message === undefined) completed.resolve();
			},
		};
		const search = await jiti.import(path.join(root, "../search/index.ts"), { default: true });
		let tool;
		await search({ registerTool(value) { tool = value; } });
		const result = await tool.execute("search-1", { query: "example" }, undefined, undefined, {
			cwd: repo, hasUI: true, ui,
		});
		assert.match(result.content[0].text, /example/);
		// The tool returns before reconciliation completes. A normal phase update
		// restores the grey label, then the background completion used to clear it.
		h.emit("message_update", { message: { content: [{ type: "text", text: "Answer" }] } });
		await completed.promise;
		assert.equal(foregroundAt(h.render(), "Working..."), theme.getFgAnsi("muted"));
		assert.equal(updates[0][0], "search-index");
		assert.match(updates[0][1], /Updating search index/);
		assert.deepEqual(updates.at(-1), ["search-index", undefined]);
	} finally {
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		fs.rmSync(sandbox, { recursive: true, force: true });
	}
});

test("an active subagent label stays neutral when the embedded editor turns orange", () => {
	const h = harness();
	h.emit("tool_execution_start", { toolCallId: "subagent-1", toolName: "subagent" });
	assert.equal(foregroundAt(h.render(), "Whipping the subagents..."), theme.getFgAnsi("muted"));

	for (const color of ["thinkingHigh", "thinkingXhigh", "bashMode", "thinkingLow"]) {
		h.setBorderColor(color);
		assert.equal(foregroundAt(h.render(), "Whipping the subagents..."), theme.getFgAnsi("muted"));
	}
	h.setBorderColor("thinkingHigh");
	assert.equal(h.mode.activeStatusIndicator.spinnerColorFn("*"), theme.fg("thinkingHigh", "*"));
});

test("streaming, overlapping tools, and overrides all keep neutral activity text", () => {
	const h = harness();
	h.setBorderColor("thinkingHigh");
	h.emit("message_update", { message: { content: [{ type: "thinking" }] } });
	assert.equal(foregroundAt(h.render(), "Thinking..."), theme.getFgAnsi("muted"));
	h.emit("message_update", { message: { content: [{ type: "toolCall", name: "subagent" }] } });
	assert.equal(foregroundAt(h.render(), "Whipping the subagents..."), theme.getFgAnsi("muted"));
	h.emit("tool_execution_start", { toolCallId: "subagent-1", toolName: "subagent" });
	h.emit("tool_execution_start", { toolCallId: "read-1", toolName: "read" });
	assert.equal(foregroundAt(h.render(), "Reading..."), theme.getFgAnsi("muted"));
	h.override("Retrying...");
	assert.equal(foregroundAt(h.render(), "Retrying..."), theme.getFgAnsi("muted"));
	h.override(undefined);
	assert.equal(foregroundAt(h.render(), "Reading..."), theme.getFgAnsi("muted"));
	h.emit("tool_execution_end", { toolCallId: "read-1" });
	assert.equal(foregroundAt(h.render(), "Whipping the subagents..."), theme.getFgAnsi("muted"));
	h.emit("message_end");
	h.emit("tool_execution_end", { toolCallId: "subagent-1" });
	assert.equal(foregroundAt(h.render(), "Working..."), theme.getFgAnsi("muted"));
	h.emit("agent_end");
	assert.equal(foregroundAt(h.render(), "Working..."), theme.getFgAnsi("muted"));
});
