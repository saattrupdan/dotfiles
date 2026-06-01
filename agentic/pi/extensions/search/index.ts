/**
 * `search` tool extension.
 *
 * Provides a per-repo indexed search tool that:
 * - Builds a SQLite index with file manifest + tree-sitter symbol extraction
 * - Merges definition-first results (SQLite) with ripgrep full-text refs
 * - Promotes exact symbol matches to the top
 * - Incrementally refreshes on every call
 *
 * This extension is loaded from the `.pi/agent/extensions/search/` directory
 * and registered via the standard pi extension API.
 */

import * as childProcess from "node:child_process";

// Find ripgrep binary — shipped with VS Code or available via homebrew/npm.
const RGP_PATHS = [
	"/Applications/Visual Studio Code.app/Contents/Resources/app/node_modules/node_modules/@vscode/ripgrep/bin/rg",
	"/Applications/Visual Studio Code.app/Contents/Resources/app/extensions/search-insights/node_modules/@vscode/ripgrep/bin/rg",
	"/opt/homebrew/bin/rg",
	"/usr/local/bin/rg",
	"rg",
];

function findRipgrep(): string {
	for (const p of RGP_PATHS) {
		try {
			childProcess.execSync(`"${p}" --version`, { stdio: "ignore" });
			return p;
		} catch { /* try next */ }
	}
	return "rg"; // hope it's in PATH
}

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

// ---------------------------------------------------------------------------
// Resolve the outliner — use jiti-relative import from the extension dir
// ---------------------------------------------------------------------------

let outlineModule: typeof import("../_outliner/outliner.js") | null = null;

async function loadOutliner(): Promise<typeof import("../_outliner/outliner.js") | null> {
	if (outlineModule) return outlineModule;
	const jiti = await import("jiti").then((m) => m.createJiti(import.meta.url, { moduleCache: false }));
	 
	outlineModule = await jiti.import("../_outliner/outliner.js", { default: true }) as typeof import("../_outliner/outliner.js") | null;
	return outlineModule;
}

// ---------------------------------------------------------------------------
// Lazy index build + incremental refresh
// ---------------------------------------------------------------------------

import {
	ensureFullIndex,
	reconcileIndex,
	touchMeta,
	querySymbols,
	queryExactSymbol,
	queryFilesByName,
} from "./index-store.js";

// ---------------------------------------------------------------------------
// Ripgrep search
// ---------------------------------------------------------------------------

/**
 * A single content match from ripgrep (or the grep fallback).
 */
interface RipgrepResult {
	file: string;
	line: number;
	snippet: string;
}

/**
 * Outcome of a content search: the matches, which engine produced them, the
 * true total (before any display cap), and an optional diagnostic. The
 * diagnostic lets callers tell "genuinely zero matches" apart from "the search
 * engine failed" — the old code swallowed every failure and returned `[]`,
 * which is why `search` so often reported nothing where a manual grep worked.
 */
interface RefSearch {
	results: RipgrepResult[];
	engine: "ripgrep" | "grep" | "none";
	total: number;
	error?: string;
}

/**
 * Parse ripgrep `--json` stream output into content matches.
 *
 * The snippet comes from `data.lines.text` (the full matching line). The
 * previous implementation read `submatches[].match` as a boolean and then
 * `.text` off the submatch — but `match` is an OBJECT (`{text: "…"}`) and the
 * submatch has no `.text`, so every snippet came back empty.
 */
function parseRipgrepJson(output: string): RipgrepResult[] {
	const results: RipgrepResult[] = [];
	for (const line of output.split("\n")) {
		if (!line.trim()) continue;
		try {
			const parsed = JSON.parse(line);
			if (parsed.type !== "match") continue;
			const data = parsed.data;
			const file = data.path?.text ?? "";
			const lineNum = data.line_number ?? 0;
			const snippet = String(data.lines?.text ?? "").replace(/\r?\n$/, "").trim();
			if (file) results.push({ file, line: lineNum, snippet });
		} catch {
			// Skip non-JSON / summary lines
		}
	}
	return results;
}

/**
 * Parse `grep -rnI` output (`path:line:content`) into content matches.
 */
