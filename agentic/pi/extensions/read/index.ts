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
 *
 * Beyond plain-text source, `read` also handles:
 *   • Documents (PDF, DOCX, XLSX, PPTX) → converted to Markdown via the
 *     `docling` CLI, then rendered through the same outline/symbol pipeline.
 *   • URLs (http/https) → downloaded and converted to Markdown via docling,
 *     so a single tool reads local files, documents, and web pages alike.
 * Both conversions are cached on disk keyed by content/URL so repeat reads
 * skip docling entirely.
 */

import { spawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	type AgentToolResult,
	createReadToolDefinition,
	type ExtensionAPI,
	type Theme,
	type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { type Component, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

// ---------------------------------------------------------------------------
// DOCX comment extraction
// ---------------------------------------------------------------------------

/**
 * Read a specific entry from a DOCX (ZIP) file.
 * Returns the uncompressed content as a string, or null if not found.
 */
async function readDocxZipEntry(docxPath: string, entryName: string): Promise<string | null> {
	// Use unzip -p to extract a specific file to stdout
	const { exec } = await import("node:child_process");
	const { promisify } = await import("node:util");
	const execAsync = promisify(exec);
	
	try {
		const { stdout } = await execAsync(`unzip -p "${docxPath}" "${entryName}" 2>/dev/null`);
		return stdout;
	} catch {
		return null;
	}
}

interface DocxComment {
	id: string;
	author: string;
	initials: string;
	date: string;
	text: string;
	anchorText?: string; // Text between commentRangeStart/End in document.xml
}

interface DocxCommentWithAnchor extends DocxComment {
	anchorText: string;
}

/**
 * Extract inline comments from a DOCX file.
 * Parses word/comments.xml to get comment metadata and text.
 */
async function extractDocxComments(docxPath: string): Promise<DocxComment[]> {
	const commentsXml = await readDocxZipEntry(docxPath, "word/comments.xml");
	if (!commentsXml) return [];

	const comments: DocxComment[] = [];
	
	// Parse XML using regex-based extraction (avoiding dependencies)
	// Match comment elements: <w:comment w:id="..." w:author="..." w:date="..." w:initials="...">...</w:comment>
	const commentRegex = /<w:comment\s+([^>]+)>([\s\S]*?)<\/w:comment>/g;
	
	let match;
	while ((match = commentRegex.exec(commentsXml)) !== null) {
		const [, attrs, content] = match;
		
		// Extract attributes
		const idMatch = attrs.match(/w:id="([^"]+)"/);
		const authorMatch = attrs.match(/w:author="([^"]+)"/);
		const dateMatch = attrs.match(/w:date="([^"]+)"/);
		const initialsMatch = attrs.match(/w:initials="([^"]+)"/);
		
		if (!idMatch || !authorMatch || !dateMatch) continue;
		
		// Extract text from <w:t> elements within the comment
		const textRegex = /<w:t[^>]*>([\s\S]*?)<\/w:t>/g;
		const textParts: string[] = [];
		let textMatch;
		while ((textMatch = textRegex.exec(content)) !== null) {
			textParts.push(textMatch[1]);
		}
		
		comments.push({
			id: idMatch[1],
			author: authorMatch[1],
			date: dateMatch[1],
			initials: initialsMatch ? initialsMatch[1] : "",
			text: textParts.join(" ").trim(),
		});
	}
	
	return comments;
}

/**
 * Extract comment anchor text from document.xml using commentRangeStart/End markers.
 * Returns a map of comment ID to the text the comment references.
 */
