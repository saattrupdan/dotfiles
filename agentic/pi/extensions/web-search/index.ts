/**
 * Web-search tool with DuckDuckGo + Tavily MCP fallback.
 *
 * Registers a `web_search` tool that:
 * 1. Tries DuckDuckGo's HTML endpoint first
 * 2. On rate limit/CAPTCHA, starts the configured Tavily MCP server and falls back to it
 *
 * Access control is enforced by pi's per-agent `--tools` allowlist:
 * only agents whose frontmatter lists `web_search` in `tools:` will see
 * this tool. In the bundled setup that is **only the `explorer`
 * subagent**.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";

const DEFAULT_USER_AGENT =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36";

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 30_000;
const BACKOFF_MULTIPLIER = 2.0;

/** CAPTCHA/rate limit indicators in HTML content */
const RATE_LIMIT_INDICATORS = [
	"bots use duckduckgo",
	"challenge",
	"anomaly",
	"captcha",
	"rate limit",
	"too many requests",
	"blocked",
	"automated",
];

const Params = Type.Object({
	query: Type.String({ description: "Search query. Plain English; will be URL-encoded." }),
	max_results: Type.Optional(
		Type.Integer({
			description: "Maximum number of results to return (1-20, default 10).",
			minimum: 1,
			maximum: 20,
			default: 10,
		}),
	),
});

interface SearchResult {
	title: string;
	url: string;
	snippet: string;
}

interface TavilySearchResult {
	url: string;
	title: string;
	content: string;
	score?: number;
	raw_content?: unknown;
}

interface TavilySearchResponse {
	query?: string;
	results?: TavilySearchResult[];
	answer?: string | null;
	images?: string[];
	response_time?: number;
	error?: string;
	code?: string;
}

interface McpServerDefinition {
	command?: unknown;
	args?: unknown;
	env?: unknown;
	cwd?: unknown;
}

interface McpConfig {
	mcpServers?: Record<string, McpServerDefinition>;
}

function decodeEntities(s: string): string {
	return s
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&#x27;/g, "'")
		.replace(/&nbsp;/g, " ");
}

