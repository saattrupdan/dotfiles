import assert from "node:assert/strict";
import { test } from "node:test";

import { collapsedSummary, guardMcpGatewayExecute, summarize, summarizeResult } from "./index.ts";

const tavily = (results: unknown[]) => JSON.stringify({ query: "pi", results });

const result = (content: Array<{ type: "text"; text: string } | { type: "image"; mimeType?: string }>, details?: object) => ({
	content,
	details,
});

test("summarizes complete Tavily payloads by result count", () => {
	assert.equal(summarizeResult(result([{ type: "text", text: tavily([]) }])), "Found 0 results");
	assert.equal(summarizeResult(result([{ type: "text", text: tavily([{ title: "one" }]) }])), "Found 1 result");
	assert.equal(
		summarizeResult(result([{ type: "text", text: tavily([{ title: "one" }, { title: "two" }]) }])),
		"Found 2 results",
	);
});

test("ignores copy-paste markers and image blocks while finding JSON", () => {
	assert.equal(
		summarizeResult(
			result([
				{ type: "image", mimeType: "image/png" },
				{ type: "text", text: "[toolCallId: call-123]" },
				{ type: "text", text: tavily([{ title: "one" }]) },
			]),
		),
		"Found 1 result",
	);
});

test("does not guess a count for truncated Tavily output", () => {
	const incomplete = tavily([{ title: "one" }]).slice(0, -2);
	const summary = summarizeResult(
		result([{ type: "text", text: incomplete }], { outputGuard: { truncated: true } }),
	);

	assert.equal(summary, "Completed (output truncated)");
	assert.doesNotMatch(summary, /^\{"query"/);
	assert.equal(collapsedSummary("tavily_search", result([{ type: "text", text: incomplete }], { outputGuard: { truncated: true } })), summary);
});

test("preserves fixed memory summaries for truncated results", () => {
	const truncated = result([{ type: "text", text: "partial memory result" }], { outputGuard: { truncated: true } });

	assert.equal(collapsedSummary("memory_query", truncated), "Remembered a thing");
});

test("keeps image-only results in the collapsed fallback", () => {
	const image = result([{ type: "image", mimeType: "image/png" }]);
	assert.equal(summarizeResult(image), "[image: image/png]");
	assert.equal(collapsedSummary("some_tool", image), "[image: image/png]");
	assert.equal(summarizeResult(result([{ type: "image" }])), "[image: ?]");
});

test("keeps safe fallback and existing scalar summaries", () => {
	assert.equal(summarizeResult(result([{ type: "text", text: "Completed successfully\nwith details" }])), "Completed successfully");
	assert.equal(summarizeResult(result([{ type: "text", text: "" }])), "Done");
	assert.equal(summarize("[1, 2, 3]"), "3 items");
	assert.equal(summarize('"ready"'), "ready");
	assert.equal(summarizeResult(result([{ type: "text", text: "{not valid JSON" }])), "{not valid JSON");
});

test("keeps fixed memory summaries ahead of their payload", () => {
	assert.equal(collapsedSummary("memory_query", result([{ type: "text", text: "a result" }])), "Remembered a thing");
	assert.equal(collapsedSummary("memory_add", result([{ type: "text", text: "stored" }])), "Stored a memory");
	assert.equal(collapsedSummary("memory_update", result([{ type: "text", text: "updated" }])), "Updated a memory");
});

test("rejects gateway calls for currently promoted direct tools without executing them", async () => {
	const directTools = new Set(["memory_query", "tavily_search"]);
	let contacted = false;
	const gateway = guardMcpGatewayExecute(async () => {
		contacted = true;
		return result([{ type: "text", text: "server result" }]);
	}, directTools);

	const rejected = await gateway("call-1", { tool: "memory_query", args: {} });
	assert.equal(contacted, false);
	assert.equal(rejected.details?.error, "direct_tool_use_required");
	assert.match(rejected.content[0].type === "text" ? rejected.content[0].text : "", /call memory_query directly/i);
	assert.match(rejected.content[0].type === "text" ? rejected.content[0].text : "", /not contacted/i);
});

test("allows gateway discovery and non-promoted tool calls", async () => {
	const directTools = new Set(["memory_query"]);
	const calls: unknown[][] = [];
	const gateway = guardMcpGatewayExecute(async (...args) => {
		calls.push(args);
		return result([{ type: "text", text: "server result" }]);
	}, directTools);

	await gateway("call-2", { search: "calendar" });
	await gateway("call-3", { tool: "calendar_list", args: {} });
	assert.equal(calls.length, 2);
});
