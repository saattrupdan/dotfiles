/**
 * A more forgiving `edit` tool.
 *
 * pi's built-in `edit` matches `oldText` exactly, then fuzzy-matches only
 * smart quotes, Unicode dashes and *trailing* whitespace (see the package's
 * `normalizeForFuzzyMatch`). It stays rigid about *internal* whitespace and
 * newlines, so a model that reproduces a block with slightly different line
 * wrapping, indentation, or tabs-vs-spaces gets:
 *
 *   Could not find the exact text in <file>. The old text must match exactly
 *   including all whitespace and newlines.
 *
 * This is especially painful for dense, bracket-heavy markup (LaTeX, nested
 * JSX/HTML, deeply-indented config) but it bites every language eventually.
 *
 * This extension re-registers `edit`, delegating execution, diff/patch
 * generation, line-ending handling, the call/result renderers and the footer
 * spinner to the built-in definition — behaviour is identical whenever the
 * built-in would have matched. The addition: on *every* edit we first resolve
 * each `oldText` against the live file with a tolerant matcher that treats
 *
 *   - any run of whitespace as equivalent to any other run (spaces, tabs,
 *     newlines, indentation, NBSP & friends),
 *   - straight and smart quotes as interchangeable, and
 *   - ASCII hyphen and the Unicode dash family as interchangeable,
 *
 * and rewrite `oldText` to the file's *exact* text for that span before handing
 * off. Leading/trailing whitespace stays in the match so the span lines up with
 * `newText` and indentation isn't doubled.
 *
 * This only ever loosens matching when the exact match fails: a unique exact
 * match is used as-is (never second-guessed, so no new ambiguity), genuine
 * duplicates still error, and a tolerant match must itself be unique or we
 * leave `oldText` untouched and let the built-in run its own exact+fuzzy pass
 * (which also covers NFKC normalization). It is therefore strictly more
 * forgiving than the built-in, with no regression when the built-in already
 * works.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	type AgentToolResult,
	createEditToolDefinition,
	type EditToolDetails,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { collapseAutoloadResult } from "../skill/types.ts";

// The exact shape `createEditToolDefinition` returns (concrete params/details/
// state). Typing every base reference as this keeps `pi.registerTool` inference
// precise — widening to the default `ToolDefinition<TSchema, unknown, any>`
// makes the overridden `execute`/`renderResult` signatures stop lining up.
type EditToolDef = ReturnType<typeof createEditToolDefinition>;
type EditResult = AgentToolResult<EditToolDetails | undefined>;

// ---------------------------------------------------------------------------
// Tolerant matching
// ---------------------------------------------------------------------------

// Character families treated as interchangeable, mirroring the built-in's
// normalizeForFuzzyMatch. Special spaces (NBSP, en-quad, …) are covered by the
// `\s` class, so they fold into whitespace runs automatically.
const SINGLE_QUOTES = "'‘’‚‛";
const DOUBLE_QUOTES = '"“”„‟';
const DASHES = "-‐‑‒–—―−";

const SINGLE_QUOTE_CLASS = `[${SINGLE_QUOTES}]`;
const DOUBLE_QUOTE_CLASS = `["“”„‟]`;
const DASH_CLASS = `[\\-‐‑‒–—―−]`;

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build a regex source matching `oldText` with whitespace runs collapsed to
 * `\s+` and quote/dash characters widened to their families. Leading/trailing
 * whitespace runs are kept (not trimmed) so a match's span aligns with
 * `newText`. Returns null when there is no non-whitespace content to anchor on.
 */
function buildTolerantPattern(oldText: string): string | null {
	const parts: string[] = [];
	let hasAnchor = false;
	for (let i = 0; i < oldText.length; ) {
		const ch = oldText[i];
		if (/\s/.test(ch)) {
			let j = i + 1;
			while (j < oldText.length && /\s/.test(oldText[j])) j += 1;
			parts.push("\\s+");
			i = j;
			continue;
		}
		hasAnchor = true;
		if (SINGLE_QUOTES.includes(ch)) parts.push(SINGLE_QUOTE_CLASS);
		else if (DOUBLE_QUOTES.includes(ch)) parts.push(DOUBLE_QUOTE_CLASS);
		else if (DASHES.includes(ch)) parts.push(DASH_CLASS);
		else parts.push(escapeRegExp(ch));
		i += 1;
	}
	return hasAnchor ? parts.join("") : null;
}

function stripBom(content: string): string {
	return content.startsWith("﻿") ? content.slice(1) : content;
}

