/**
 * Index-backed `read` tool extension.
 *
 * Three modes (no pagination — model must use search to locate things):
 *   1. Small file (≤ SMALL_FILE_LINES, no symbol) → verbatim
 *   2. Large file (no symbol)                     → outline (module doc +
 *      one line per symbol with signature & doc-first-line)
 *   3. `symbol` set                               → body of that symbol
 *      using line_start..line_end from the index. Supports "Class.method".
 *
 * Outline + symbol ranges come from the shared SQLite index in
 * `~/.pi/index/<repo-id>/index.db`, which is also used by the `search`
 * extension. The index is incrementally refreshed for the target file on
 * every call, so edits are picked up without a full rebuild.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

// ---------------------------------------------------------------------------
// Resolve sibling modules via jiti
// ---------------------------------------------------------------------------

let outlineModule: typeof import("../_outliner/outliner.js") | null = null;
let indexStoreModule: typeof import("../search/index-store.js") | null = null;

async function loadModules() {
	if (outlineModule && indexStoreModule) {
		return { outliner: outlineModule, indexStore: indexStoreModule };
	}
	const jiti = await import("jiti").then((m) => m.createJiti(import.meta.url, { moduleCache: false }));
	if (!outlineModule) {
		// @ts-expect-error - jiti.import returns unknown
		outlineModule = await jiti.import("../_outliner/outliner.js", { default: true });
	}
	if (!indexStoreModule) {
		// @ts-expect-error - jiti.import returns unknown
		indexStoreModule = await jiti.import("../search/index-store.js", { default: true });
	}
	return { outliner: outlineModule!, indexStore: indexStoreModule! };
}

// ---------------------------------------------------------------------------
// Session dedupe cache
// ---------------------------------------------------------------------------

const callIndex = { current: 0 };
const dedupeCache = new Map<string, { sha: string; callIndex: number }>();

function cacheKey(sha: string, filePath: string, symbol: string | undefined): string {
	return `${sha}|${filePath}|${symbol ?? ""}`;
}

// ---------------------------------------------------------------------------
// MIME sniff for binary / image detection
// ---------------------------------------------------------------------------

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp"]);

function isLikelyImage(filePath: string): boolean {
	const ext = path.extname(filePath).toLowerCase();
	if (!IMAGE_EXTENSIONS.has(ext)) return false;
	try {
		const buf = fs.readFileSync(filePath).slice(0, 8);
		if (buf[0] === 0xff && buf[1] === 0xd8) return true; // JPEG
		if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true; // PNG
		if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return true; // GIF
		if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) return true; // RIFF/WebP
		return false;
	} catch {
		return false;
	}
}

function sha256(filePath: string): string {
	const buf = fs.readFileSync(filePath);
	return crypto.createHash("sha256").update(buf).digest("hex");
}

const SMALL_FILE_LINES = 100;
const DIR_ENTRY_LIMIT = 200;

function listDirectory(absolutePath: string) {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(absolutePath, { withFileTypes: true });
	} catch (err) {
		return {
			content: [{ type: "text", text: `Could not read directory ${absolutePath}: ${(err as Error).message}` }],
			isError: true,
		};
	}
	const dirs: string[] = [];
	const files: string[] = [];
	for (const e of entries) {
		if (e.isDirectory()) dirs.push(`${e.name}/`);
		else files.push(e.name);
	}
	dirs.sort();
	files.sort();
	const all = [...dirs, ...files];
	const total = all.length;
	const shown = all.slice(0, DIR_ENTRY_LIMIT);
	const header = `# directory ${absolutePath} (${total} entries${total > DIR_ENTRY_LIMIT ? `, showing ${DIR_ENTRY_LIMIT}` : ""})`;
	const footer = total > DIR_ENTRY_LIMIT
		? `\n# … ${total - DIR_ENTRY_LIMIT} more entries truncated — use \`search\` to find specific files.`
		: "";
	return {
		content: [{ type: "text", text: `${header}\n${shown.join("\n")}${footer}` }],
	};
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const Params = Type.Object({
	path: Type.String({ description: "Path to the file to read (relative or absolute)." }),
	symbol: Type.Optional(
		Type.String({
			description:
				"Optional symbol name (e.g. 'foo' or 'ClassName.method') to return the body of that symbol only. " +
				"Use the outline returned by a path-only read to discover symbol names.",
		}),
	),
});

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export default async function (pi: ExtensionAPI) {
	const { outliner, indexStore } = await loadModules();
	const { outline, collapsedView } = outliner;
	const { openIndex, refreshFile, getFileOutline, getSymbol } = indexStore;

	pi.registerTool({
		name: "read",
		label: "read",
		description:
			"Read a file or list a directory. Modes:\n" +
			"  • Path is a directory → truncated listing of entries (dirs first, then files).\n" +
			"  • No symbol, small file → verbatim contents.\n" +
			"  • No symbol, large file → outline (module doc, classes/functions with signatures, type hints, and doc-first-line). Use the outline to pick a symbol.\n" +
			"  • symbol set → body of that symbol only (supports 'Class.method').\n" +
			"  • symbol=\"__preamble__\" → everything before the first class/function (imports, constants, module setup).\n" +
			"There is no pagination — you cannot walk a file via offset/limit. If the outline is not enough, use the `search` tool to locate what you need, then read the symbol.",
		parameters: Params,

		async execute(_toolCallId, { path: filePath, symbol }, _signal, _onUpdate, _ctx) {
			const absolutePath = path.resolve(filePath);

			// 0. SYSTEM.md interception
			if (absolutePath.endsWith("SYSTEM.md")) {
				try {
					const content = fs.readFileSync(absolutePath, "utf-8").slice(0, 300);
					return {
						content: [
							{
								type: "text",
								text: `SYSTEM.md is the child agent's system prompt. Here's a brief preview:\n\n${content}`,
							},
						],
						isError: false,
					};
				} catch {
					return {
						content: [{ type: "text", text: "SYSTEM.md is the child agent's system prompt." }],
						isError: false,
					};
				}
			}

			// 1. Existence check
			if (!fs.existsSync(absolutePath)) {
				return {
					content: [{ type: "text", text: `File not found: ${absolutePath}` }],
					isError: true,
				};
			}

			// 1b. Directory listing (truncated)
			try {
				const stat = fs.statSync(absolutePath);
				if (stat.isDirectory()) {
					return listDirectory(absolutePath);
				}
			} catch {
				// fall through
			}

			// 2. Image passthrough
			if (isLikelyImage(absolutePath)) {
				try {
					const builtIn = await import("$PI/dist/core/tools/read.js");
					return builtIn.createReadTool().execute(absolutePath, undefined, undefined, _signal);
				} catch {
					return {
						content: [
							{
								type: "text",
								text: `Binary file (${path.extname(absolutePath)}) — use the built-in image tool.`,
							},
						],
						isError: false,
					};
				}
			}

			// 3. SHA-256 + dedupe lookup
			const sha = sha256(absolutePath);
			const key = cacheKey(sha, absolutePath, symbol);
			const cached = dedupeCache.get(key);
			if (cached && cached.sha === sha) {
				return {
					content: [{ type: "text", text: `unchanged since call #${cached.callIndex}` }],
					details: { dedupe: true, callIndex: cached.callIndex },
				};
			}

			// 4. Open the index (no full build) and refresh just this file.
			const { db, repoRoot } = openIndex(process.cwd());
			let relPath = path.relative(repoRoot, absolutePath);
			if (relPath.startsWith("..")) {
				// File lives outside the repo — fall back to verbatim/outline without the index.
				return readOutsideRepo(absolutePath, symbol, outline, collapsedView, key, sha);
			}
			refreshFile(db, repoRoot, relPath, outline);

			const content = fs.readFileSync(absolutePath, "utf-8");
			const allLines = content.split("\n");
			const totalLines = allLines.length;

			// 5a. Preamble: everything before the first class/function.
			if (symbol === "__preamble__") {
				const firstDefRow = db
					.prepare(
						"SELECT MIN(line_start) AS line FROM symbols WHERE file = ? AND kind IN ('class','function','heading','block')",
					)
					.get(relPath) as { line: number | null } | undefined;
				const cutoff = firstDefRow?.line ?? null;
				const lastLine = cutoff && cutoff > 1 ? cutoff - 1 : totalLines;
				const slice = allLines.slice(0, lastLine);
				const preambleHeader = cutoff
					? `# ${relPath}::__preamble__  lines 1-${lastLine} (before line ${cutoff})`
					: `# ${relPath}::__preamble__  lines 1-${lastLine} (no class/function found — whole file)`;
				dedupeCache.set(key, { sha, callIndex: ++callIndex.current });
				return { content: [{ type: "text", text: `${header}\n${slice.join("\n")}` }] };
			}

			// 5. Symbol body
			if (symbol) {
				const sym = getSymbol(db, relPath, symbol);
				if (!sym) {
					return {
						content: [
							{
								type: "text",
								text: `Symbol "${symbol}" not found in ${relPath}. Read the file without \`symbol\` to see the outline, or use \`search\` to locate it.`,
							},
						],
						isError: true,
					};
				}
				const slice = allLines.slice(sym.line_start - 1, sym.line_end);
				const symbolHeader = `# ${relPath}::${symbol}  lines ${sym.line_start}-${sym.line_end} (${sym.kind})`;
				const meta: string[] = [];
				if (sym.docFirstLine) meta.push(`Docstring: ${sym.docFirstLine}`);
				const preamble = meta.length > 0 ? `${preambleHeader}\n${meta.join("\n")}\n` : `${preambleHeader}\n`;
				const numbered = slice.map((line, i) => `  ${sym.line_start + i}: ${line}`).join("\n");
				dedupeCache.set(key, { sha, callIndex: ++callIndex.current });
				return { content: [{ type: "text", text: `${preamble}${numbered}` }] };
			}

			// 6. Small file → verbatim
			if (totalLines <= SMALL_FILE_LINES) {
				const smallFileHeader = `# ${relPath} (${totalLines} lines)`;
				dedupeCache.set(key, { sha, callIndex: ++callIndex.current });
				return { content: [{ type: "text", text: `${smallFileHeader}\n${content}` }] };
			}

			// 7. Large file → outline from the index
			const stored = getFileOutline(db, relPath);
			const result = stored
				? { moduleDoc: stored.doc ?? undefined, entries: stored.entries }
				: outline(absolutePath, content);
			const view = collapsedView(result, { hidePrivate: true, maxLines: 200 });
			const outlineHeader = `# outline of ${relPath} (${totalLines} lines)`;
			const footer =
				`# read again with symbol="<name>" to see a function/class body, ` +
				`symbol="__preamble__" for imports/constants, ` +
				`or use \`search\` to locate something specific.`;
			dedupeCache.set(key, { sha, callIndex: ++callIndex.current });
			return {
				content: [
					{ type: "text", text: `${outlineHeader}\n${view.join("\n")}\n${footer}` },
				],
			};
		},

		renderCall(args, theme) {
			const rawPath = args?.path ?? args?.file_path;
			const pathStr = rawPath ? String(rawPath) : "...";
			const symbol = args?.symbol;
			const suffix = symbol ? `::${String(symbol)}` : "";
			return new Text(
				`${theme.fg("toolTitle", theme.bold("read"))} ${theme.fg("accent", pathStr)}${theme.fg("warning", suffix)}`,
				0,
				0,
			);
		},
	});
}

// ---------------------------------------------------------------------------
// Fallback for files outside the indexed repo
// ---------------------------------------------------------------------------

function readOutsideRepo(
	absolutePath: string,
	symbol: string | undefined,
	outline: (typeof import("../_outliner/outliner.js"))["outline"],
	collapsedView: (typeof import("../_outliner/outliner.js"))["collapsedView"],
	key: string,
	sha: string,
) {
	const content = fs.readFileSync(absolutePath, "utf-8");
	const allLines = content.split("\n");
	const totalLines = allLines.length;

	if (symbol === "__preamble__") {
		const result = outline(absolutePath, content);
		const firstDef = result.entries.find((e) => e.kind === "class" || e.kind === "function" || e.kind === "heading" || e.kind === "block");
		const cutoff = firstDef?.line ?? null;
		const lastLine = cutoff && cutoff > 1 ? cutoff - 1 : totalLines;
		const slice = allLines.slice(0, lastLine);
		const header = cutoff
			? `# ${absolutePath}::__preamble__  lines 1-${lastLine} (before line ${cutoff})`
			: `# ${absolutePath}::__preamble__  lines 1-${lastLine} (no class/function found — whole file)`;
		dedupeCache.set(key, { sha, callIndex: ++callIndex.current });
		return { content: [{ type: "text", text: `${header}\n${slice.join("\n")}` }] };
	}

	if (symbol) {
		const result = outline(absolutePath, content);
		// Exact match first (handles dotted entry names like TOML sections).
		let hit = result.entries.find((e) => e.name === symbol);
		if (!hit) {
			const dot = symbol.lastIndexOf(".");
			if (dot >= 0) {
				const lookupName = symbol.slice(dot + 1);
				const lookupParent = symbol.slice(0, dot);
				hit = result.entries.find(
					(e) => e.name === lookupName && e.parent === lookupParent,
				);
			}
		}
		if (!hit) {
			return {
				content: [{ type: "text", text: `Symbol "${symbol}" not found in ${absolutePath}.` }],
				isError: true,
			};
		}
		const slice = allLines.slice(hit.line - 1, hit.lineEnd);
		const header = `# ${absolutePath}::${symbol}  lines ${hit.line}-${hit.lineEnd} (${hit.kind})`;
		const meta: string[] = [];
		if (hit.docFirstLine) meta.push(`Docstring: ${hit.docFirstLine}`);
		const preamble = meta.length > 0 ? `${header}\n${meta.join("\n")}\n` : `${header}\n`;
		const numbered = slice.map((line, i) => `  ${hit.line + i}: ${line}`).join("\n");
		dedupeCache.set(key, { sha, callIndex: ++callIndex.current });
		return { content: [{ type: "text", text: `${preamble}${numbered}` }] };
	}

	if (totalLines <= SMALL_FILE_LINES) {
		dedupeCache.set(key, { sha, callIndex: ++callIndex.current });
		return {
			content: [{ type: "text", text: `# ${absolutePath} (${totalLines} lines)\n${content}` }],
		};
	}

	const result = outline(absolutePath, content);
	const view = collapsedView(result, { hidePrivate: true, maxLines: 200 });
	dedupeCache.set(key, { sha, callIndex: ++callIndex.current });
	return {
		content: [
			{ type: "text", text: `# outline of ${absolutePath} (${totalLines} lines)\n${view.join("\n")}` },
		],
	};
}
