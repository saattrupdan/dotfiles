/**
 * Tree-sitter based source outliner shared by the `read` and `search`
 * pi extensions.
 *
 * The public API is `outline()` for extracting entries from a single
 * source file, and `collapsedView()` for rendering them as a compact
 * indented listing that fits within a caller-specified line budget.
 *
 * This module does not register any pi tools - it is a pure library
 * imported via a relative path from sibling extensions.
 */

// @ts-ignore - tree-sitter ships without bundled types
import type Parser from "tree-sitter";
import { detectLanguage, makeParser } from "./languages.ts";
import { fallbackOutline } from "./fallback.ts";

export type OutlineEntry = {
	line: number;
	kind: "class" | "function" | "method" | "heading" | "block";
	name: string;
	parent?: string;
	docFirstLine?: string;
};

export type CollapsedViewOpts = {
	maxLines?: number;
	hidePrivate?: boolean;
};

const DOC_CAP = 80;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function outline(filePath: string, source: string): OutlineEntry[] {
	try {
		const info = detectLanguage(filePath);
		switch (info.kind) {
			case "python":
				return runTreeSitter(source, info.parserLanguage, extractPython);
			case "typescript":
			case "tsx":
			case "javascript":
				return runTreeSitter(source, info.parserLanguage, extractTsJs);
			case "vue":
				return outlineVue(source);
			case "markdown":
				return outlineMarkdown(source);
			case "fallback":
			default:
				return fallbackOutline(source);
		}
	} catch {
		return fallbackOutline(source);
	}
}