async function extractDocxCommentAnchors(docxPath: string, comments: DocxComment[]): Promise<Map<string, string>> {
	const docXml = await readDocxZipEntry(docxPath, "word/document.xml");
	if (!docXml) return new Map();

	const anchorMap = new Map<string, string>();
	
	for (const comment of comments) {
		// Find the text between commentRangeStart and commentRangeEnd for this comment id
		const rangeRegex = new RegExp(
			`<w:commentRangeStart\\s+w:id="${comment.id}"\\s*/>([\\s\\S]*?)<w:commentRangeEnd\\s+w:id="${comment.id}"\\s*/>`,
			"g"
		);
		const rangeMatch = docXml.match(rangeRegex);
		
		if (rangeMatch) {
			// Extract text from <w:t> elements between the markers
			const textRegex = /<w:t[^>]*>([\s\S]*?)<\/w:t>/g;
			const textParts: string[] = [];
			let textMatch;
			while ((textMatch = textRegex.exec(rangeMatch[0])) !== null) {
				textParts.push(textMatch[1]);
			}
			const anchorText = textParts.join(" ").trim();
			if (anchorText) {
				anchorMap.set(comment.id, anchorText);
			}
		}
	}
	
	return anchorMap;
}

/**
 * Inject DOCX comments into markdown content.
 * Comments are inserted inline after the text they reference.
 */
function injectDocxCommentsIntoMarkdown(markdown: string, comments: DocxComment[], anchorMap: Map<string, string>): string {
	if (comments.length === 0) return markdown;

	// Build comments with anchor text
	const commentsWithAnchors: DocxCommentWithAnchor[] = comments
		.filter(c => anchorMap.has(c.id))
		.map(c => ({ ...c, anchorText: anchorMap.get(c.id)! }));

	// If we have comments with anchor text, inject them after matching text
	let result = markdown;
	const processedCommentIds = new Set<string>();
	
	// Sort comments by anchor text length (longest first) to avoid substring matching issues
	commentsWithAnchors.sort((a, b) => b.anchorText.length - a.anchorText.length);
	
	for (const comment of commentsWithAnchors) {
		// Escape special regex characters in the anchor text
		const escapedText = comment.anchorText
			.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
			.replace(/\s+/g, "\\s+");
		
		// Find the text in the markdown and inject comments after it
		const regex = new RegExp(`(${escapedText})`, "i");
		const match = result.match(regex);
		
		if (match && match.index !== undefined) {
			// Format comment
			const commentBlock = `> 💬 **${comment.author}** (${new Date(comment.date).toLocaleDateString()}): ${comment.text}`;
			
			const injectionPoint = match.index + match[0].length;
			result = result.slice(0, injectionPoint) + "\n\n" + commentBlock + "\n" + result.slice(injectionPoint);
			processedCommentIds.add(comment.id);
		}
	}

	// If there are unmatched comments (no anchor found), append them at the end
	const unmatchedComments = comments.filter(c => !processedCommentIds.has(c.id));
	
	if (unmatchedComments.length > 0) {
		const appendSection = "\n\n---\n\n## Review Comments\n\n" +
			unmatchedComments
				.map(c => `> 💬 **${c.author}** (${new Date(c.date).toLocaleDateString()}): ${c.text}`)
				.join("\n\n");
		result += appendSection;
	}

	return result;
}

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
		outlineModule = await jiti.import("../_outliner/outliner.js", { default: true });
	}
	if (!indexStoreModule) {
		indexStoreModule = await jiti.import("../search/index-store.js", { default: true });
	}
	return { outliner: outlineModule!, indexStore: indexStoreModule! };
}

// ---------------------------------------------------------------------------
// Session dedupe cache
// ---------------------------------------------------------------------------

const callIndex = { current: 0 };
const dedupeCache = new Map<string, { sha: string; callIndex: number; text: string }>();

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

function sha256String(s: string): string {
	return crypto.createHash("sha256").update(s).digest("hex");
}

// ---------------------------------------------------------------------------
// docling conversion (documents + URLs → Markdown)
//
// Documents and web pages are converted to Markdown by the `docling` CLI and
// the result is cached on disk keyed by content sha / URL hash, so repeat
// reads skip docling. The cached Markdown is then rendered through the same
// outline/symbol pipeline as any other Markdown file.
// ---------------------------------------------------------------------------