function normalizeToLF(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function countExact(haystack: string, needle: string): number {
	if (!needle) return 0;
	let count = 0;
	let idx = haystack.indexOf(needle);
	while (idx !== -1) {
		count += 1;
		idx = haystack.indexOf(needle, idx + needle.length);
	}
	return count;
}

function expandHome(filePath: string): string {
	return filePath.startsWith("~") ? path.join(os.homedir(), filePath.slice(1)) : filePath;
}

type Edit = { oldText: string; newText: string };
type EditInput = { path: string; edits: Edit[] };

/**
 * Rewrite each `oldText` that has no exact match to the file's exact text for
 * its unique tolerant match, so the built-in can match exactly. Edits that
 * match exactly (uniquely or as duplicates) and edits with no unique tolerant
 * match are left untouched for the built-in to handle (or error on) as usual.
 */
function robustifyEdits(input: EditInput, cwd: string): { input: EditInput; rewritten: number } {
	if (!Array.isArray(input.edits) || typeof input.path !== "string") {
		return { input, rewritten: 0 };
	}
	const absolutePath = path.resolve(cwd, expandHome(input.path));
	let normalized: string;
	try {
		normalized = normalizeToLF(stripBom(fs.readFileSync(absolutePath, "utf-8")));
	} catch {
		return { input, rewritten: 0 };
	}

	let rewritten = 0;
	const edits = input.edits.map((edit): Edit => {
		if (typeof edit?.oldText !== "string" || typeof edit?.newText !== "string") {
			return edit;
		}
		const oldLF = normalizeToLF(edit.oldText);
		// Exact match (unique or duplicate) → leave for the built-in untouched.
		if (oldLF.length === 0 || countExact(normalized, oldLF) >= 1) {
			return edit;
		}
		const pattern = buildTolerantPattern(oldLF);
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
		// Require a single unambiguous tolerant match; otherwise defer to the
		// built-in (which still runs its own exact + fuzzy pass).
		if (matches.length !== 1) {
			return edit;
		}
		rewritten += 1;
		return { oldText: matches[0][0], newText: edit.newText };
	});

	return rewritten > 0 ? { input: { path: input.path, edits }, rewritten } : { input, rewritten: 0 };
}

function annotate(result: EditResult, rewritten: number): EditResult {
	const note =
		`\n\n(Resolved ${rewritten} edit${rewritten === 1 ? "" : "s"} with tolerant matching: ` +
		`oldText differed from the file only in whitespace, quotes, or dashes.)`;
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
	// One definition for rendering/metadata; its render closures use the live
	// context.cwd internally, so the cwd passed here is immaterial for them.
	const renderBase: EditToolDef = createEditToolDefinition(process.cwd());

	// Execution must resolve relative paths against the live session cwd, so we
	// keep a small per-cwd cache of base definitions.
	const baseByCwd = new Map<string, EditToolDef>();
	const baseFor = (cwd: string): EditToolDef => {
		let base = baseByCwd.get(cwd);
		if (!base) {
			base = createEditToolDefinition(cwd);
			baseByCwd.set(cwd, base);
		}
		return base;
	};

	const tool: EditToolDef = {
		...renderBase,
		description:
			renderBase.description +
			" oldText is matched tolerantly: differences in whitespace/newlines/indentation, straight-vs-smart" +
			" quotes, and hyphen-vs-Unicode-dashes are ignored, so dense or reflowed text need not be reproduced" +
			" byte-for-byte. A unique exact match always wins; a tolerant match must itself be unique.",
		async execute(toolCallId, input, signal, onUpdate, ctx: ExtensionContext) {
			const cwd = ctx?.cwd ?? process.cwd();
			const base = baseFor(cwd);
			const { input: resolved, rewritten } = robustifyEdits(input, cwd);
			const result = await base.execute(toolCallId, resolved, signal, onUpdate, ctx);
			return rewritten > 0 ? annotate(result, rewritten) : result;
		},
	};

	// Wrap the built-in result renderer to collapse a skill-autoload injection to
	// its one-line summary, exactly as the `read` extension and the skill `write`
	// override do. Since this extension owns the `edit` tool, the skill extension
	// no longer overrides `edit` (that would collide), so the collapse lives here.
	const baseRenderResult = renderBase.renderResult;
	if (baseRenderResult) {
		tool.renderResult = (result, options, theme, context) =>
			baseRenderResult(collapseAutoloadResult(result, options.expanded, context.isError), options, theme, context);
	}

	pi.registerTool(tool);
}