export function collapsedView(entries: OutlineEntry[], opts: CollapsedViewOpts = {}): string[] {
	const maxLines = opts.maxLines ?? 100;
	const hidePrivate = opts.hidePrivate ?? true;
	const filtered = hidePrivate ? entries.filter((e) => !e.name.startsWith("_")) : entries.slice();
	filtered.sort((a, b) => a.line - b.line);

	const collapsed = new Set<number>();
	const renderable = () => renderEntries(filtered, collapsed);

	let rendered = renderable();
	if (rendered.length <= maxLines) return rendered;

	const classIndices = filtered
		.map((e, i) => ({ e, i }))
		.filter((x) => x.e.kind === "class");
	const methodCounts = classIndices.map(({ e, i }) => ({
		i,
		name: e.name,
		methods: filtered.filter((m) => m.kind === "method" && m.parent === e.name).length,
	}));
	methodCounts.sort((a, b) => b.methods - a.methods);

	for (const { i, methods } of methodCounts) {
		if (methods === 0) continue;
		collapsed.add(i);
		rendered = renderable();
		if (rendered.length <= maxLines) break;
	}

	return rendered;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderEntries(entries: OutlineEntry[], collapsedClassIdx: Set<number>): string[] {
	const collapsedClassNames = new Set<string>();
	for (const idx of collapsedClassIdx) {
		const e = entries[idx];
		if (e) collapsedClassNames.add(e.name);
	}

	const visible: { entry: OutlineEntry; index: number }[] = [];
	for (let i = 0; i < entries.length; i++) {
		const e = entries[i]!;
		if (e.kind === "method" && e.parent && collapsedClassNames.has(e.parent)) continue;
		visible.push({ entry: e, index: i });
	}

	const maxLineNum = visible.reduce((m, v) => Math.max(m, v.entry.line), 1);
	const lineWidth = String(maxLineNum).length;
	const nameColWidth = 40;

	const out: string[] = [];
	for (const { entry, index } of visible) {
		const lineStr = String(entry.line).padStart(lineWidth, " ");
		const methodIndent = entry.kind === "method" ? "  " : "";
		const prefix = kindPrefix(entry.kind);
		const sig = entry.kind === "function" || entry.kind === "method" ? "()" : "";
		const nameCell = `${methodIndent}${prefix}${entry.name}${sig}`;
		const padded = nameCell.length >= nameColWidth ? `${nameCell}  ` : nameCell.padEnd(nameColWidth, " ");
		const docPart = entry.docFirstLine ? entry.docFirstLine : "";
		let row = `  ${lineStr}  ${padded}${docPart}`.replace(/\s+$/, "");

		if (entry.kind === "class" && collapsedClassIdx.has(index)) {
			const n = entries.filter((m) => m.kind === "method" && m.parent === entry.name).length;
			row = `${row}  (${n} methods \u2014 read offset=${entry.line} to expand)`;
		}
		out.push(row);
	}
	return out;
}

function kindPrefix(kind: OutlineEntry["kind"]): string {
	switch (kind) {
		case "class":
			return "class ";
		case "function":
		case "method":
			return "def ";
		case "heading":
			return "# ";
		case "block":
			return "";
	}
}

// ---------------------------------------------------------------------------
// Tree-sitter driver
// ---------------------------------------------------------------------------

type Extractor = (rootNode: Parser.SyntaxNode, source: string, lineOffset: number) => OutlineEntry[];

function runTreeSitter(source: string, language: unknown, extract: Extractor, lineOffset = 0): OutlineEntry[] {
	if (!language) return fallbackOutline(source);
	const parser = makeParser(language);
	const tree = parser.parse(source);
	const entries = extract(tree.rootNode, source, lineOffset);
	entries.sort((a, b) => a.line - b.line);
	return entries;
}

// ---------------------------------------------------------------------------
// Python
// ---------------------------------------------------------------------------

function extractPython(root: Parser.SyntaxNode, _source: string, lineOffset: number): OutlineEntry[] {
	const out: OutlineEntry[] = [];

	const visit = (node: Parser.SyntaxNode, parent: string | undefined): void => {
		for (let i = 0; i < node.namedChildCount; i++) {
			const child = node.namedChild(i)!;
			if (child.type === "decorated_definition") {
				const def = child.childForFieldName("definition") ?? child.namedChildren.find((c: Parser.SyntaxNode) => c.type === "class_definition" || c.type === "function_definition");
				if (def) handlePyDef(def, parent, out, lineOffset, visit);
				continue;
			}
			if (child.type === "class_definition" || child.type === "function_definition") {
				handlePyDef(child, parent, out, lineOffset, visit);
				continue;
			}
			visit(child, parent);
		}
	};

	visit(root, undefined);
	return out;
}

function handlePyDef(
	node: Parser.SyntaxNode,
	parent: string | undefined,
	out: OutlineEntry[],
	lineOffset: number,
	visit: (n: Parser.SyntaxNode, p: string | undefined) => void,
): void {
	const nameNode = node.childForFieldName("name");
	const name = nameNode?.text ?? "<anon>";
	const line = node.startPosition.row + 1 + lineOffset;
	const doc = pythonDocstring(node);
	if (node.type === "class_definition") {
		out.push({ line, kind: "class", name, docFirstLine: doc });
		const body = node.childForFieldName("body");
		if (body) visit(body, name);
	} else {
		out.push({
			line,
			kind: parent ? "method" : "function",
			name,
			parent,
			docFirstLine: doc,
		});
	}
}

function pythonDocstring(defNode: Parser.SyntaxNode): string | undefined {
	const body = defNode.childForFieldName("body");
	if (!body) return undefined;
	const first = body.namedChild(0);
	if (!first) return undefined;
	let strNode: Parser.SyntaxNode | null = null;
	if (first.type === "expression_statement") {
		strNode = first.namedChild(0);
	} else if (first.type === "string") {
		strNode = first;
	}
	if (!strNode || strNode.type !== "string") return undefined;
	const raw = strNode.text;
	const inner = raw.replace(/^[rubRUB]*("""|'''|"|')/, "").replace(/("""|'''|"|')$/, "");
	const firstLine = inner.split("\n").map((l) => l.trim()).find((l) => l.length > 0);
	if (!firstLine) return undefined;
	return truncate(firstLine, DOC_CAP);
}

// ---------------------------------------------------------------------------
// TypeScript / JavaScript
// ---------------------------------------------------------------------------

function extractTsJs(root: Parser.SyntaxNode, source: string, lineOffset: number): OutlineEntry[] {
	const out: OutlineEntry[] = [];
	const lines = source.split("\n");

	const visit = (node: Parser.SyntaxNode, parent: string | undefined): void => {
		for (let i = 0; i < node.namedChildCount; i++) {
			const child = node.namedChild(i)!;
			let target: Parser.SyntaxNode = child;
			if (child.type === "export_statement") {
				const decl = findNamed(child, ["class_declaration", "function_declaration", "abstract_class_declaration"]);
				if (decl) target = decl;
			}

			if (target.type === "class_declaration" || target.type === "abstract_class_declaration") {
				const name = target.childForFieldName("name")?.text ?? "<anon>";
				out.push({
					line: target.startPosition.row + 1 + lineOffset,
					kind: "class",
					name,
					docFirstLine: jsdocBefore(child, lines),
				});
				const body = target.childForFieldName("body");
				if (body) visit(body, name);
				continue;
			}

			if (target.type === "function_declaration") {
				const name = target.childForFieldName("name")?.text ?? "<anon>";
				out.push({
					line: target.startPosition.row + 1 + lineOffset,
					kind: "function",
					name,
					docFirstLine: jsdocBefore(child, lines),
				});
				continue;
			}

			if (target.type === "method_definition") {
				const name = target.childForFieldName("name")?.text ?? "<anon>";
				out.push({
					line: target.startPosition.row + 1 + lineOffset,
					kind: "method",
					name,
					parent,
					docFirstLine: jsdocBefore(target, lines),
				});
				continue;
			}

			visit(target, parent);
		}
	};

	visit(root, undefined);
	return out;
}

function findNamed(node: Parser.SyntaxNode, types: string[]): Parser.SyntaxNode | null {
	for (let i = 0; i < node.namedChildCount; i++) {
		const c = node.namedChild(i)!;
		if (types.includes(c.type)) return c;
	}
	return null;
}

function jsdocBefore(node: Parser.SyntaxNode, lines: string[]): string | undefined {
	let i = node.startPosition.row - 1;
	while (i >= 0 && lines[i]!.trim() === "") i--;
	if (i < 0) return undefined;
	if (!lines[i]!.trim().endsWith("*/")) return undefined;
	let j = i;
	while (j >= 0 && !lines[j]!.trim().startsWith("/**")) j--;
	if (j < 0) return undefined;
	for (let k = j; k <= i; k++) {
		const cleaned = lines[k]!
			.replace(/^\s*\/\*+/, "")
			.replace(/\*+\/\s*$/, "")
			.replace(/^\s*\*\s?/, "")
			.trim();
		if (cleaned.length > 0) return truncate(cleaned, DOC_CAP);
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// Vue
// ---------------------------------------------------------------------------

const VUE_SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;

function outlineVue(source: string): OutlineEntry[] {
	const entries: OutlineEntry[] = [];
	const matches = source.matchAll(VUE_SCRIPT_RE);
	for (const m of matches) {
		const attrs = m[1] ?? "";
		const body = m[2] ?? "";
		const openIdx = m.index ?? 0;
		const tagEnd = source.indexOf(">", openIdx);
		if (tagEnd < 0) continue;
		const contentStart = tagEnd + 1;
		const linesBefore = source.slice(0, contentStart).split("\n").length - 1;
		const isTs = /\blang\s*=\s*["']ts["']/.test(attrs) || /\blang\s*=\s*["']typescript["']/.test(attrs);
		const info = detectLanguage(isTs ? "x.ts" : "x.js");
		if (!info.parserLanguage) continue;
		try {
			const sub = runTreeSitter(body, info.parserLanguage, extractTsJs, linesBefore);
			entries.push(...sub);
		} catch {
			// ignore broken script block; other blocks may still parse
		}
	}
	entries.sort((a, b) => a.line - b.line);
	return entries;
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

function outlineMarkdown(source: string): OutlineEntry[] {
	const out: OutlineEntry[] = [];
	const lines = source.split("\n");
	let inFence = false;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		const trimmed = line.trimStart();
		if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
			inFence = !inFence;
			continue;
		}
		if (inFence) continue;
		const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
		if (!m) continue;
		const name = truncate(m[2]!.trim(), DOC_CAP);
		out.push({ line: i + 1, kind: "heading", name });
	}
	return out;
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

function truncate(s: string, cap: number): string {
	if (s.length <= cap) return s;
	return `${s.slice(0, cap - 1)}\u2026`;
}
