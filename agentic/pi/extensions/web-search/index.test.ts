import assert from "node:assert/strict";
import test from "node:test";

import registerWebSearch, {
	buildSearchUrl,
	executeSearch,
	normalizeResults,
	parseSearchResponse,
	type SearchParams,
} from "./index.ts";

interface ToolResult {
	content: Array<{ type: string; text?: string }>;
	details?: { status?: string; resultCount?: number; warnings?: string[] };
}

interface RenderComponent {
	render(width: number): string[];
}

interface RegisteredTool {
	name: string;
	executionMode?: string;
	execute(toolCallId: string, params: SearchParams, signal: AbortSignal): Promise<ToolResult>;
	renderCall(args: Record<string, unknown>, theme: unknown): RenderComponent;
	renderResult(result: ToolResult, options: unknown, theme: unknown): RenderComponent;
}

const plainTheme = {
	fg: (_role: string, value: string) => value,
	bold: (value: string) => value,
};

function captureTool(): RegisteredTool {
	let registered: RegisteredTool | undefined;
	registerWebSearch({
		registerTool(tool: unknown) {
			registered = tool as RegisteredTool;
		},
	} as never);
	assert.ok(registered);
	return registered;
}

function rendered(component: RenderComponent): string {
	return component.render(200).join("\n");
}

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

test("execution propagates an external abort", async () => {
	const controller = new AbortController();
	let internalSignal: AbortSignal | undefined;
	const pending = executeSearch({ query: "x" }, controller.signal, (_url, init) => new Promise<Response>((_resolve, reject) => {
		internalSignal = init?.signal;
		internalSignal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
	}), 1_000);
	controller.abort();
	const outcome = await pending;
	assert.equal(outcome.status, "aborted");
	assert.equal(internalSignal?.aborted, true);
});

test("registered tool serializes searches, defaults to general, and limits results", async () => {
	const tool = captureTool();
	assert.equal(tool.name, "web_search");
	assert.equal(tool.executionMode, "sequential");
	const originalFetch = globalThis.fetch;
	let requestedUrl: string | URL | undefined;
	globalThis.fetch = async (input) => {
		requestedUrl = input;
		return new Response(JSON.stringify({
			number_of_results: 1,
			results: [
				{ title: "First", url: "https://first.example", content: "first result" },
				{ title: "Second", url: "https://second.example", content: "second result" },
			],
		}));
	};
	try {
		const result = await tool.execute("call-1", { query: "test", max_results: 1 }, new AbortController().signal);
		assert.equal(new URL(String(requestedUrl)).searchParams.get("categories"), "general");
		assert.equal(result.details?.resultCount, 1);
		const output = result.content[0]?.text ?? "";
		assert.match(output, /\n1\. First\n/);
		assert.doesNotMatch(output, /\n0\./);
		assert.doesNotMatch(output, /\n2\./);
		assert.match(output, /1 total result\./);

		const call = rendered(tool.renderCall({ query: "test" }, plainTheme));
		assert.match(call, /web_search test/);
		const collapsed = rendered(tool.renderResult(result, { expanded: false }, plainTheme));
		assert.match(collapsed, /1 result\)/);
		assert.doesNotMatch(collapsed, /1 results/);
		const expanded = rendered(tool.renderResult(result, { expanded: true }, plainTheme));
		assert.match(expanded, /1\. First/);
	} finally {
		globalThis.fetch = originalFetch;
	}
});