function stripTags(s: string): string {
	return decodeEntities(s.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
}

/**
 * DuckDuckGo wraps result URLs as e.g. `/l/?uddg=<url-encoded-target>&rut=...`.
 * Unwrap them so callers see the actual destination URL.
 */
function unwrapDuckDuckGoUrl(href: string): string {
	try {
		const m = href.match(/[?&]uddg=([^&]+)/);
		if (m) return decodeURIComponent(m[1]);
		if (href.startsWith("//")) return `https:${href}`;
		return href;
	} catch {
		return href;
	}
}

/**
 * Check if HTML content indicates rate limiting or CAPTCHA.
 * Returns the first matching indicator or null.
 */
function findRateLimitIndicator(html: string): string | null {
	const lower = html.toLowerCase();
	for (const indicator of RATE_LIMIT_INDICATORS) {
		if (lower.includes(indicator)) {
			return indicator;
		}
	}
	return null;
}

/** Calculate delay with exponential backoff */
function calculateDelayMs(attempt: number): number {
	let delay = BASE_DELAY_MS * Math.pow(BACKOFF_MULTIPLIER, attempt);
	delay = Math.min(delay, MAX_DELAY_MS);
	// Add jitter (0-500ms)
	const jitter = Math.random() * 500;
	return delay + jitter;
}

/** Wait for a number of milliseconds */
function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseDuckDuckGoHtml(html: string, max: number): SearchResult[] {
	const results: SearchResult[] = [];
	// Each result block contains an <a class="result__a" href="...">title</a>
	// and a sibling <a class="result__snippet" ...>snippet</a>.
	const titleRe =
		/<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
	const snippetRe =
		/<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g;

	const titles: { url: string; title: string; index: number }[] = [];
	let m: RegExpExecArray | null;
	while ((m = titleRe.exec(html)) !== null) {
		titles.push({ url: unwrapDuckDuckGoUrl(m[1]), title: stripTags(m[2]), index: m.index });
	}
	const snippets: { snippet: string; index: number }[] = [];
	while ((m = snippetRe.exec(html)) !== null) {
		snippets.push({ snippet: stripTags(m[1]), index: m.index });
	}

	for (const t of titles) {
		if (!t.title || !t.url) continue;
		// Pair each title with the nearest following snippet.
		const s = snippets.find((sn) => sn.index > t.index);
		results.push({ title: t.title, url: t.url, snippet: s ? s.snippet : "" });
		if (results.length >= max) break;
	}
	return results;
}

/**
 * Shared type guard for parsed JSON and MCP responses.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

function resolveMcpConfigPath(pi: ExtensionAPI): string {
	const configured = pi.getFlag("mcp-config");
	return typeof configured === "string" && configured.trim().length > 0
		? configured
		: join(resolveAgentDir(), "mcp.json");
}

function asStringArray(value: unknown): string[] | undefined {
	return Array.isArray(value) && value.every((item) => typeof item === "string")
		? value
		: undefined;
}

function resolveEnvValue(value: string, env: Record<string, string>): string {
	return value.replace(
		/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
		(_match, braced: string | undefined, bare: string | undefined) => {
			const key = braced ?? bare ?? "";
			return env[key] ?? "";
		},
	);
}

function buildServerEnv(definition: McpServerDefinition): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) env[key] = value;
	}

	if (isRecord(definition.env)) {
		for (const [key, value] of Object.entries(definition.env)) {
			if (typeof value === "string") env[key] = resolveEnvValue(value, env);
		}
	}

	return env;
}

async function loadTavilyServerDefinition(pi: ExtensionAPI): Promise<McpServerDefinition> {
	const configPath = resolveMcpConfigPath(pi);
	const raw = await readFile(configPath, "utf8");
	const parsed = JSON.parse(raw) as unknown;
	if (!isRecord(parsed)) throw new Error(`Invalid MCP config at ${configPath}`);

	const config = parsed as McpConfig;
	const definition = config.mcpServers?.tavily;
	if (!definition) throw new Error(`Tavily MCP server is not configured in ${configPath}`);
	if (typeof definition.command !== "string" || definition.command.trim().length === 0) {
		throw new Error("Tavily MCP server has no command configured");
	}
	if (definition.args !== undefined && !asStringArray(definition.args)) {
		throw new Error("Tavily MCP server args must be strings");
	}
	if (definition.cwd !== undefined && typeof definition.cwd !== "string") {
		throw new Error("Tavily MCP server cwd must be a string");
	}

	return definition;
}

function parseTavilyResponse(value: unknown): TavilySearchResponse {
	if (!isRecord(value)) throw new Error("Tavily MCP returned a non-object response");
	if (typeof value.error === "string" || typeof value.code === "string") {
		return {
			error: typeof value.error === "string" ? value.error : undefined,
			code: typeof value.code === "string" ? value.code : undefined,
		};
	}
	const results = Array.isArray(value.results)
		? value.results.filter((item): item is TavilySearchResult => {
			return isRecord(item)
				&& typeof item.title === "string"
				&& typeof item.url === "string"
				&& typeof item.content === "string";
		})
		: undefined;
	return { results };
}

function extractTextContent(result: unknown): string | undefined {
	if (!isRecord(result) || !Array.isArray(result.content)) return undefined;
	const textBlock = result.content.find((item) => {
		return isRecord(item) && item.type === "text" && typeof item.text === "string";
	});
	return isRecord(textBlock) && typeof textBlock.text === "string" ? textBlock.text : undefined;
}

function parseTavilyMcpResult(result: unknown): TavilySearchResponse {
	if (isRecord(result) && result.isError === true) {
		throw new Error(extractTextContent(result) ?? "Tavily MCP returned an error");
	}

	if (isRecord(result) && result.structuredContent !== undefined) {
		return parseTavilyResponse(result.structuredContent);
	}

	const text = extractTextContent(result);
	if (!text) throw new Error("Tavily MCP returned no text content");

	return parseTavilyResponse(JSON.parse(text) as unknown);
}

function toSearchResults(tavilyResponse: TavilySearchResponse, max: number): SearchResult[] {
	if (tavilyResponse.error || tavilyResponse.code) {
		throw new Error(`Tavily error: ${tavilyResponse.error || tavilyResponse.code}`);
	}

	return (tavilyResponse.results ?? []).slice(0, max).map((r) => ({
		title: r.title,
		url: r.url,
		snippet: r.content || "",
	}));
}

/**
 * Search using Tavily MCP.
 */
async function tavilyMcpSearch(
	query: string,
	max: number,
	pi: ExtensionAPI,
	signal?: AbortSignal,
): Promise<SearchResult[]> {
	const definition = await loadTavilyServerDefinition(pi);
	const transport = new StdioClientTransport({
		command: definition.command as string,
		args: asStringArray(definition.args) ?? [],
		env: buildServerEnv(definition),
		cwd: typeof definition.cwd === "string" ? definition.cwd : undefined,
		stderr: "pipe",
	});
	const client = new Client({ name: "pi-web-search", version: "1.0.0" });

	try {
		await client.connect(transport, { signal });
		const tools = await client.listTools(undefined, { signal });
		const toolName = tools.tools.find((tool) => tool.name === "tavily_search")?.name
			?? tools.tools.find((tool) => tool.name === "tavily_tavily_search")?.name
			?? tools.tools.find((tool) => tool.name.includes("search"))?.name;

		if (!toolName) throw new Error("Tavily MCP connected but did not advertise a search tool");

		const result = await client.callTool({
			name: toolName,
			arguments: { query, max_results: max },
		}, undefined, { signal });

		return toSearchResults(parseTavilyMcpResult(result), max);
	} catch (err) {
		const msg = (err as Error).message || String(err);
		throw new Error(`Tavily MCP search failed: ${msg}`, { cause: err });
	} finally {
		await client.close().catch(() => undefined);
	}
}

async function duckDuckGoSearch(query: string, max: number, signal?: AbortSignal): Promise<SearchResult[]> {
	const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
	let lastError: Error | null = null;

	for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
		// Wait before retry (not on first attempt)
		if (attempt > 0) {
			const delay = calculateDelayMs(attempt - 1);
			await sleep(delay);
			if (signal?.aborted) {
				throw new Error("Search cancelled");
			}
		}

		const res = await fetch(url, {
			method: "GET",
			headers: {
				"User-Agent": DEFAULT_USER_AGENT,
				Accept: "text/html,application/xhtml+xml",
				"Accept-Language": "en-US,en;q=0.9",
			},
			signal,
		});

		// Check for rate limit status codes
		if (res.status === 429 || res.status === 202 || res.status >= 500) {
			lastError = new Error(`DuckDuckGo returned HTTP ${res.status} (rate limited)`);
			continue;
		}

		if (!res.ok) {
			throw new Error(`DuckDuckGo returned HTTP ${res.status}`);
		}

		const html = await res.text();

		// Check for CAPTCHA/rate limit indicators in HTML
		const indicator = findRateLimitIndicator(html);
		if (indicator) {
			lastError = new Error(`DuckDuckGo CAPTCHA detected: "${indicator}"`);
			continue;
		}

		return parseDuckDuckGoHtml(html, max);
	}

	throw lastError || new Error("DuckDuckGo search failed after max retries");
}