function parseGrepOutput(output: string): RipgrepResult[] {
	const results: RipgrepResult[] = [];
	for (const line of output.split("\n")) {
		if (!line.trim()) continue;
		const m = line.match(/^(.*?):(\d+):(.*)$/);
		if (!m) continue;
		results.push({ file: m[1], line: Number(m[2]), snippet: m[3].trim() });
	}
	return results;
}

/**
 * Fall back to the system `grep` when ripgrep is missing or errors, so content
 * search keeps working — and stays at parity with what the user gets from a
 * manual grep — instead of silently returning nothing.
 */
function runGrepFallback(repoRoot: string, query: string, regex: boolean, rgError?: string): RefSearch {
	try {
		const proc = childProcess.spawnSync(
			"grep",
			[
				"-rnI",
				regex ? "-E" : "-F",
				"--exclude-dir=.git",
				"--exclude-dir=node_modules",
				"--exclude-dir=.venv",
				"--exclude-dir=__pycache__",
				"--",
				query,
				".",
			],
			{
				cwd: repoRoot,
				stdio: "pipe",
				encoding: "utf-8",
				maxBuffer: 128 * 1024 * 1024,
			},
		);
		// grep exit codes: 0 = matches, 1 = no matches (normal), ≥2 = error.
		if (proc.error || (proc.status ?? 2) >= 2) {
			const grepErr = proc.error?.message ?? proc.stderr?.trim() ?? "failed";
			return {
				results: [],
				engine: "none",
				total: 0,
				error: `content search unavailable (ripgrep: ${rgError ?? "not found"}; grep: ${grepErr})`,
			};
		}
		const results = parseGrepOutput(proc.stdout || "");
		return {
			results,
			engine: "grep",
			total: results.length,
			error: rgError ? `note: ripgrep unavailable (${rgError}) — used grep` : undefined,
		};
	} catch (err) {
		return {
			results: [],
			engine: "none",
			total: 0,
			error: `content search unavailable: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
}

/** Escape regex metacharacters so a literal token is safe in a regex pattern. */
function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Count how many of `tokens` (already lower-cased) appear in `text`. */
function tokenCoverage(text: string, tokens: string[]): number {
	const lower = text.toLowerCase();
	let n = 0;
	for (const t of tokens) if (lower.includes(t)) n++;
	return n;
}

/**
 * Run a single content search against ripgrep (fast, .gitignore-aware), falling
 * back to grep when ripgrep is unavailable or errors, surfacing the reason
 * rather than swallowing it.
 */
function runEngine(repoRoot: string, query: string, regex: boolean): RefSearch {
	let rgError: string | undefined;
	try {
		const rgPath = findRipgrep();
		const proc = childProcess.spawnSync(
			rgPath,
			[
				"--json",
				"-n",
				// --smart-case: case-insensitive unless the query contains an
				//   uppercase letter — matches what people expect from quick search.
				"--smart-case",
				// --hidden: also search dotfiles like .zshrc (still honours
				//   .gitignore, so node_modules/ etc. stay excluded).
				"--hidden",
				// -F: literal string unless the caller asked for regex, so a bare
				//   "(" or "." is not a regex parse error / wildcard.
				...(regex ? [] : ["-F"]),
				"--",
				query,
			],
			{
				cwd: repoRoot,
				stdio: "pipe",
				encoding: "utf-8",
				// Default maxBuffer is 1 MB — large result sets get silently
				// truncated/errored. Give it room.
				maxBuffer: 128 * 1024 * 1024,
			},
		);
		// rg exit codes: 0 = matches, 1 = no matches (normal), 2 = error.
		if (!proc.error && (proc.status === 0 || proc.status === 1)) {
			const results = parseRipgrepJson(proc.stdout || "");
			return { results, engine: "ripgrep", total: results.length };
		}
		rgError = proc.error?.message ?? proc.stderr?.trim() ?? `exit ${proc.status}`;
	} catch (err) {
		rgError = err instanceof Error ? err.message : String(err);
	}
	// ripgrep missing or errored — fall back to grep.
	return runGrepFallback(repoRoot, query, regex, rgError);
}

/**
 * Full-text content search with a multi-term fallback.
 *
 * A literal query like "parse config" is first tried as an exact phrase. If that
 * matches nothing AND the query is multiple whitespace-separated words, it is
 * retried as an OR of the individual terms, with results ranked by how many
 * distinct terms each line contains (lines matching every term first). This is
 * why a two-word search no longer returns nothing when each word matches alone.
 * Regex queries (regex:true) are taken verbatim and never split.
 */
function searchContent(repoRoot: string, query: string, regex: boolean): RefSearch {
	const primary = runEngine(repoRoot, query, regex);
	if (primary.results.length > 0 || regex || primary.engine === "none") return primary;

	const tokens = query.trim().split(/\s+/).filter(Boolean);
	if (tokens.length < 2) return primary;

	const pattern = tokens.map(escapeRegex).join("|");
	const multi = runEngine(repoRoot, pattern, true);
	if (multi.results.length === 0 || multi.engine === "none") return primary;

	const lower = tokens.map((t) => t.toLowerCase());
	multi.results.sort((a, b) => tokenCoverage(b.snippet, lower) - tokenCoverage(a.snippet, lower));
	multi.total = multi.results.length;
	multi.error = `note: no exact match for "${query}" — showing lines matching any of: ${tokens.join(", ")} (most matches first)`;
	return multi;
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const Params = Type.Object({
	query: Type.String({ description: "Search query. Literal by default; multiple words are tried as an exact phrase, then as 'any of these words'. Use regex:true for a regular expression." }),
	kind: Type.Optional(
		Type.String({
			description: "Filter kind: 'def' for definitions, 'ref' for references (grep-style content matches), 'any' for both (default).",
			enum: ["def", "ref", "any"],
			default: "any",
		}),
	),
	regex: Type.Optional(
		Type.Boolean({
			description: "Treat the query as a regular expression instead of a literal string (default false).",
			default: false,
		}),
	),
});

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export default async function (pi: ExtensionAPI) {
	// Run GC at extension init
	const { gc: gcFunc } = await import("./gc.js");
	gcFunc();

	// Load outliner eagerly
	const outliner = await loadOutliner();
	const outline = outliner?.outline;

	pi.registerTool({
		name: "search",
		label: "search",
		description:
			"Search the repository using a per-repo SQLite index + ripgrep full-text search (with a grep fallback). Returns filename matches, then definitions, then content/reference matches — each with its own result budget so grep-style hits are never crowded out.\n\nQuery semantics: the query is matched as a LITERAL string by default (so `foo(` or `a.b` are safe). A multi-word query like `parse config` is first tried as an exact phrase; if that matches nothing, it falls back to matching lines containing ANY of the words, ranked with most-words-matched first (so search across separate terms still returns results). Matching is case-insensitive unless the query contains an uppercase letter. Set regex:true to match the query as a regular expression instead (taken verbatim, never split on spaces).\n\nUse for finding files by name, symbols (functions/classes), or grep-style text matches.",
		parameters: Params,

		async execute(
			_toolCallId,
			{ query, kind = "any", regex = false },
			_signal,
			_onUpdate,
			_ctx,
		) {
			if (!outline) {
				return {
					content: [{ type: "text", text: "Search index unavailable — outliner failed to load." }],
					details: undefined,
				};
			}
			const { db, repoId, repoRoot } = ensureFullIndex(process.cwd(), outline);
			touchMeta(repoId);

			// Reconcile the index against the live tree: add files created since
			// the last build, re-parse changed ones, drop deleted ones. Walking
			// the disk every call is cheap because refreshFile short-circuits
			// unchanged files via mtime/size.
			reconcileIndex(db, repoRoot, outline);

			// --- Definition lookup ---
			let defResults: { file: string; line: number; kind: string; name: string; parent: string | null }[] = [];

			if (kind === "def" || kind === "any") {
				const exactResults = queryExactSymbol(db, query);
				const substrResults = querySymbols(db, query);

				// Merge: exact matches first, then substring matches (dedup)
				const seen = new Set<string>();
				const merged: typeof defResults = [];

				for (const r of exactResults) {
					const key = `${r.file}:${r.line_start}`;
					if (!seen.has(key)) {
						seen.add(key);
						merged.push({
							file: r.file,
							line: r.line_start,
							kind: r.kind,
							name: r.name,
							parent: r.parent,
						});
					}
				}

				for (const r of substrResults) {
					const key = `${r.file}:${r.line_start}`;
					if (!seen.has(key)) {
						seen.add(key);
						merged.push({
							file: r.file,
							line: r.line_start,
							kind: r.kind,
							name: r.name,
							parent: r.parent,
						});
					}
				}

				defResults = merged;
			}

			// --- Filename matches ---
			const fileMatches = queryFilesByName(db, query);

			// --- Content / ref matches (ripgrep, grep fallback) ---
			let refSearch: RefSearch = { results: [], engine: "ripgrep", total: 0 };
			if (kind === "ref" || kind === "any") {
				refSearch = searchContent(repoRoot, query, regex);
			}
			const refResults = refSearch.results;

			// --- Merge & format ---
			// Each section gets its OWN budget. Previously a single 20-line cap was
			// applied by popping from the tail — and content matches were appended
			// last, so a common query would fill every slot with filename + symbol
			// substring matches and drop all grep-style hits. That is why `search`
			// reported nothing where grep found plenty.
			const FILE_CAP = 8;
			const DEF_CAP = 10;
			const REF_CAP = 40;

			// Build def lines
			interface DefHit { file: string; line: number; kind: string; name: string; lineKey: string; }
		const defLines: DefHit[] = [];
			const defMap = new Map<string, { kind: string; name: string }>();

			for (const r of defResults) {
				const kindLabel = r.kind === "class" ? "def class" : r.kind === "function" ? "def fn" : r.kind === "method" ? "def method" : "def";
				const lineKey = `${r.file}:${r.line}`;
				defMap.set(lineKey, { kind: kindLabel, name: r.name });
				defLines.push({ file: r.file, line: r.line, kind: kindLabel, name: r.name, lineKey });
			}

			// Build ref lines
			const refLines: { file: string; line: number; snippet: string }[] = [];
			for (const r of refResults) {
				const lineKey = `${r.file}:${r.line}`;
				if (!defMap.has(lineKey)) {
					refLines.push({ file: r.file, line: r.line, snippet: r.snippet });
				}
			}

			// Check for exact match promotion
			const hasExactMatch = defResults.length > 0 && defResults.every(
				(r) => r.name.toLowerCase() === query.toLowerCase(),
			);

			const output: string[] = [];

			// If exact match, promote to top with hint
			if (hasExactMatch && defLines.length > 0) {
				const first = defLines[0];
				output.push(`→ read("${first.file}", offset=${first.line})`);
			}

			// Filename matches (skip files already represented by a def hit),
			// capped independently so they can't crowd out content matches.
			const defFiles = new Set(defLines.map((d) => d.file));
			const fileHits = fileMatches.filter((f) => !defFiles.has(f.path));
			for (const f of fileHits.slice(0, FILE_CAP)) {
				output.push(`${f.path}  [file]  ${f.lines} lines`);
			}

			// Definition matches
			for (const d of defLines.slice(0, DEF_CAP)) {
				const truncated = (d.name || "").slice(0, 80);
				output.push(`${d.file}:${d.line}  [${d.kind}]  ${truncated}`);
			}

			// Content matches (grep-style) — given their OWN budget so a common
			// query can no longer starve them out of the result set.
			for (const r of refLines.slice(0, REF_CAP)) {
				const truncated = (r.snippet || "").slice(0, 120);
				output.push(`${r.file}:${r.line}  ${truncated}`);
			}

			if (output.length === 0) {
				output.push("No results found.");
			}

			// Footer: report what was truncated and any content-engine fallback,
			// so a failed/empty content search reads differently from a true zero.
			if (fileHits.length > FILE_CAP) output.push(`… ${fileHits.length - FILE_CAP} more file matches`);
			if (defLines.length > DEF_CAP) output.push(`… ${defLines.length - DEF_CAP} more definitions`);
			if (refLines.length > REF_CAP) output.push(`… ${refLines.length - REF_CAP} more content matches (refine the query)`);
			if (refSearch.error) output.push(refSearch.error);

			return {
				content: [{ type: "text", text: output.join("\n") }],
				details: undefined,
			};
		},

		renderCall(args, theme) {
			const query = args?.query ?? "...";
			const kind = args?.kind;
			return new Text(
				`${theme.fg("toolTitle", theme.bold("search"))} ${theme.fg("accent", String(query))}${kind ? theme.fg("warning", ` [${kind}]`) : ""}`,
				0,
				0,
			);
		},
	});
}
