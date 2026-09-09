import assert from "node:assert/strict";
import { test } from "node:test";

import { collapsedSummary, summarize, summarizeResult } from "./index.ts";

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
