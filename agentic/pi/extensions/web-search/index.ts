/**
 * Web-search tool.
 *
 * Registers a `web_search` tool that performs a query against DuckDuckGo's
 * HTML endpoint and returns the top results (title, URL, snippet) as a
 * compact Markdown list.
 *
 * Access control is enforced by pi's per-agent `--tools` allowlist:
 * only agents whose frontmatter lists `web_search` in `tools:` will see
 * this tool. In the bundled setup that is **only the `explorer`
 * subagent**. The orchestrator can't call it because the
 * `orchestrator-lockdown` extension blocks every tool except `subagent`
 * and `question`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const DEFAULT_USER_AGENT =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36";

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

async function duckDuckGoSearch(query: string, max: number, signal: AbortSignal): Promise<SearchResult[]> {
	const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
	const res = await fetch(url, {
		method: "POST",
		headers: {
			"User-Agent": DEFAULT_USER_AGENT,
			"Content-Type": "application/x-www-form-urlencoded",
			Accept: "text/html,application/xhtml+xml",
			"Accept-Language": "en-US,en;q=0.9",
		},
		body: `q=${encodeURIComponent(query)}`,
		signal,
	});
	if (!res.ok) {
		throw new Error(`DuckDuckGo returned HTTP ${res.status}`);
	}
	const html = await res.text();
	return parseDuckDuckGoHtml(html, max);
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
	return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "web_search",
		label: "Web search",
		description:
			"Search the web via DuckDuckGo and return the top results (title, URL, snippet). Use this to discover relevant pages, then fetch them with curl/wget through bash for the actual content.",
		parameters: Params,

		async execute(_toolCallId, params, signal) {
			const max = params.max_results ?? 10;
			try {
				const results = await duckDuckGoSearch(params.query, max, signal);
				return {
					content: [{ type: "text", text: formatResultsMarkdown(params.query, results) }],
					details: { query: params.query, count: results.length, results },
				};
			} catch (err) {
				const msg = (err as Error).message || String(err);
				return {
					content: [{ type: "text", text: `Web search failed: ${msg}` }],
					details: { query: params.query, error: msg },
					isError: true,
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