const DOCUMENT_EXTENSIONS = new Set([".pdf", ".docx", ".xlsx", ".pptx"]);
const VERBATIM_EXTENSIONS = new Set([".tex", ".latex", ".ltx", ".sty", ".cls"]);
const URL_RE = /^https?:\/\//i;

const DOC_CACHE_DIR = path.join(os.tmpdir(), "pi-read-doc-cache");

function docCachePath(key: string): string {
	return path.join(DOC_CACHE_DIR, `${key}.md`);
}

/** Run `docling --to md` on a source (local path or URL) into `outputDir`. */
function runDocling(outputDir: string, source: string, signal?: AbortSignal): Promise<{ status: number; stderr: string }> {
	return new Promise((resolve, reject) => {
		const proc = spawn("docling", ["--to", "md", "--device", "auto", "--output", outputDir, source], {
			stdio: ["ignore", "ignore", "pipe"],
		});
		const err: Buffer[] = [];
		proc.stderr.on("data", (d: Buffer) => err.push(d));
		proc.on("close", (code) => resolve({ status: code ?? 1, stderr: Buffer.concat(err).toString() }));
		proc.on("error", (e) => reject(e));
		if (signal) signal.addEventListener("abort", () => proc.kill());
	});
}

/** docling writes exactly one `.md` file per source; find it regardless of name. */
function findMarkdown(dir: string): string | null {
	let files: string[];
	try {
		files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".md"));
	} catch {
		return null;
	}
	return files.length > 0 ? path.join(dir, files[0]!) : null;
}

/**
 * Convert a document/URL to Markdown via docling, caching the result on disk
 * keyed by `cacheKey`. Returns the Markdown text. Throws on conversion failure.
 */
async function convertToMarkdown(source: string, cacheKey: string, signal?: AbortSignal): Promise<string> {
	try {
		fs.mkdirSync(DOC_CACHE_DIR, { recursive: true });
	} catch {
		/* ignore */
	}

	// Cache hit → reuse the previously parsed Markdown.
	const cacheFile = docCachePath(cacheKey);
	try {
		const cached = fs.readFileSync(cacheFile, "utf-8");
		if (cached.length > 0) return cached;
	} catch {
		/* cache miss, continue */
	}

	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "docling-"));
	try {
		const { status, stderr } = await runDocling(tmpDir, source, signal);
		const mdFile = findMarkdown(tmpDir);
		const body = mdFile ? fs.readFileSync(mdFile, "utf-8") : "";
		if (!body) {
			throw new Error(`docling produced no output (exit ${status})${stderr ? `: ${stderr.trim().slice(0, 300)}` : ""}`);
		}

		// For DOCX files, extract and inject inline comments
		let result = body;
		if (source.toLowerCase().endsWith(".docx")) {
			const comments = await extractDocxComments(source);
			if (comments.length > 0) {
				const anchorMap = await extractDocxCommentAnchors(source, comments);
				result = injectDocxCommentsIntoMarkdown(result, comments, anchorMap);
			}
		}

		fs.writeFileSync(cacheFile, result, "utf-8");
		return result;
	} finally {
		try {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	}
}

const SMALL_FILE_LINES = 100;
const DIR_ENTRY_LIMIT = 200;

// Footer appended to every outline. This outline IS the whole-file view, so
// the footer steers the model to drill in (rather than re-read the path, which
// just returns the same outline and trips the `no-repeat` guard).
const OUTLINE_FOOTER =
	`# This outline is the whole-file view — reading this path again returns the same outline. ` +
	`To see content, read again with symbol="<name>" for a function/class/section body (names above), ` +
	`symbol="__preamble__" for imports/constants, or use \`search\` to locate something specific.`;

