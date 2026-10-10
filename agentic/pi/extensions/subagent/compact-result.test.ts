import assert from "node:assert/strict";
import test from "node:test";
import type { Message } from "@earendil-works/pi-ai";
import { compactMessage, compactResult } from "./compact-result.ts";

const toolResult = (name: string, details?: unknown): Message => ({
	role: "toolResult", toolCallId: "id", toolName: name,
	content: [{ type: "text", text: "x".repeat(2_000_000) }],
	isError: false, timestamp: Date.now(), details,
}) as Message;

test("drops large tool payloads but retains call metadata and nested subagent history", () => {
	const nested = { messages: [toolResult("read")], agent: "explorer" };
	const result = compactMessage(toolResult("subagent", nested)) as Message & { details: typeof nested };
	assert.equal(result.content.length, 0);
	assert.equal(result.details.agent, "explorer");
	assert.equal(result.details.messages[0].content.length, 0);
	assert.ok(JSON.stringify(result).length < 1_000);
});

test("keeps a bounded final answer and tool-call preview, without thinking", () => {
	const message = {
		role: "assistant", content: [
			{ type: "thinking", thinking: "secret".repeat(100_000) },
			{ type: "toolCall", id: "id", name: "bash", arguments: { command: "x".repeat(30_000) } },
			{ type: "text", text: "answer".repeat(30_000) },
		],
	} as Message;
	const result = compactMessage(message);
	assert.equal(result.content.length, 2);
	assert.ok(JSON.stringify(result).length < 70_000);
	assert.match(JSON.stringify(result), /answer/);
});

test("retains bounded live nested progress but drops it from persisted results", () => {
	const child = { messages: [toolResult("read")], partialResults: { running: { details: { messages: [toolResult("bash")] } } } };
	const live = compactResult(child, true);
	assert.ok(JSON.stringify(live).length < 2_000);
	assert.ok(live.partialResults?.running);
	assert.equal(compactResult(child).partialResults, undefined);
});

test("bounds message history and removes live partials", () => {
	const message = toolResult("read");
	const result = compactResult({ messages: Array(300).fill(message) as Message[], partialResults: { id: "huge" } });
	assert.equal(result.messages.length, 200);
	assert.equal(result.partialResults, undefined);
	assert.ok(JSON.stringify(result).length < 100_000);
});
