import assert from "node:assert/strict";
import test from "node:test";

import {
	buildSearchUrl,
	executeSearch,
	normalizeResults,
	parseSearchResponse,
} from "./index.ts";

test("buildSearchUrl maps SearXNG parameters and always requests JSON", () => {
	const url = new URL(buildSearchUrl("http://127.0.0.1:8888", {
		query: "privacy cats",
		language: "da",
		categories: "general,news",
		time_range: "week",
		safe_search: 2,
		page: 3,
	}));
	assert.equal(url.pathname, "/search");
	assert.equal(url.searchParams.get("q"), "privacy cats");
	assert.equal(url.searchParams.get("format"), "json");
	assert.equal(url.searchParams.get("language"), "da");
	assert.equal(url.searchParams.get("safesearch"), "2");
	assert.equal(url.searchParams.get("pageno"), "3");
});

test("normalization keeps HTTP(S), strips fragments, and dedupes only web URLs", () => {
	const results = normalizeResults([
		{ title: "one", url: "HTTPS://Example.com/a#tracking", content: "a" },
		{ title: "duplicate", url: "https://example.com/a", content: "b" },
		{ title: "answer card", content: "no URL" },
		{ title: "unsafe", url: "javascript:alert(1)" },
		{ title: "second answer card", content: "no URL" },
	]);
	assert.equal(results.length, 3);
	assert.equal(results[0]?.url, "https://example.com/a");
	assert.equal(results[1]?.url, undefined);
	assert.equal(results[2]?.url, undefined);
});

test("response parsing preserves engine warnings and marks partial failures", () => {
	const outcome = parseSearchResponse({
		number_of_results: 12,
		results: [{ title: "result", url: "https://example.test", engines: ["brave", "bing"], category: "news", publishedDate: "today" }],
		unresponsive_engines: ["google", ["bing", "timeout"]],
	});
	assert.equal(outcome.status, "partial_failure");
	assert.deepEqual(outcome.warnings, ["google", "bing: timeout"]);
	assert.deepEqual(outcome.results[0]?.engines, ["brave", "bing"]);
	assert.equal(outcome.results[0]?.category, "news");
});

test("response parsing distinguishes malformed and empty payloads", () => {
	assert.equal(parseSearchResponse({ results: "not an array" }).status, "malformed");
	assert.equal(parseSearchResponse({ results: [] }).status, "empty");
});

test("execution distinguishes non-2xx, malformed JSON, and unavailable service", async () => {
	const response = (status: number, body: string) => new Response(body, { status });
	assert.equal((await executeSearch({ query: "x" }, undefined, async () => response(503, "down"))).status, "non_2xx");
	assert.equal((await executeSearch({ query: "x" }, undefined, async () => response(200, "{"))).status, "malformed");
	assert.equal((await executeSearch({ query: "x" }, undefined, async () => { throw new Error("connection refused"); })).status, "unavailable");
});

test("execution reports a timeout and aborts the request", async () => {
	const outcome = await executeSearch({ query: "x" }, undefined, (_url, init) => new Promise<Response>((_resolve, reject) => {
		init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
	}), 5);
	assert.equal(outcome.status, "timeout");
});