function listDirectory(absolutePath: string) {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(absolutePath, { withFileTypes: true });
	} catch (err) {
		return {
			content: [{ type: "text", text: `Could not read directory ${absolutePath}: ${(err as Error).message}` }],
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

	// Delegate result rendering to pi's built-in `read` renderer, first
	// collapsing any skill-autoload injection to its summary line (see
	// renderResult below). Captured here because renderResult is synchronous and
	// cannot await the sibling-extension helper import itself.
	const builtinReadRenderResult = createReadToolDefinition(process.cwd()).renderResult as RenderResultFn;
	const { collapseAutoloadResult } = await loadSkillRenderHelpers();

	pi.registerTool({
		name: "read",
		label: "read",
		description:
			"Read a file, document, web page, or list a directory. The `path` may be a local path or an http(s) URL.\n" +
			"  • Path is a directory → truncated listing of entries (dirs first, then files).\n" +
			"  • Document (PDF, DOCX, XLSX, PPTX) or URL → converted to Markdown via docling, then rendered exactly like any Markdown file (outline for large ones; read a section with symbol=\"<heading>\"). Conversions are cached, so re-reading the same document/URL is cheap.\n" +
			"  • No symbol, small file → verbatim contents.\n" +
			"  • No symbol, large file → outline (module doc, classes/functions with signatures, type hints, and doc-first-line). Use the outline to pick a symbol.\n" +
			"  • symbol set → body of that symbol only (supports 'Class.method').\n" +
			"  • symbol=\"__preamble__\" → everything before the first class/function (imports, constants, module setup).\n" +
			"There is no pagination — you cannot walk a file via offset/limit. If the outline is not enough, use the `search` tool to locate what you need, then read the symbol.\n" +
			"Prefer `read` for fetching web pages — it's quicker and converts to Markdown via docling. Only use `web_browse` for interactive/JS-heavy pages that need clicking, typing, or JavaScript execution.",
		parameters: Params,

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const { path: filePath, symbol } = params;
			// 0a. URL → download + convert to Markdown via docling, then render.
			if (URL_RE.test(filePath)) {
				const sha = sha256String(filePath);
				const key = cacheKey(sha, filePath, symbol);
				const cached = dedupeCache.get(key);
				if (cached && cached.sha === sha) {
					return {
						content: [{ type: "text", text: cached.text }],
						details: { dedupe: true, callIndex: cached.callIndex },
					};
				}
				let markdown: string;
				try {
					markdown = await convertToMarkdown(filePath, sha, signal);
				} catch (err) {
					return { content: [{ type: "text", text: `Could not fetch ${filePath} via docling: ${(err as Error).message}` }] };
				}
				const banner = `# ${filePath} — fetched and converted to Markdown via docling`;
				const rendered = withBanner(renderContent(filePath, "page.md", markdown, symbol, outline, collapsedView, key, sha), banner);
				const callIdx = ++callIndex.current;
				dedupeCache.set(key, { sha, callIndex: callIdx, text: rendered.content[0].text });
				return rendered;
			}

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
					};
				} catch {
					return {
						content: [{ type: "text", text: "SYSTEM.md is the child agent's system prompt." }],
					};
				}
			}		// 1. Existence check
		if (!fs.existsSync(absolutePath)) {
			return {
				content: [{ type: "text", text: `File not found: ${absolutePath}` }],
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

		// 2. Image passthrough — read binary and return as image block
		if (isLikelyImage(absolutePath)) {
			const buffer = fs.readFileSync(absolutePath);
			const ext = path.extname(absolutePath).toLowerCase();
			const mimeType =
				ext === ".jpg" || ext === ".jpeg"
					? "image/jpeg"
					: ext === ".png"
						? "image/png"
						: ext === ".gif"
							? "image/gif"
							: ext === ".webp"
								? "image/webp"
								: "application/octet-stream";
			return {
				content: [
					{ type: "image", data: buffer.toString("base64"), mimeType },
				],
			};
		}

			// 3. SHA-256 + dedupe lookup
			const sha = sha256(absolutePath);
			const key = cacheKey(sha, absolutePath, symbol);
			const cached = dedupeCache.get(key);
			if (cached && cached.sha === sha) {
				return {
					content: [{ type: "text", text: cached.text }],
					details: { dedupe: true, callIndex: cached.callIndex },
				};
			}

			// 3b. Documents (PDF/DOCX/XLSX/PPTX) → convert to Markdown via docling
			// (cached by content sha), then render like any other Markdown file.
			const ext = path.extname(absolutePath).toLowerCase();
			if (DOCUMENT_EXTENSIONS.has(ext)) {
				let markdown: string;
				try {
					markdown = await convertToMarkdown(absolutePath, sha, signal);
				} catch (err) {
					return { content: [{ type: "text", text: `Could not convert ${path.basename(absolutePath)} via docling: ${(err as Error).message}` }] };
				}
				const displayPath = path.basename(absolutePath);
				const banner = `# ${displayPath} — ${ext.slice(1).toUpperCase()} converted to Markdown via docling`;
				const rendered = withBanner(renderContent(displayPath, `${displayPath}.md`, markdown, symbol, outline, collapsedView, key, sha), banner);
				const callIdx = ++callIndex.current;
				dedupeCache.set(key, { sha, callIndex: callIdx, text: rendered.content[0].text });
				return rendered;
			}

			// 4. Open the index (no full build) and determine repo membership.
			// Use the session cwd (ctx.cwd), not process.cwd() — see the search
			// extension for why the two can diverge.
			const { repoRoot } = openIndex(ctx?.cwd ?? process.cwd());
			const relPath = path.relative(repoRoot, absolutePath);
			const isOutsideRepo = relPath.startsWith("..");

			// 4a. Verbatim extensions (LaTeX) → always return full content regardless of size.
			if (VERBATIM_EXTENSIONS.has(ext)) {
				const content = fs.readFileSync(absolutePath, "utf-8");
				const allLines = content.split("\n");
				const totalLines = allLines.length;
				const displayPath = isOutsideRepo ? path.basename(absolutePath) : relPath;
				const banner = `# ${displayPath} (${totalLines} lines) — verbatim content (LaTeX extension)`;
				const callIdx = ++callIndex.current;
				dedupeCache.set(key, { sha, callIndex: callIdx, text: `${banner}\n${content}` });
				return { content: [{ type: "text", text: `${banner}\n${content}` }] };
			}

			// File lives outside the repo — fall back to verbatim/outline without the index.
			if (isOutsideRepo) {
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
				const callIdx = ++callIndex.current;
				dedupeCache.set(key, { sha, callIndex: callIdx, text: `${preambleHeader}\n${slice.join("\n")}` });
				return { content: [{ type: "text", text: `${preambleHeader}\n${slice.join("\n")}` }] };
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
					};
				}
				const slice = allLines.slice(sym.line_start - 1, sym.line_end);
				const symbolHeader = `# ${relPath}::${symbol}  lines ${sym.line_start}-${sym.line_end} (${sym.kind})`;
				const symbolPreamble = `${symbolHeader}\n`;
				const numbered = slice.map((line, i) => `  ${sym.line_start + i}: ${line}`).join("\n");
				const callIdx = ++callIndex.current;
				dedupeCache.set(key, { sha, callIndex: callIdx, text: `${symbolPreamble}${numbered}` });
				return { content: [{ type: "text", text: `${symbolPreamble}${numbered}` }] };
			}

			// 6. Small file → verbatim
			if (totalLines <= SMALL_FILE_LINES) {
				const smallFileHeader = `# ${relPath} (${totalLines} lines)`;
				const callIdx = ++callIndex.current;
				dedupeCache.set(key, { sha, callIndex: callIdx, text: `${smallFileHeader}\n${content}` });
				return { content: [{ type: "text", text: `${smallFileHeader}\n${content}` }] };
			}

			// 7. Large file → outline from the index
			const stored = getFileOutline(db, relPath);
			const result = stored
				? { moduleDoc: stored.doc ?? undefined, entries: stored.entries }
				: outline(absolutePath, content);
			// Nothing to navigate → return the whole file rather than an empty outline.
			if (result.entries.length === 0) {
				const callIdx = ++callIndex.current;
				dedupeCache.set(key, { sha, callIndex: callIdx, text: `# ${relPath} (${totalLines} lines, no sections — full contents)\n${content}` });
				return { content: [{ type: "text", text: `# ${relPath} (${totalLines} lines, no sections — full contents)\n${content}` }] };
			}
			const view = collapsedView(result, { hidePrivate: true, maxLines: 200 });
			const outlineHeader = `# outline of ${relPath} (${totalLines} lines)`;
			const footer = OUTLINE_FOOTER;
			const callIdx = ++callIndex.current;
			const output = `${outlineHeader}\n${view.join("\n")}\n${footer}`;
			dedupeCache.set(key, { sha, callIndex: callIdx, text: output });
			return {
				content: [
					{ type: "text", text: output },
				],
			};
		},

		renderCall(args, theme) {
			const rawPath = args?.path;
			const pathStr = rawPath ? String(rawPath) : "...";
			const symbol = args?.symbol;
			const suffix = symbol ? `::${String(symbol)}` : "";
			return new Text(
				`${theme.fg("toolTitle", theme.bold("read"))} ${theme.fg("accent", pathStr)}${theme.fg("warning", suffix)}`,
				0,
				0,
			);
		},

		// A blocked read (e.g. skill autoload) surfaces as an error result whose
		// text the harness shows in full even when collapsed. Collapse such an
		// injection to its `↪ … skills injected` summary line, then defer to pi's
		// built-in read renderer — so the full guidance still shows on expand
		// (Ctrl+O) and every other result renders exactly as before.
		renderResult(result, options, theme, context) {
			return builtinReadRenderResult(
				collapseAutoloadResult(result, options.expanded, context.isError),
				options,
				theme,
				context,
			);
		},
	});
}

