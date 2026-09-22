import assert from "node:assert/strict";
import { test } from "node:test";

import noRepeatExtension from "./index.ts";

type ToolCallEvent = { toolName: string; input: unknown };
type ToolCallResult = { block: true; reason: string } | undefined;
type Context = { sessionManager: { getSessionId(): string } };
type Handler = (event: ToolCallEvent, ctx: Context) => Promise<ToolCallResult>;

function createGuard(): (toolName: string, input: unknown) => Promise<ToolCallResult> {
	const handlers = new Map<string, Handler>();
	const pi = {
		on(event: string, handler: Handler) {
			handlers.set(event, handler);
		},
	};
	noRepeatExtension(pi as never);

	const ctx: Context = {
		sessionManager: { getSessionId: () => "test-session" },
	};
	const toolCall = handlers.get("tool_call");
	assert.ok(toolCall);

	return (toolName, input) => toolCall({ toolName, input }, ctx);
}

test("allows two different skill loads", async () => {
	const call = createGuard();

	assert.equal(await call("skill", { name: "python" }), undefined);
	assert.equal(await call("skill", { name: "markdown" }), undefined);
});

test("does not combine calls separated by other tools into an alternating loop", async () => {
	const call = createGuard();

	assert.equal(await call("skill", { name: "python" }), undefined);
	assert.equal(await call("read", { path: "one.md" }), undefined);
	assert.equal(await call("skill", { name: "markdown" }), undefined);
	assert.equal(await call("search", { query: "one" }), undefined);
	assert.equal(await call("skill", { name: "python" }), undefined);
	assert.equal(await call("bash", { command: "true" }), undefined);
	assert.equal(await call("skill", { name: "markdown" }), undefined);
});

test("blocks an uninterrupted alternating loop", async () => {
	const call = createGuard();

	assert.equal(await call("search", { query: "one" }), undefined);
	assert.equal(await call("search", { query: "two" }), undefined);
	assert.equal(await call("search", { query: "one" }), undefined);
	const result = await call("search", { query: "two" });

	assert.equal(result?.block, true);
	assert.match(result?.reason ?? "", /Alternating loop detected/);
});

test("still blocks immediate duplicate calls", async () => {
	const call = createGuard();

	assert.equal(await call("read", { path: "one.md" }), undefined);
	const result = await call("read", { path: "one.md" });

	assert.equal(result?.block, true);
	assert.match(result?.reason ?? "", /Re-reading the same path/);
});
