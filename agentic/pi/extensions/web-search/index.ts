/** Native SearXNG-backed web search for the private local service. */

import type { AgentToolResult, ExtensionAPI, Theme, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

export const DEFAULT_SEARXNG_URL = "http://127.0.0.1:8888";
export const DEFAULT_TIMEOUT_MS = 15_000;
export const MAX_RESULTS = 10;

type SearchStatus = "ok" | "partial_failure" | "empty" | "unavailable" | "non_2xx" | "malformed" | "timeout" | "aborted";

export interface SearchParams {
	query: string;
	max_results?: number;
	language?: string;
	categories?: string;
	time_range?: "day" | "week" | "month" | "year";
	safe_search?: number;
	page?: number;
}

export interface SearchResult {
	title: string;
	url?: string;	// Only HTTP(S) URLs survive normalization.
	content?: string;
	engines?: string[];
	category?: string;
	publishedDate?: string;
}

export interface SearchOutcome {
	status: SearchStatus;
	results: SearchResult[];
	warnings: string[];
	total?: number;
	error?: string;
}

interface RawResult {
	title?: unknown;
	url?: unknown;
	content?: unknown;	// SearXNG calls the snippet "content".
	engine?: unknown;
	engines?: unknown;
	category?: unknown;
	publishedDate?: unknown;
}

interface RawResponse {
	results?: unknown;
	unresponsive_engines?: unknown;
	number_of_results?: unknown;
}

export const Params = Type.Object({
	query: Type.String({ minLength: 1, maxLength: 400, description: "The web search query." }),
	max_results: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_RESULTS, description: `Maximum results to return (1-${MAX_RESULTS}).` })),
	language: Type.Optional(Type.String({ description: "SearXNG language code, for example en or da." })),
	categories: Type.Optional(Type.String({ description: "Comma-separated SearXNG categories, for example general or news." })),
	time_range: Type.Optional(Type.Union([
		Type.Literal("day"),
		Type.Literal("week"),
		Type.Literal("month"),
		Type.Literal("year"),
	], { description: "Restrict results to this time range." })),
	safe_search: Type.Optional(Type.Integer({ minimum: 0, maximum: 2, description: "SearXNG safe-search level: 0 none, 1 moderate, 2 strict." })),
	page: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: "SearXNG result page (1-20)." })),
});

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function engineNames(raw: RawResult): string[] | undefined {
	const values = Array.isArray(raw.engines) ? raw.engines : [raw.engine];
	const names = values.filter((value): value is string => typeof value === "string" && value.trim().length > 0).map((value) => value.trim());
	return names.length ? [...new Set(names)] : undefined;
}

function httpUrl(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	try {
		const url = new URL(value);
		if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
		url.hash = "";
		return url.toString();
	} catch {
		return undefined;
	}
}

/** Normalize safe web URLs and dedupe them; do not dedupe URL-less records. */
export function normalizeResults(rawResults: unknown): SearchResult[] {
	if (!Array.isArray(rawResults)) return [];
	const seenUrls = new Set<string>();
	const normalized: SearchResult[] = [];
	for (const value of rawResults) {
		if (!value || typeof value !== "object") continue;
		const raw = value as RawResult;
		const title = text(raw.title) ?? text(raw.content);
		if (!title) continue;
		const rawUrl = text(raw.url);
		const url = rawUrl ? httpUrl(rawUrl) : undefined;
		// Never expose a non-web URL as a clickable search result. URL-less
		// records are retained because some engines return useful answer cards.
		if (rawUrl && !url) continue;
		if (url && seenUrls.has(url)) continue;
		if (url) seenUrls.add(url);
		normalized.push({
			title,
			...(url ? { url } : {}),
			...(text(raw.content) ? { content: text(raw.content) } : {}),
			...(engineNames(raw) ? { engines: engineNames(raw) } : {}),
			...(text(raw.category) ? { category: text(raw.category) } : {}),
			...(text(raw.publishedDate) ? { publishedDate: text(raw.publishedDate) } : {}),
		});
	}
	return normalized;
}

function warningNames(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.map((item) => Array.isArray(item) ? item.join(": ") : String(item)).filter(Boolean);
}

export function parseSearchResponse(value: unknown): SearchOutcome {
	if (!value || typeof value !== "object") return { status: "malformed", results: [], warnings: [], error: "SearXNG returned a JSON value that was not an object" };
	const response = value as RawResponse;
	if (!Array.isArray(response.results)) {
		return { status: "malformed", results: [], warnings: [], error: "SearXNG JSON did not contain a results array" };
	}
	const warnings = warningNames(response.unresponsive_engines);
	const results = normalizeResults(response.results);
	const total = typeof response.number_of_results === "number" ? response.number_of_results : undefined;
	return {
		status: results.length === 0 ? "empty" : warnings.length ? "partial_failure" : "ok",
		results,
		warnings,
		...(total !== undefined ? { total } : {}),
	};
}

