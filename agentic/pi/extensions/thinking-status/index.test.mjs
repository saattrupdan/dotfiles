import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
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

function harness() {
	const handlers = new Map();
	const listeners = new Map();
	const mode = {
		ui: { requestRender() {} },
		editor: { embedWorkingStatus: true, borderColor: (text) => theme.fg("muted", text), setWorkingStatusIndicator() {} },
		workingIndicatorOptions: { frames: ["*"] },
		defaultWorkingMessage: "Working...",
		showStatusIndicator(indicator) { this.activeStatusIndicator = indicator; },
	};
	const ui = InteractiveMode.prototype.createExtensionUIContext.call(mode);
	const ctx = {
		ui: {
			setWorkingMessage: ui.setWorkingMessage,
			setWorkingVisible() {},
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
	InteractiveMode.prototype.showWorkingStatusIndicator.call(mode);
	return {
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
	assert.equal(h.mode.workingMessage, undefined);
	h.emit("agent_end");
	assert.equal(h.mode.workingMessage, undefined);
});
