/**
 * `web_fetch` tool.
 *
 * Fetches an HTTP(S) URL and converts it to Markdown via docling — which
 * handles HTML, PDF, DOCX, PPTX, images, and more. Always returns Markdown.
 *
 * Saves the output to a cache file under ~/.pi/cache/web-fetch/ and returns
 * the path in `details.path`. The agent can then use `read` on that path to
 * get an outline and navigate sections individually.
 *
 * Token efficiency:
 *  - Hard cap on output size; agent can pass `max_chars` to override.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";

const DEFAULT_MAX_CHARS = 20_000;
const HARD_MAX_CHARS = 100_000;

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
});

const CACHE_DIR = join(tmpdir(), "pi-web-fetch-cache");

function ensureCacheDir(): void {
	try { mkdir(CACHE_DIR, { recursive: true }); } catch { /* ignore */ }
}

function cachePath(url: string): string {
	const hash = createHash("sha256").update(url).digest("hex").slice(0, 16);
	return join(CACHE_DIR, `${hash}.md`);
}

function truncate(s: string, max: number): { text: string; truncated: boolean } {
	if (s.length <= max) return { text: s, truncated: false };
	return { text: `${s.slice(0, max)}\n[truncated ${s.length - max} chars]`, truncated: true };
}

function runDocling(outputDir: string, url: string, signal?: AbortSignal): Promise<{ stdout: string; stderr: string; status: number }> {
	return new Promise((resolve, reject) => {
		const proc = spawn("docling", ["--to", "md", "--device", "auto", "--output", outputDir, url], {
			stdio: ["inherit", "pipe", "pipe"],
		});
		const out: Buffer[] = [];
		const err: Buffer[] = [];
		proc.stdout.on("data", (d: Buffer) => out.push(d));
		proc.stderr.on("data", (d: Buffer) => err.push(d));
		proc.on("close", (code) => resolve({ stdout: Buffer.concat(out).toString(), stderr: Buffer.concat(err).toString(), status: code ?? 1 }));
		proc.on("error", (e) => reject(e));
		if (signal) {
			signal.addEventListener("abort", () => proc.kill());
		}
	});
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "web_fetch",
		label: "web fetch",
		description:
			"Fetch an HTTP(S) URL and convert it to Markdown via docling. Handles HTML, PDF, DOCX, PPTX, images, and more. Saves to a cache file and returns the path — use `read` on the returned path to get an outline and navigate sections. Output is hard-capped — pass `max_chars` to raise. For interactive/JS-heavy pages, use `web_browse` instead.",
		parameters: Params,

		async execute(_toolCallId, params, signal) {
			const max = Math.min(params.max_chars ?? DEFAULT_MAX_CHARS, HARD_MAX_CHARS);
			ensureCacheDir();
			const filePath = cachePath(params.url);

			// If cache already exists, return it directly (skip docling).
			try {
				const cached = await readFile(filePath, "utf8");
				if (cached.length > 0) {
					const { text, truncated } = truncate(cached, max);
					const header = `# ${params.url}  [cached]`;
					return {
						content: [{ type: "text", text: `${header}\n${text}` }],
						details: { url: params.url, path: filePath, cached: true, truncated },
						isError: false,
					};
				}
			} catch { /* cache miss, continue */ }

			try {
				// Delegate all fetching + conversion to docling CLI — handles HTML,
				// PDF, DOCX, PPTX, images, etc. Always exports to Markdown.
				const tmpDir = await mkdtemp(join(tmpdir(), "docling-"));
				try {
					const { stdout, stderr, status } = await runDocling(tmpDir, params.url, signal);

					// Read the output file: docling writes `file.md` for URLs,
					// or `<basename>.md` for local files.
					const mdFile = join(tmpDir, "file.md");
					let body = "";
					try { body = await readFile(mdFile, "utf8"); } catch { /* ignore */ }

					// Write to cache so the agent can `read` it for outlines.
					await writeFile(filePath, body, "utf8");

					const { text, truncated } = truncate(body, max);
					const header = `# ${params.url}  [${status === 0 ? "ok" : "error"}]`;
					return {
						content: [{ type: "text", text: `${header}\n${text}` }],
						details: { url: params.url, path: filePath, truncated },
						isError: status !== 0,
					};
				} finally {
					await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
				}
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
