import assert from "node:assert/strict";
import test from "node:test";
import { WorkingStatus } from "./status.ts";
import extension from "../thinking-status/index.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

test("working labels match native spelling during streaming and execution", () => {
	const status = new WorkingStatus();
	assert.equal(status.message(false), undefined);
	assert.equal(status.message(true), "Working...");
	for (const [name, label] of Object.entries({
		read: "Reading...",
		write: "Writing...",
		edit: "Editing...",
		bash: "Bashing...",
		store_memory: "Storing to memory…",
		recall_memory: "Recalling from memory…",
		subagent: "Whipping the subagents...",
		skill: "Upskilling...",
	})) {
		status.update("message_update", { content: [{ type: "toolCall", name }] });
		assert.equal(status.message(true), label);
		status.update("tool_execution_start", { toolCallId: name, name });
		status.update("message_end", null);
		assert.equal(status.message(true), label);
		status.update("tool_execution_end", { toolCallId: name });
		assert.equal(status.message(true), "Working...");
	}
	status.update("message_update", { content: [{ type: "thinking" }] });
	assert.equal(status.message(true), "Thinking...");
	status.update("agent_settled", null);
	assert.equal(status.message(false), undefined);
});
test("overrides win, latest overlapping tool restores prior work and completed turns clear", () => {
	const s = new WorkingStatus();
	s.update("message_update", { content: [{ type: "thinking" }] });
	s.update("tool_execution_start", { toolCallId: "1", name: "bash" });
	s.update("tool_execution_start", { toolCallId: "2", name: "read" });
	assert.equal(s.label, "Reading...");
	s.update("working_override", { label: "Preparing worktree..." });
	assert.equal(s.message(false), "Preparing worktree...");
	s.update("tool_execution_end", { toolCallId: "2" });
	s.update("working_override", {});
	assert.equal(s.label, "Bashing...");
	s.update("tool_execution_end", { toolCallId: "1" });
	assert.equal(s.label, "Thinking...");
	s.update("agent_end", null);
	assert.equal(s.label, undefined);
});
test("laptop UI uses the shared status and keeps unknown tools on the native default", () => {
	type UI = {
		setWorkingMessage: (label?: string) => void;
		setWorkingVisible: (visible: boolean) => void;
		setHiddenThinkingLabel: (label: string) => void;
	};
	type Handler = (event: Record<string, unknown>, ctx: { ui: UI }) => void;
	const hooks = new Map<string, Handler>();
	let override!: (value: unknown) => void;
	let label: string | undefined;
	let visible = false;
	const ctx = {
		ui: {
			theme: { fg: (_color: string, text: string) => text },
			setWorkingMessage: (value?: string) => (label = value),
			setWorkingVisible: (value: boolean) => (visible = value),
			setHiddenThinkingLabel: () => {},
		},
	};
	extension({
		on: (kind: string, handler: Handler) => hooks.set(kind, handler),
		events: { on: (_kind: string, handler: typeof override) => (override = handler) },
	} as unknown as ExtensionAPI);
	hooks.get("session_start")!({}, ctx);
	hooks.get("message_update")!({ message: { content: [{ type: "thinking" }] } }, ctx);
	assert.equal(label, "Thinking...");
	hooks.get("tool_execution_start")!({ toolName: "store_memory", toolCallId: "m" }, ctx);
	assert.equal(label, "Storing to memory…");
	override({ label: "Preparing worktree..." });
	assert(visible);
	assert.equal(label, "Preparing worktree...");
	override({});
	assert.equal(label, "Storing to memory…");
	hooks.get("agent_end")!({}, ctx);
	assert.equal(label, undefined);
	hooks.get("tool_execution_start")!({ toolName: "unknown", toolCallId: "?" }, ctx);
	assert.equal(label, undefined);
});