// ---------------------------------------------------------------------------
// Sibling/built-in module loaders (resolved lazily, like loadModules above)
// ---------------------------------------------------------------------------

// `ToolRenderContext` is not exported from the package root, so type the
// context structurally with the fields the built-in read renderer reads. The
// full context the harness passes is a superset and assigns cleanly.
interface ReadRenderContext {
	args: unknown;
	isError: boolean;
	expanded: boolean;
	showImages: boolean;
	cwd: string;
	lastComponent: Component | undefined;
}

type RenderResultFn = (
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: ReadRenderContext,
) => Component;

/** Load the skill-autoload render helpers from the sibling `skill` extension. */
async function loadSkillRenderHelpers(): Promise<typeof import("../skill/types.ts")> {
	const jiti = await import("jiti").then((m) => m.createJiti(import.meta.url, { moduleCache: false }));
	return jiti.import("../skill/types.ts") as Promise<typeof import("../skill/types.ts")>;
}

// ---------------------------------------------------------------------------
// Index-free rendering (files outside the repo, converted documents, URLs)
// ---------------------------------------------------------------------------

/** Prepend a one-line banner to a tool result's first text block. */
function withBanner(result: { content: { type: string; text: string }[] }, banner: string) {
	const first = result.content[0];
	if (first && first.type === "text") first.text = `${banner}\n${first.text}`;
	return result;
}

