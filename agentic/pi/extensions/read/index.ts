/**
 * Hard-capped `read` tool extension.
 *
 * Overrides the built-in read tool with:
 * - SHA-256 session dedupe cache (Map keyed by sha|path|offset|limit)
 * - Small-file passthrough (≤100 lines, no offset → verbatim)
 * - Large-file outline (>100 lines, no offset → tree-sitter outline)
 * - Slice read (offset set → read slice with hard cap)
 * - Binary / image detection (delegates to built-in)
 * - Hard 100-line cap (model can only request *less* than 100)
 *
 * This extension is loaded from the `.pi/agent/extensions/read/` directory
 * and registered via the standard pi extension API.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

// ---------------------------------------------------------------------------
// Resolve the outliner — use jiti-relative import from the extension dir
// ---------------------------------------------------------------------------
// The outliner is a sibling extension in the same extensions directory.
// We import it via jiti at runtime (the pi loader provides jiti with aliases).
let outlineModule: typeof import("../_outliner/outliner.js") | null = null;

async function loadOutliner(): Promise<typeof import("../_outliner/outliner.js")> {
	if (outlineModule) return outlineModule;
	// jiti is available in the pi loader context — we import relative to this file.
	// The pi extension loader configures jiti with aliases for node_modules.
	const jiti = await import("jiti").then((m) => m.createJiti(import.meta.url, { moduleCache: false }));
	// @ts-expect-error - jiti.import returns unknown
	outlineModule = await jiti.import("../_outliner/outliner.js", { default: true });
	return outlineModule;
}

// ---------------------------------------------------------------------------
// Session dedupe cache
// ---------------------------------------------------------------------------

const callIndex = { current: 0 }; // resets on process restart

const dedupeCache = new Map<string, { sha: string; callIndex: number }>();

/**
 * Build a cache key from sha, path, offset, limit.
 */
function cacheKey(sha: string, filePath: string, offset: number | undefined, limit: number | undefined): string {
	return `${sha}|${filePath}|${offset}|${limit}`;
}

// ---------------------------------------------------------------------------
// MIME sniff for binary / image detection
// ---------------------------------------------------------------------------

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp"]);

/**
 * Quick MIME sniff by checking first bytes.
 * Returns true if the file looks like a supported image.
 */