function formatResultsMarkdown(query: string, results: SearchResult[]): string {
	if (results.length === 0) {
		return `No results for: \`${query}\``;
	}
	const lines: string[] = [`Results for: \`${query}\``, ""];
	results.forEach((r, i) => {
		lines.push(`${i + 1}. **${r.title}** — <${r.url}>`);
		if (r.snippet) lines.push(`   ${r.snippet}`);
	});
	lines.push("");
	lines.push("Note: use the `read` tool to read any of these URLs.");
	return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "web_search",
		label: "Web search",
		description:
			"Search the web via DuckDuckGo and return the top results (title, URL, snippet). Automatically starts and falls back to the configured Tavily MCP server if DuckDuckGo rate limits. Use this to discover relevant pages, then fetch them with curl/wget through bash for the actual content.",
		parameters: Params,

		async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
		const max = params.max_results ?? 10;
		let duckDuckGoMessage: string | undefined;

		// Try DuckDuckGo first
		try {
			const results = await duckDuckGoSearch(params.query, max, signal);
			return {
				content: [{ type: "text", text: formatResultsMarkdown(params.query, results) }],
				details: { query: params.query, count: results.length, results, source: "duckduckgo" },
			};
		} catch (err) {
			const msg = (err as Error).message || String(err);
			duckDuckGoMessage = msg;
			// Check if this is a rate limit / CAPTCHA error
			const isRateLimited = 
				msg.includes("rate limit") || 
				msg.includes("CAPTCHA") || 
				msg.includes("429") ||
				msg.includes("403");

			if (!isRateLimited) {
				// Not a rate limit error, return the error
				return {
					content: [{ type: "text", text: `Web search failed: ${msg}` }],
					details: { query: params.query, count: 0, results: [], error: msg, source: "duckduckgo" },
				};
			}
		}

		// DuckDuckGo rate limited - try Tavily MCP fallback
		try {
			const results = await tavilyMcpSearch(params.query, max, pi, signal);
			return {
				content: [{ type: "text", text: formatResultsMarkdown(params.query, results) }],
				details: { query: params.query, count: results.length, results, source: "tavily-mcp" },
			};
		} catch (tavilyErr) {
			const tavilyMsg = (tavilyErr as Error).message || String(tavilyErr);
			return {
				content: [{ type: "text", text: `Web search failed: ${duckDuckGoMessage}. Tavily fallback: ${tavilyMsg}` }],
				details: { query: params.query, count: 0, results: [], error: duckDuckGoMessage, tavilyError: tavilyMsg },
			};
		}
	},

		renderCall(args, theme) {
			const q = (args.query as string) || "...";
			const preview = q.length > 60 ? `${q.slice(0, 60)}...` : q;
			return new Text(
				`${theme.fg("toolTitle", theme.bold("web_search "))}${theme.fg("accent", `"${preview}"`)}`,
				0,
				0,
			);
		},
	});
}
