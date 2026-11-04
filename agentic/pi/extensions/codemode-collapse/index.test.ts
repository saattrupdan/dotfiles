import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionAPI, ToolRendererResolver } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import codemodeCollapse from "./index.ts";

const theme = {
	fg: (_color: string, value: string) => value,
	bold: (value: string) => value,
};

function lines(component: { render(width: number): string[] }): string[] {
	return component.render(80).map((line) => line.trimEnd());
}

function renderer() {
	let resolve: ToolRendererResolver | undefined;
	codemodeCollapse({ registerToolRenderer: (value: ToolRendererResolver) => { resolve = value; } } as unknown as ExtensionAPI);
	assert.ok(resolve);
	const original = {
		renderCall: () => new Text("full script", 0, 0),
		renderResult: () => new Text("full result", 0, 0),
	};
	assert.equal(resolve("bash", () => original), original);
	const compact = resolve("codemode", () => original);
	assert.ok(compact?.renderCall);
	assert.ok(compact.renderResult);
	return compact;
}

test("codemode hides code and output until expanded", () => {
	const compact = renderer();
	const args = { code: "secret script" };
	const result = { content: [{ type: "text" as const, text: "secret output" }] };
	const context = { expanded: false, isError: false };
	assert.deepEqual(lines(compact.renderCall!(args, theme, context as never)), ["codemode"]);
	assert.deepEqual(lines(compact.renderResult!(result, { expanded: false, isPartial: false }, theme, context as never)), ["✓ codemode executed"]);
	assert.deepEqual(lines(compact.renderCall!(args, theme, { ...context, expanded: true } as never)), ["full script"]);
	assert.deepEqual(lines(compact.renderResult!(result, { expanded: true, isPartial: false }, theme, context as never)), ["full result"]);
});

test("expanded codemode falls back to submitted code when no upstream renderer exists", () => {
	let resolve: ToolRendererResolver | undefined;
	codemodeCollapse({ registerToolRenderer: (value: ToolRendererResolver) => { resolve = value; } } as unknown as ExtensionAPI);
	const compact = resolve!("codemode", () => undefined)!;
	const code = "const answer = 42;\ntext(answer);";
	assert.deepEqual(lines(compact.renderCall!({ code }, theme, { expanded: true } as never)),
		["codemode", "code: const answer = 42;", "text(answer);"]);
	const result = { content: [{ type: "text" as const, text: "complete\noutput" }] };
	assert.deepEqual(lines(compact.renderResult!(result, { expanded: true, isPartial: false }, theme, {} as never)),
		["complete", "output"]);
});

test("codemode reports running and failure states without leaking output", () => {
	const compact = renderer();
	const result = { content: [{ type: "text" as const, text: "private error details" }] };
	assert.deepEqual(lines(compact.renderResult!(result, { expanded: false, isPartial: true }, theme, { isError: false } as never)), ["⋯ codemode running"]);
	assert.deepEqual(lines(compact.renderResult!(result, { expanded: false, isPartial: false }, theme, { isError: true } as never)), ["✗ codemode failed"]);
});