/**
 * Render content (verbatim / outline / symbol body) without the SQLite index.
 *
 * `displayPath` is shown in headers; `outlinePath` is used purely for the
 * outliner's language detection (e.g. pass a `.md` path so converted documents
 * and web pages are outlined by their Markdown headings).
 */
function renderContent(
	displayPath: string,
	outlinePath: string,
	content: string,
	symbol: string | undefined,
	outline: (typeof import("../_outliner/outliner.js"))["outline"],
	collapsedView: (typeof import("../_outliner/outliner.js"))["collapsedView"],
	key: string,
	sha: string,
) {
	const allLines = content.split("\n");
	const totalLines = allLines.length;

	if (symbol === "__preamble__") {
		const result = outline(outlinePath, content);
		const firstDef = result.entries.find((e) => e.kind === "class" || e.kind === "function" || e.kind === "heading" || e.kind === "block");
		const cutoff = firstDef?.line ?? null;
		const lastLine = cutoff && cutoff > 1 ? cutoff - 1 : totalLines;
		const slice = allLines.slice(0, lastLine);
		const header = cutoff
			? `# ${displayPath}::__preamble__  lines 1-${lastLine} (before line ${cutoff})`
			: `# ${displayPath}::__preamble__  lines 1-${lastLine} (no class/function found — whole file)`;
		const text = `${header}\n${slice.join("\n")}`;
		const callIdx = ++callIndex.current;
		dedupeCache.set(key, { sha, callIndex: callIdx, text });
		return { content: [{ type: "text", text }] };
	}

	if (symbol) {
		const result = outline(outlinePath, content);
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
				content: [{ type: "text", text: `Symbol "${symbol}" not found in ${displayPath}.` }],
			};
		}
		const slice = allLines.slice(hit.line - 1, hit.lineEnd);
		const header = `# ${displayPath}::${symbol}  lines ${hit.line}-${hit.lineEnd} (${hit.kind})`;
		const meta: string[] = [];
		if (hit.docFirstLine) meta.push(`Docstring: ${hit.docFirstLine}`);
		const preamble = meta.length > 0 ? `${header}\n${meta.join("\n")}\n` : `${header}\n`;
		const numbered = slice.map((line, i) => `  ${hit.line + i}: ${line}`).join("\n");
		const text = `${preamble}${numbered}`;
		const callIdx = ++callIndex.current;
		dedupeCache.set(key, { sha, callIndex: callIdx, text });
		return { content: [{ type: "text", text }] };
	}

	if (totalLines <= SMALL_FILE_LINES) {
		const text = `# ${displayPath} (${totalLines} lines)\n${content}`;
		const callIdx = ++callIndex.current;
		dedupeCache.set(key, { sha, callIndex: callIdx, text });
		return {
			content: [{ type: "text", text }],
		};
	}

	const result = outline(outlinePath, content);
	// No structure to navigate (e.g. a heading-less document or a flat
	// Markdown file) → there's nothing to pick a symbol from, so just return
	// the whole thing verbatim rather than an empty outline.
	if (result.entries.length === 0) {
		const text = `# ${displayPath} (${totalLines} lines, no sections — full contents)\n${content}`;
		const callIdx = ++callIndex.current;
		dedupeCache.set(key, { sha, callIndex: callIdx, text });
		return {
			content: [{ type: "text", text }],
		};
	}
	const view = collapsedView(result, { hidePrivate: true, maxLines: 200 });
	const text = `# outline of ${displayPath} (${totalLines} lines)\n${view.join("\n")}\n${OUTLINE_FOOTER}`;
	const callIdx = ++callIndex.current;
	dedupeCache.set(key, { sha, callIndex: callIdx, text });
	return {
		content: [
			{ type: "text", text },
		],
	};
}


/** Read a file living outside the indexed repo, then render it index-free. */
function readOutsideRepo(
	absolutePath: string,
	symbol: string | undefined,
	outline: (typeof import("../_outliner/outliner.js"))["outline"],
	collapsedView: (typeof import("../_outliner/outliner.js"))["collapsedView"],
	key: string,
	sha: string,
)	{
	const content = fs.readFileSync(absolutePath, "utf-8");

	return renderContent(absolutePath, absolutePath, content, symbol, outline, collapsedView, key, sha);
}