function isLikelyImage(filePath: string): boolean {
	const ext = path.extname(filePath).toLowerCase();
	if (!IMAGE_EXTENSIONS.has(ext)) return false;
	try {
		const buf = fs.readFileSync(filePath).slice(0, 8);
		if (buf[0] === 0xff && buf[1] === 0xd8) return true; // JPEG
		if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true; // PNG
		if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x4e && buf[3] === 0x47) return true; // GIF
		if (buf[0] === 0x52 && buf[1] === 0x46 && buf[2] === 0x46 && buf[3] === 0x42) return true; // WebP
		return false;
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// SHA-256 hash
// ---------------------------------------------------------------------------

function sha256(filePath: string): string {
	const buf = fs.readFileSync(filePath);
	return crypto.createHash("sha256").update(buf).digest("hex");
}

// ---------------------------------------------------------------------------
// Line count
// ---------------------------------------------------------------------------

function lineCount(content: string): number {
	return content.split("\n").length;
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const Params = Type.Object({
	path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
	offset: Type.Optional(
		Type.Integer({
			description: "Line number to start reading from (1-indexed)",
			minimum: 1,
		}),
	),
	limit: Type.Optional(
		Type.Integer({
			description: "Maximum number of lines to read (hard-capped at 100)",
			minimum: 1,
			maximum: 100,
		}),
	),
});

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export default async function (pi: ExtensionAPI) {
	// Load outliner eagerly (it's fast)
	const outliner = await loadOutliner();
	const { outline, collapsedView } = outliner;

	pi.registerTool({
		name: "read",
		label: "read",
		description:
			"Read the contents of a file. Supports text files and images (jpg, png, gif, webp). For text files, output is hard-capped at 100 lines. Use offset/limit for large files. When you need the full file, continue with offset until complete.",
		parameters: Params,

		async execute(_toolCallId, { path: filePath, offset, limit }, _signal, _onUpdate, _ctx) {
			const absolutePath = path.resolve(filePath);

			// 1. Binary / image detection → delegate to built-in
			if (isLikelyImage(absolutePath)) {
				return {
					content: [
						{
							type: "text",
							text: `Binary file (${path.extname(absolutePath)}) — use built-in read or image tool`,
						},
					],
					isError: false,
				};
			}

			// 2. Compute SHA-256
			const sha = sha256(absolutePath);

			// 3. Effective limit: clamp at 100
			const effectiveLimit = Math.min(limit ?? 100, 100);

			// 4. Read the file content
			const content = fs.readFileSync(absolutePath, "utf-8");
			const allLines = content.split("\n");
			const totalLines = allLines.length;

			// 5. Cache key
			const key = cacheKey(sha, absolutePath, offset, limit);

			// 6. Check dedupe cache
			const cached = dedupeCache.get(key);
			if (cached && cached.sha === sha) {
				const n = cached.callIndex;
				return {
					content: [{ type: "text", text: `unchanged since call #${n}` }],
					details: { dedupe: true, callIndex: n },
				};
			}

			// 7. Small file passthrough (≤100 lines AND neither offset nor limit)
			if (totalLines <= 100 && offset === undefined && limit === undefined) {
				const header = `# lines 1-${totalLines} of ${absolutePath} (${totalLines} total)`;
				dedupeCache.set(key, { sha, callIndex: ++callIndex.current });
				return {
					content: [{ type: "text", text: `${header}\n${content}` }],
				};
			}

			// 8. Large file outline (>100 lines AND neither offset nor limit)
			if (totalLines > 100 && offset === undefined && limit === undefined) {
				try {
					const entries = outline(absolutePath, content);
					const collapsed = collapsedView(entries, { hidePrivate: true, maxLines: 100 });
					const header = `# outline of ${absolutePath} (${totalLines} total lines)`;
					dedupeCache.set(key, { sha, callIndex: ++callIndex.current });
					return {
						content: [{ type: "text", text: `${header}\n${collapsed.join("\n")}` }],
					};
				} catch {
					// Fall through to slice read on outline failure
				}
			}

			// 9. Slice read (offset set, limit set, or fallback)
			const startIdx = offset ? offset - 1 : 0;
			const endIdx = limit !== undefined ? Math.min(startIdx + effectiveLimit, totalLines) : totalLines;
			const slice = allLines.slice(startIdx, endIdx);
			const sliceLines = slice.length;
			const endLine = limit !== undefined ? startIdx + sliceLines : totalLines;
			const header = offset !== undefined
				? `# lines ${offset}-${endLine} of ${absolutePath} (${totalLines} total)`
				: `# lines 1-${endLine} of ${absolutePath} (${totalLines} total)`;

			dedupeCache.set(key, { sha, callIndex: ++callIndex.current });
			return {
				content: [{ type: "text", text: `${header}\n${slice.join("\n")}` }],
			};
		},

		renderCall(args, theme) {
			const rawPath = args?.path ?? args?.file_path;
			const pathStr = rawPath ? String(rawPath) : "...";
			const offset = args?.offset;
			const limit = args?.limit;
			let range = "";
			if (offset !== undefined || limit !== undefined) {
				const start = offset ?? 1;
				const end = limit !== undefined ? start + limit - 1 : "";
				range = `:${start}${end ? `-${end}` : ""}`;
			}
			return new Text(
				`${theme.fg("toolTitle", theme.bold("read"))} ${theme.fg("accent", pathStr)}${theme.fg("warning", range)}`,
				0,
				0,
			);
		},
	});
}
