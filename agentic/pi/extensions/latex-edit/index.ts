/**
 * Whitespace-tolerant `edit` for LaTeX files.
 *
 * pi's built-in `edit` matches `oldText` exactly, then falls back to a fuzzy
 * match that only normalizes trailing whitespace, smart quotes, Unicode dashes
 * and special spaces (see the package's `normalizeForFuzzyMatch`). It is still
 * rigid about *internal* whitespace and newlines — which is exactly what trips
 * up dense, bracket-heavy LaTeX: the model reproduces `\frac{\partial f}{…}`
 * blocks with slightly different line wrapping or indentation and gets
 *
 *   Could not find edits[0] in report.tex. The oldText must match exactly
 *   including all whitespace and newlines.
 *
 * This extension re-registers the `edit` tool. It delegates everything —
 * execution, diff/patch generation, line-ending handling, the call/result
 * renderers and the footer spinner — to the built-in definition, so behaviour
 * is identical whenever the built-in succeeds. The ONLY addition: when the
 * built-in reports "Could not find" *and the file is LaTeX*, we retry once with
 * a whitespace-flexible match. Every run of whitespace in `oldText` is treated
 * as equivalent to any run of whitespace in the file (`\s+`), so the markup
 * needn't be reproduced byte-for-byte. Leading/trailing whitespace runs are
 * kept in the pattern (not trimmed) so the matched span lines up with the
 * model's `newText` and indentation isn't doubled. The match must still be
 * unique; ambiguous or absent matches fall through to the original error.
 *
 * LaTeX is whitespace-insensitive, so this is safe there. We deliberately do
 * NOT touch other file types, where whitespace can be significant.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	type AgentToolResult,
	createEditToolDefinition,
	type ExtensionAPI,
	type ExtensionContext,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// LaTeX detection
// ---------------------------------------------------------------------------

const LATEX_EXTENSIONS = new Set([
	".tex",
	".sty",
	".cls",
	".bib",
	".ltx",
	".latex",
	".dtx",
	".ins",
	".tikz",
	".pgf",
]);

function isLatexPath(filePath: unknown): boolean {
	return typeof filePath === "string" && LATEX_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

// ---------------------------------------------------------------------------
// Whitespace-flexible matching
// ---------------------------------------------------------------------------

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build a regex source that matches `oldText` with any run of whitespace
 * standing in for any other run of whitespace. Whitespace runs (including
 * leading/trailing ones) become `\s+`; everything else is escaped literally.
 * Returns null if there is no non-whitespace content to anchor on.
 */
function buildFlexiblePattern(oldText: string): string | null {
	const parts = oldText
		.split(/(\s+)/)
		.filter((part) => part.length > 0)
		.map((part) => (/^\s+$/.test(part) ? "\\s+" : escapeRegExp(part)));
	if (!parts.some((part) => part !== "\\s+")) {
		return null;
	}
	return parts.join("");
}

function stripBom(content: string): string {
	return content.startsWith("﻿") ? content.slice(1) : content;
}

function normalizeToLF(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function expandHome(filePath: string): string {
	return filePath.startsWith("~") ? path.join(os.homedir(), filePath.slice(1)) : filePath;
}

type Edit = { oldText: string; newText: string };
type EditInput = { path: string; edits: Edit[] };

/**
 * Try to rewrite each failing `oldText` to the exact text it would match
 * whitespace-flexibly in the current file, so the built-in tool can re-run with
 * an exact match. Returns null when nothing could be repaired (caller then
 * surfaces the original error).
 */
function repairEdits(input: EditInput, cwd: string): { input: EditInput; repaired: number } | null {
	if (!Array.isArray(input.edits)) {
		return null;
	}
	const absolutePath = path.resolve(cwd, expandHome(input.path));
	let normalized: string;
	try {
		normalized = normalizeToLF(stripBom(fs.readFileSync(absolutePath, "utf-8")));
	} catch {
		return null;
	}

	let repaired = 0;
	const edits = input.edits.map((edit): Edit => {
		const oldLF = normalizeToLF(edit.oldText);
		// Already matches exactly — not this edit's fault; leave it untouched.
		if (oldLF.length === 0 || normalized.includes(oldLF)) {
			return edit;
		}
		const pattern = buildFlexiblePattern(oldLF);
		if (!pattern) {
			return edit;
		}
		let regex: RegExp;
		try {
			regex = new RegExp(pattern, "g");
		} catch {
			return edit;
		}
		const matches = [...normalized.matchAll(regex)];
		// Require a single unambiguous match — otherwise we can't safely repair.
		if (matches.length !== 1) {
			return edit;
		}
		repaired += 1;
		return { oldText: matches[0][0], newText: edit.newText };
	});

	return repaired > 0 ? { input: { path: input.path, edits }, repaired } : null;
}

function annotate(result: AgentToolResult, repaired: number): AgentToolResult {
	const note =
		`\n\n(Matched ${repaired} edit${repaired === 1 ? "" : "s"} with a whitespace-flexible fallback: ` +
		`your oldText differed from the file only in whitespace/newlines.)`;
	let done = false;
	const content = result.content.map((block) => {
		if (!done && block.type === "text") {
			done = true;
			return { ...block, text: block.text + note };
		}
		return block;
	});
	return { ...result, content };
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	// One definition for rendering/metadata; the render closures use the live
	// context.cwd internally, so the cwd passed here is immaterial for them.
	const renderBase = createEditToolDefinition(process.cwd());

	// Execution must resolve relative paths against the live session cwd, so we
	// keep a small per-cwd cache of base definitions.
	const baseByCwd = new Map<string, ToolDefinition>();
	const baseFor = (cwd: string): ToolDefinition => {
		let base = baseByCwd.get(cwd);
		if (!base) {
			base = createEditToolDefinition(cwd);
			baseByCwd.set(cwd, base);
		}
		return base;
	};

	pi.registerTool({
		...renderBase,
		description:
			renderBase.description +
			" For LaTeX files (.tex/.sty/.cls/.bib/…), when no exact match is found, oldText is" +
			" retried with a whitespace-flexible match — any run of spaces/newlines matches any other —" +
			" so dense, bracket-heavy markup need not be reproduced byte-for-byte. The match must still be unique.",
		async execute(toolCallId, input, signal, onUpdate, ctx: ExtensionContext) {
			const cwd = ctx?.cwd ?? process.cwd();
			const base = baseFor(cwd);
			try {
				return await base.execute(toolCallId, input, signal, onUpdate, ctx);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (!isLatexPath((input as EditInput).path) || !/Could not find/i.test(message)) {
					throw error;
				}
				const repair = repairEdits(input as EditInput, cwd);
				if (!repair) {
					throw error;
				}
				const result = await base.execute(toolCallId, repair.input, signal, onUpdate, ctx);
				return annotate(result, repair.repaired);
			}
		},
	});
}