export function buildSearchUrl(baseUrl: string, params: SearchParams): string {
	const base = new URL(baseUrl);
	const path = base.pathname.replace(/\/$/, "");
	base.pathname = `${path}/search`;
	base.search = "";
	base.searchParams.set("q", params.query);
	base.searchParams.set("format", "json");
	if (params.language) base.searchParams.set("language", params.language);
	if (params.categories) base.searchParams.set("categories", params.categories);
	if (params.time_range) base.searchParams.set("time_range", params.time_range);
	if (params.safe_search !== undefined) base.searchParams.set("safesearch", String(params.safe_search));
	if (params.page !== undefined) base.searchParams.set("pageno", String(params.page));
	return base.toString();
}

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export async function executeSearch(
	params: SearchParams,
	externalSignal?: AbortSignal,
	fetchLike: FetchLike = fetch,
	timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<SearchOutcome> {
	if (externalSignal?.aborted) return { status: "aborted", results: [], warnings: [], error: "Search was aborted" };
	const controller = new AbortController();
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, timeoutMs);
	const abort = () => controller.abort();
	externalSignal?.addEventListener("abort", abort, { once: true });
	try {
		const response = await fetchLike(buildSearchUrl(process.env.SEARXNG_URL ?? DEFAULT_SEARXNG_URL, params), {
			method: "GET",
			signal: controller.signal,
			headers: { accept: "application/json" },
		});
		if (!response.ok) return { status: "non_2xx", results: [], warnings: [], error: `SearXNG returned HTTP ${response.status}` };
		let payload: unknown;
		try {
			payload = JSON.parse(await response.text());
		} catch {
			return { status: "malformed", results: [], warnings: [], error: "SearXNG returned malformed JSON" };
		}
		return parseSearchResponse(payload);
	} catch (error) {
		if (externalSignal?.aborted) return { status: "aborted", results: [], warnings: [], error: "Search was aborted" };
		if (timedOut) return { status: "timeout", results: [], warnings: [], error: `Search timed out after ${timeoutMs}ms` };
		const message = error instanceof Error ? error.message : String(error);
		return { status: "unavailable", results: [], warnings: [], error: `SearXNG is unavailable: ${message}` };
	} finally {
		clearTimeout(timer);
		externalSignal?.removeEventListener("abort", abort);
	}
}

function compactResult(result: SearchResult, index: number): string {
	const lines = [`${index}. ${result.title}`];
	if (result.url) lines.push(`   ${result.url}`);
	if (result.content) lines.push(`   ${result.content.replace(/\s+/g, " ").slice(0, 280)}`);
	const metadata = [
		result.engines?.length ? `engines: ${result.engines.join(", ")}` : "",
		result.category ? `category: ${result.category}` : "",
		result.publishedDate ? `published: ${result.publishedDate}` : "",
	].filter(Boolean);
	if (metadata.length) lines.push(`   [${metadata.join("; ")}]`);
	return lines.join("\n");
}

function renderOutcome(params: SearchParams, outcome: SearchOutcome): string {
	const lines = [`Search ${outcome.status}: ${params.query}`];
	if (outcome.error) lines.push(outcome.error);
	if (outcome.total !== undefined) lines.push(`SearXNG reported ${outcome.total} total results.`);
	if (outcome.results.length) lines.push(...outcome.results.map(compactResult));
	if (outcome.warnings.length) lines.push(`Engine warnings: ${outcome.warnings.join(", ")}`);
	return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "web_search",
		label: "web search",
		description: "Search the web through the private local SearXNG service. Returns compact HTTP(S) results with snippets, metadata, and engine warnings. The service must be running first.",
		parameters: Params,
		async execute(_toolCallId, params, signal) {
			const requested = params as SearchParams;
			const bounded: SearchParams = {
				...requested,
				max_results: Math.min(Math.max(requested.max_results ?? MAX_RESULTS, 1), MAX_RESULTS),
			};
			const outcome = await executeSearch(bounded, signal);
			const results = outcome.results.slice(0, bounded.max_results);
			const finalOutcome = { ...outcome, results };
			return {
				content: [{ type: "text", text: renderOutcome(bounded, finalOutcome) }],
				details: { status: finalOutcome.status, resultCount: results.length, warnings: finalOutcome.warnings },
			};
		},
		renderCall(args, theme) {
			const query = String(args?.query ?? "...");
			return new Text(`${theme.fg("toolTitle", theme.bold("web_search "))}${theme.fg("accent", query.slice(0, 80))}`, 0, 0);
		},
		renderResult(result: AgentToolResult<unknown>, options: ToolRenderResultOptions, theme: Theme) {
			const details = result.details as { status?: SearchStatus; resultCount?: number } | undefined;
			if (options.expanded) {
				return new Text(result.content.filter((item) => item.type === "text").map((item) => item.text ?? "").join("\n") || "(no output)", 0, 0);
			}
			const status = details?.status ?? "ok";
			if (status === "ok" || status === "partial_failure") {
				const marker = status === "partial_failure" ? "⚠" : "✓";
				return new Text(theme.fg(status === "partial_failure" ? "warning" : "success", `${marker} web search (${details?.resultCount ?? 0} results${status === "partial_failure" ? "; partial" : ""})`), 0, 0);
			}
			return new Text(theme.fg("error", `✗ web search ${status}`), 0, 0);
		},
	});
}
