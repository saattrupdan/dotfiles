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

import { binPath } from "@vscode/ripgrep";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

// ---------------------------------------------------------------------------
// Resolve the outliner — use jiti-relative import from the extension dir
// ---------------------------------------------------------------------------

let outlineModule: typeof import("../_outliner/outliner.js") | null = null;

async function loadOutliner(): Promise<typeof import("../_outliner/outliner.js")> {
	if (outlineModule) return outlineModule;
	const jiti = await import("jiti").then((m) => m.createJiti(import.meta.url, { moduleCache: false }));
	// @ts-expect-error - jiti.import returns unknown
	outlineModule = await jiti.import("../_outliner/outliner.js", { default: true });
	return outlineModule;
}

// ---------------------------------------------------------------------------
// Lazy index build + incremental refresh
// ---------------------------------------------------------------------------

import {
	ensureFullIndex,
	refreshFile,
	touchMeta,
	querySymbols,
	queryExactSymbol,
	queryFilesByName,
} from "./index-store.js";

// ---------------------------------------------------------------------------
// Ripgrep search
// ---------------------------------------------------------------------------

/**
 * Run ripgrep and parse JSON output.
 */
interface RipgrepResult {
	file: string;
	line: number;
	snippet: string;
}

function runRipgrep(repoRoot: string, query: string): RipgrepResult[] {
	const results: RipgrepResult[] = [];

	try {
		const rgPath = binPath;
		const proc = childProcess.spawnSync(
			rgPath,
			["--json", "-n", "--", query],
			{
				cwd: repoRoot,
				stdio: "pipe",
				encoding: "utf-8",
			},
		);

		const output = proc.stdout || "";
		const lines = output.split("\n").filter((l) => l.trim());

		for (const line of lines) {
			try {
				const parsed = JSON.parse(line);
				if (parsed.type === "match") {
					const data = parsed.data;
					const file = data.path?.text || "";
					const lineNum = data.line_number || 0;
					const snippet = (data.submatches || [])
						.find((s: { match: boolean }) => s.match)
						?.text || "";
					results.push({ file, line: lineNum, snippet });
				}
			} catch {
				// Skip non-JSON lines
			}
		}
	} catch {
		// ripgrep not available
	}

	return results;
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const Params = Type.Object({
	query: Type.String({ description: "Search query string." }),
	kind: Type.Optional(
		Type.String({
			description: "Filter kind: 'def' for definitions, 'ref' for references, 'any' for both (default).",
			enum: ["def", "ref", "any"],
			default: "any",
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
	const { outline } = outliner;

	pi.registerTool({
		name: "search",
		label: "search",
		description:
			"Search the repository using a per-repo SQLite index + ripgrep full-text search. Returns filename matches first, then definitions, then reference matches. Use for finding files by name, symbols (functions/classes), or grep-style text matches.",
		parameters: Params,

		async execute(
			_toolCallId,
			{ query, kind = "any" },
			_signal,
			_onUpdate,
			_ctx,
		) {
			const { db, repoId, repoRoot } = ensureFullIndex(process.cwd(), outline);
			touchMeta(repoId);

			// Incremental refresh: re-parse only changed files.
			const rows = db
				.prepare("SELECT path FROM files")
				.all() as { path: string }[];
			for (const r of rows) {
				refreshFile(db, repoRoot, r.path, outline);
			}

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

			// --- Ripgrep refs ---
			let refResults: RipgrepResult[] = [];
			if (kind === "ref" || kind === "any") {
				refResults = runRipgrep(repoRoot, query);
			}

			// --- Merge & format ---
			const MERGE_CAP = 20;

			// Build def lines
			const defLines: string[] = [];
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

			// Add filename matches (skip files already represented by a def hit)
			const defFiles = new Set(defLines.map((d) => d.file));
			for (const f of fileMatches) {
				if (defFiles.has(f.path)) continue;
				output.push(`${f.path}  [file]  ${f.lines} lines`);
			}

			// Add def lines
			for (const d of defLines.slice(0, Math.floor(MERGE_CAP / 2))) {
				const snippet = d.name || "";
				const truncated = snippet.slice(0, 80);
				output.push(`${d.file}:${d.line}  [${d.kind}]  ${truncated}`);
			}

			// Add ref lines
			for (const r of refLines) {
				const snippet = r.snippet || "";
				const truncated = snippet.slice(0, 80);
				output.push(`${r.file}:${r.line}  [ref]  ${truncated}`);
			}

			// Cap at MERGE_CAP
			while (output.length > MERGE_CAP) {
				output.pop();
			}

			if (output.length === 0) {
				output.push("No results found.");
			}

			return {
				content: [{ type: "text", text: output.join("\n") }],
			};
		},

		renderCall(args, theme) {
			const query = args?.query ?? args?.search_query ?? "...";
			const kind = args?.kind;
			return new Text(
				`${theme.fg("toolTitle", theme.bold("search"))} ${theme.fg("accent", String(query))}${kind ? theme.fg("warning", ` [${kind}]`) : ""}`,
				0,
				0,
			);
		},
	});
}
