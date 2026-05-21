/**
 * `web_fetch` tool.
 *
 * Fetches an HTTP(S) URL and returns its content collapsed into the smallest
 * useful text form. HTML is stripped to readable text (scripts/styles/nav
 * boilerplate removed), then collapsed to single-newline-separated paragraphs.
 * Non-HTML responses (JSON, plain text) are returned as-is, truncated.
 *
 * Token efficiency:
 *  - Drops <script>, <style>, <noscript>, <svg>, <head>, comments.
 *  - Decodes entities, collapses whitespace.
 *  - Hard cap on output size; agent can pass `max_chars` to override.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const DEFAULT_MAX_CHARS = 20_000;
const HARD_MAX_CHARS = 100_000;
const DEFAULT_UA =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36";

const Params = Type.Object({
	url: Type.String({ description: "URL to fetch (http/https)." }),
	max_chars: Type.Optional(
		Type.Integer({
			description: `Cap on returned characters (default ${DEFAULT_MAX_CHARS}, max ${HARD_MAX_CHARS}).`,
			minimum: 500,
			maximum: HARD_MAX_CHARS,
			default: DEFAULT_MAX_CHARS,
		}),
	),
	raw: Type.Optional(
		Type.Boolean({
			description: "If true, return the raw response body without HTML stripping. Default false.",
			default: false,
		}),
	),
});

function decodeEntities(s: string): string {
	return s
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&#x27;/g, "'")
		.replace(/&apos;/g, "'")
		.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
		.replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

function htmlToText(html: string): string {
	let s = html;
	// Strip non-content blocks wholesale.
	s = s.replace(/<!--[\s\S]*?-->/g, "");
	s = s.replace(/<(script|style|noscript|svg|head|template)\b[^>]*>[\s\S]*?<\/\1>/gi, "");
	// Block elements → newline so paragraphs survive.
	s = s.replace(
		/<\/(p|div|section|article|header|footer|main|nav|aside|li|tr|h[1-6]|blockquote|pre|br)>/gi,
		"\n",
	);
	s = s.replace(/<br\s*\/?>/gi, "\n");
	// Strip remaining tags.
	s = s.replace(/<[^>]+>/g, "");
	s = decodeEntities(s);
	// Collapse whitespace.
	s = s.replace(/[ \t]+/g, " ");
	s = s.replace(/\n[ \t]+/g, "\n");
	s = s.replace(/\n{3,}/g, "\n\n");
	return s.trim();
}

function truncate(s: string, max: number): { text: string; truncated: boolean } {
	if (s.length <= max) return { text: s, truncated: false };
	return { text: `${s.slice(0, max)}\n[truncated ${s.length - max} chars]`, truncated: true };
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "web_fetch",
		label: "web fetch",
		description:
			"Fetch an HTTP(S) URL and return its body as compact text. HTML is stripped to readable paragraphs (scripts/styles/nav/svg dropped). Output is hard-capped — pass `max_chars` to raise. If you need to navigate (login, click, JS-rendered pages), use `web_browse` instead.",
		parameters: Params,

		async execute(_toolCallId, params, signal) {
			const max = Math.min(params.max_chars ?? DEFAULT_MAX_CHARS, HARD_MAX_CHARS);
			try {
				const res = await fetch(params.url, {
					signal,
					redirect: "follow",
					headers: {
						"User-Agent": DEFAULT_UA,
						Accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
						"Accept-Language": "en-US,en;q=0.9",
					},
				});
				const contentType = res.headers.get("content-type") ?? "";
				const body = await res.text();
				const isHtml = /text\/html|application\/xhtml/i.test(contentType) || /^\s*<(!DOCTYPE|html)/i.test(body);
				const processed = params.raw || !isHtml ? body : htmlToText(body);
				const { text, truncated } = truncate(processed, max);
				const header =
					`# ${params.url}  [${res.status} ${contentType.split(";")[0] || "unknown"}` +
					`${isHtml && !params.raw ? ", stripped" : ""}${truncated ? ", truncated" : ""}]`;
				return {
					content: [{ type: "text", text: `${header}\n${text}` }],
					details: { url: params.url, status: res.status, contentType, bytes: body.length, truncated },
					isError: !res.ok,
				};
			} catch (err) {
				const msg = (err as Error).message || String(err);
				return {
					content: [{ type: "text", text: `web_fetch failed: ${msg}` }],
					details: { url: params.url, error: msg },
					isError: true,
				};
			}
		},

		renderCall(args, theme) {
			const url = (args?.url as string) || "...";
			const preview = url.length > 70 ? `${url.slice(0, 70)}...` : url;
			return new Text(
				`${theme.fg("toolTitle", theme.bold("web_fetch "))}${theme.fg("accent", preview)}`,
				0,
				0,
			);
		},
	});
}
