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
	lineEnd: number;
	kind: "class" | "function" | "method" | "heading" | "block";
	name: string;
	parent?: string;
	signature?: string;
	docFirstLine?: string;
};

export type OutlineResult = {
	moduleDoc?: string;
	entries: OutlineEntry[];
};

export type CollapsedViewOpts = {
	maxLines?: number;
	hidePrivate?: boolean;
};

const DOC_CAP = 120;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function outline(filePath: string, source: string): OutlineResult {
	const info = detectLanguage(filePath);
	try {
		switch (info.kind) {
			case "python":
				return {
					moduleDoc: pythonModuleDoc(source, info.parserLanguage),
					entries: runTreeSitter(source, info.parserLanguage, extractPython),
				};
			case "typescript":
			case "tsx":
			case "javascript":
				return {
					moduleDoc: leadingJsDoc(source),
					entries: runTreeSitter(source, info.parserLanguage, extractTsJs),
				};
			case "vue":
				return { entries: outlineVue(source) };
			case "markdown":
				return { entries: outlineMarkdown(source) };
			case "lua":
				return { entries: outlineLua(source), moduleDoc: leadingLineComment(source, "--") };
			case "rust":
				return { entries: outlineRust(source), moduleDoc: leadingLineComment(source, "//!") };
			case "go":
				return { entries: outlineGo(source), moduleDoc: leadingLineComment(source, "//") };
			case "shell":
				return { entries: outlineShell(source), moduleDoc: leadingLineComment(source, "#") };
			case "sql":
				return { entries: outlineSql(source), moduleDoc: leadingLineComment(source, "--") };
			case "css":
				return { entries: outlineCss(source) };
			case "html":
				return { entries: outlineHtml(source) };
			case "json":
				return outlineJson(source);
			case "jsonl":
				return outlineJsonl(source);
			case "csv":
				return outlineCsv(source);
			case "yaml":
				return { entries: outlineYaml(source) };
			case "toml":
				return { entries: outlineToml(source) };
			case "fallback":
			default:
				return { entries: fallbackOutline(source) };
		}
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		return {
			moduleDoc: `outline parse failed (${info.kind}): ${reason}`,
			entries: fallbackOutline(source),
		};
	}
}

export function collapsedView(result: OutlineResult, opts: CollapsedViewOpts = {}): string[] {
	const entries = result.entries;
	const maxLines = opts.maxLines ?? 200;
	const hidePrivate = opts.hidePrivate ?? true;
	const filtered = hidePrivate ? entries.filter((e) => !e.name.startsWith("_")) : entries.slice();
	filtered.sort((a, b) => a.line - b.line);

	const collapsed = new Set<number>();
	const renderable = () => renderEntries(filtered, collapsed, result.moduleDoc);

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

function renderEntries(
	entries: OutlineEntry[],
	collapsedClassIdx: Set<number>,
	moduleDoc: string | undefined,
): string[] {
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

	const out: string[] = [];
	if (moduleDoc) {
		// moduleDoc can be richer than a one-line function docstring (e.g.
		// JSONL schema summaries), so use a higher cap than per-symbol docs.
		out.push(`  ${" ".repeat(lineWidth)}  """${truncate(moduleDoc, 300)}"""`);
	}
	for (const { entry, index } of visible) {
		const lineStr = String(entry.line).padStart(lineWidth, " ");
		let indent = entry.kind === "method" ? "  " : "";
		let prefix = kindPrefix(entry.kind);
		if (entry.kind === "heading" && entry.signature && /^#+$/.test(entry.signature)) {
			const level = entry.signature.length;
			indent = "  ".repeat(Math.max(0, level - 1));
			prefix = `${entry.signature} `;
		}
		const sig = (entry.kind === "function" || entry.kind === "method")
			? (entry.signature ?? "()")
			: entry.kind === "block" || entry.kind === "class" || (entry.kind === "heading" && entry.signature && !/^#+$/.test(entry.signature))
				? (entry.signature ?? "")
				: "";
		const nameCell = `${indent}${prefix}${entry.name}${sig}`;
		const docPart = entry.docFirstLine ? `  — ${entry.docFirstLine}` : "";
		let row = `  ${lineStr}  ${nameCell}${docPart}`;

		if (entry.kind === "class" && collapsedClassIdx.has(index)) {
			const n = entries.filter((m) => m.kind === "method" && m.parent === entry.name).length;
			row = `${row}  (${n} methods — read symbol="${entry.name}" to expand)`;
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
	// tree-sitter's default bufferSize (~32 KB) rejects larger sources with
	// "Invalid argument" — size it to the input.
	const bufferSize = Math.max(32 * 1024, source.length + 1024);
	const tree = parser.parse(source, undefined, { bufferSize });
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
				if (def) handlePyDef(def, parent, out, lineOffset, visit, child);
				continue;
			}
			if (child.type === "class_definition" || child.type === "function_definition") {
				handlePyDef(child, parent, out, lineOffset, visit, child);
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
	container: Parser.SyntaxNode,
): void {
	const nameNode = node.childForFieldName("name");
	const name = nameNode?.text ?? "<anon>";
	const line = container.startPosition.row + 1 + lineOffset;
	const lineEnd = container.endPosition.row + 1 + lineOffset;
	const doc = pythonDocstring(node);
	if (node.type === "class_definition") {
		out.push({ line, lineEnd, kind: "class", name, docFirstLine: doc });
		const body = node.childForFieldName("body");
		if (body) visit(body, name);
	} else {
		const params = flattenSignature(node.childForFieldName("parameters")?.text ?? "()");
		const ret = node.childForFieldName("return_type")?.text;
		const signature = ret ? `${params} -> ${flattenSignature(ret)}` : params;
		out.push({
			line,
			lineEnd,
			kind: parent ? "method" : "function",
			name,
			parent,
			signature,
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

function pythonModuleDoc(source: string, language: unknown): string | undefined {
	if (!language) return undefined;
	try {
		const parser = makeParser(language);
		const bufferSize = Math.max(32 * 1024, source.length + 1024);
		const tree = parser.parse(source, undefined, { bufferSize });
		const root = tree.rootNode;
		const first = root.namedChild(0);
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
	} catch {
		return undefined;
	}
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
					lineEnd: target.endPosition.row + 1 + lineOffset,
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
				const params = flattenSignature(target.childForFieldName("parameters")?.text ?? "()");
				const ret = target.childForFieldName("return_type")?.text;
				const signature = ret ? `${params}${flattenSignature(ret)}` : params;
				out.push({
					line: target.startPosition.row + 1 + lineOffset,
					lineEnd: target.endPosition.row + 1 + lineOffset,
					kind: "function",
					name,
					signature,
					docFirstLine: jsdocBefore(child, lines),
				});
				continue;
			}

			if (target.type === "method_definition") {
				const name = target.childForFieldName("name")?.text ?? "<anon>";
				const params = flattenSignature(target.childForFieldName("parameters")?.text ?? "()");
				const ret = target.childForFieldName("return_type")?.text;
				const signature = ret ? `${params}${flattenSignature(ret)}` : params;
				out.push({
					line: target.startPosition.row + 1 + lineOffset,
					lineEnd: target.endPosition.row + 1 + lineOffset,
					kind: "method",
					name,
					parent,
					signature,
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

function leadingJsDoc(source: string): string | undefined {
	const lines = source.split("\n");
	let i = 0;
	while (i < lines.length && lines[i]!.trim() === "") i++;
	if (i >= lines.length) return undefined;
	if (!lines[i]!.trim().startsWith("/**")) return undefined;
	let j = i;
	while (j < lines.length && !lines[j]!.trim().endsWith("*/")) j++;
	if (j >= lines.length) return undefined;
	for (let k = i; k <= j; k++) {
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
	const stack: { idx: number; level: number }[] = [];
	let inFence = false;

	const closeTo = (level: number, endLine: number) => {
		while (stack.length && stack[stack.length - 1]!.level >= level) {
			const top = stack.pop()!;
			out[top.idx]!.lineEnd = endLine;
		}
	};

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
		const level = m[1]!.length;
		const name = truncate(m[2]!.trim(), DOC_CAP);
		// Sections at the same or deeper level end on the line before this heading.
		closeTo(level, i);
		const parentIdx = stack.length ? stack[stack.length - 1]!.idx : -1;
		const parent = parentIdx >= 0 ? out[parentIdx]!.name : undefined;
		const idx = out.length;
		out.push({
			line: i + 1,
			lineEnd: lines.length,
			kind: "heading",
			name,
			parent,
			// `signature` carries the leading `#`s so the index DB round-trips level
			// info and the renderer can show nesting.
			signature: m[1]!,
		});
		stack.push({ idx, level });
	}
	closeTo(0, lines.length);
	return out;
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

function truncate(s: string, cap: number): string {
	if (s.length <= cap) return s;
	return `${s.slice(0, cap - 1)}…`;
}

const SIG_CAP = 120;

function flattenSignature(s: string): string {
	const flat = s.replace(/\s+/g, " ").replace(/\(\s+/g, "(").replace(/\s+\)/g, ")").trim();
	return truncate(flat, SIG_CAP);
}

// ---------------------------------------------------------------------------
// Shared helpers for regex-based grammars
// ---------------------------------------------------------------------------

function leadingLineComment(source: string, marker: string): string | undefined {
	const lines = source.split("\n");
	let i = 0;
	while (i < lines.length && lines[i]!.trim() === "") i++;
	if (i >= lines.length) return undefined;
	if (lines[i]!.startsWith("#!")) i++; // shebang
	while (i < lines.length && lines[i]!.trim() === "") i++;
	if (i >= lines.length) return undefined;
	const first = lines[i]!.trim();
	if (!first.startsWith(marker)) return undefined;
	const cleaned = first.slice(marker.length).trim();
	return cleaned ? truncate(cleaned, DOC_CAP) : undefined;
}

// Walks back from `idx` over contiguous comment lines and returns the first
// non-empty line of that comment block.
function lineCommentAbove(lines: string[], idx: number, marker: string): string | undefined {
	let i = idx - 1;
	while (i >= 0 && lines[i]!.trim() === "") i--;
	if (i < 0 || !lines[i]!.trim().startsWith(marker)) return undefined;
	let j = i;
	while (j - 1 >= 0 && lines[j - 1]!.trim().startsWith(marker)) j--;
	const first = lines[j]!.trim().slice(marker.length).trim();
	return first ? truncate(first, DOC_CAP) : undefined;
}

// Scan from `startIdx` forward, balancing `{`/`}` while tracking string
// state, and return the 1-indexed line number where the first `{`'s
// matching `}` lives. If no `{` is found, returns the start line. Works
// for Rust, Go, Shell-with-braces, CSS, and SQL block bodies.
function findBlockEnd(lines: string[], startIdx: number): number {
	let depth = 0;
	let started = false;
	let inStr = false;
	let quote = "";
	let esc = false;
	let inLineComment = false;
	let inBlockComment = false;
	for (let i = startIdx; i < lines.length; i++) {
		const line = lines[i]!;
		inLineComment = false;
		for (let c = 0; c < line.length; c++) {
			const ch = line[c]!;
			const next = line[c + 1];
			if (inLineComment) break;
			if (inBlockComment) {
				if (ch === "*" && next === "/") { inBlockComment = false; c++; }
				continue;
			}
			if (inStr) {
				if (esc) { esc = false; }
				else if (ch === "\\") { esc = true; }
				else if (ch === quote) { inStr = false; }
				continue;
			}
			if (ch === "/" && next === "/") { inLineComment = true; break; }
			if (ch === "/" && next === "*") { inBlockComment = true; c++; continue; }
			if (ch === '"' || ch === "'" || ch === "`") { inStr = true; quote = ch; continue; }
			if (ch === "{") { depth++; started = true; }
			else if (ch === "}") {
				depth--;
				if (started && depth === 0) return i + 1;
			}
		}
	}
	return started ? lines.length : startIdx + 1;
}

// ---------------------------------------------------------------------------
// Lua
// ---------------------------------------------------------------------------

const LUA_FN_RE = /^\s*(?:local\s+)?function\s+([A-Za-z_][\w]*(?:[.:][A-Za-z_][\w]*)*)\s*(\([^)]*\))/;
const LUA_ASSIGN_FN_RE = /^\s*(?:local\s+)?([A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*)\s*=\s*function\s*(\([^)]*\))/;

function outlineLua(source: string): OutlineEntry[] {
	const out: OutlineEntry[] = [];
	const lines = source.split("\n");
	let depth = 0; // approximate keyword-block depth for finding `end`
	const openStack: number[] = []; // entry indices awaiting their `end`

	const openersRe = /\b(function|if|for|while|do|repeat)\b/g;
	const closersRe = /\b(end)\b/g;

	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i]!;
		const line = raw.replace(/--.*$/, ""); // strip line comment
		let m = LUA_FN_RE.exec(raw);
		let nameRaw: string | undefined;
		let sig: string | undefined;
		if (m) {
			nameRaw = m[1]!;
			sig = m[2] ?? "()";
		} else {
			m = LUA_ASSIGN_FN_RE.exec(raw);
			if (m) {
				nameRaw = m[1]!;
				sig = m[2] ?? "()";
			}
		}
		if (nameRaw) {
			const sepIdx = nameRaw.search(/[.:]/);
			const isMethod = sepIdx >= 0;
			const parent = isMethod ? nameRaw.slice(0, sepIdx) : undefined;
			const name = isMethod ? nameRaw.slice(sepIdx + 1) : nameRaw;
			out.push({
				line: i + 1,
				lineEnd: lines.length,
				kind: isMethod ? "method" : "function",
				name,
				parent,
				signature: flattenSignature(sig!),
				docFirstLine: lineCommentAbove(lines, i, "--"),
			});
			openStack.push(out.length - 1);
			depth++;
		} else {
			const opens = (line.match(openersRe) ?? []).length;
			depth += opens;
		}
		const closes = (line.match(closersRe) ?? []).length;
		for (let c = 0; c < closes; c++) {
			depth--;
			if (openStack.length && depth < openStack.length) {
				const idx = openStack.pop()!;
				out[idx]!.lineEnd = i + 1;
			}
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// Rust
// ---------------------------------------------------------------------------

const RUST_FN_RE = /^\s*(?:pub(?:\([^)]+\))?\s+)?(?:async\s+|const\s+|unsafe\s+|extern\s+(?:"[^"]+"\s+)?)*fn\s+([A-Za-z_][\w]*)\s*(?:<[^>]*>)?\s*(\([^)]*\))/;
const RUST_STRUCT_RE = /^\s*(?:pub(?:\([^)]+\))?\s+)?struct\s+([A-Za-z_][\w]*)/;
const RUST_ENUM_RE = /^\s*(?:pub(?:\([^)]+\))?\s+)?enum\s+([A-Za-z_][\w]*)/;
const RUST_TRAIT_RE = /^\s*(?:pub(?:\([^)]+\))?\s+)?(?:unsafe\s+)?trait\s+([A-Za-z_][\w]*)/;
const RUST_MOD_RE = /^\s*(?:pub(?:\([^)]+\))?\s+)?mod\s+([A-Za-z_][\w]*)\s*\{/;
const RUST_IMPL_RE = /^\s*impl(?:<[^>]*>)?\s+(?:([\w:]+(?:<[^>]*>)?)\s+for\s+)?([\w:]+(?:<[^>]*>)?)/;

function outlineRust(source: string): OutlineEntry[] {
	const out: OutlineEntry[] = [];
	const lines = source.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		if (line.startsWith(" ") || line.startsWith("\t")) continue; // top-level only
		let m: RegExpExecArray | null;
		if ((m = RUST_FN_RE.exec(line))) {
			out.push({
				line: i + 1,
				lineEnd: findBlockEnd(lines, i),
				kind: "function",
				name: m[1]!,
				signature: flattenSignature(m[2]!),
				docFirstLine: lineCommentAbove(lines, i, "///") ?? lineCommentAbove(lines, i, "//"),
			});
		} else if ((m = RUST_STRUCT_RE.exec(line))) {
			out.push({ line: i + 1, lineEnd: findBlockEnd(lines, i), kind: "class", name: m[1]!, signature: "(struct)", docFirstLine: lineCommentAbove(lines, i, "///") });
		} else if ((m = RUST_ENUM_RE.exec(line))) {
			out.push({ line: i + 1, lineEnd: findBlockEnd(lines, i), kind: "class", name: m[1]!, signature: "(enum)", docFirstLine: lineCommentAbove(lines, i, "///") });
		} else if ((m = RUST_TRAIT_RE.exec(line))) {
			out.push({ line: i + 1, lineEnd: findBlockEnd(lines, i), kind: "class", name: m[1]!, signature: "(trait)", docFirstLine: lineCommentAbove(lines, i, "///") });
		} else if ((m = RUST_MOD_RE.exec(line))) {
			out.push({ line: i + 1, lineEnd: findBlockEnd(lines, i), kind: "class", name: m[1]!, signature: "(mod)", docFirstLine: lineCommentAbove(lines, i, "///") });
		} else if ((m = RUST_IMPL_RE.exec(line))) {
			const trait = m[1];
			const target = m[2]!;
			const name = trait ? `${trait} for ${target}` : target;
			out.push({ line: i + 1, lineEnd: findBlockEnd(lines, i), kind: "class", name, signature: "(impl)" });
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// Go
// ---------------------------------------------------------------------------

const GO_FN_RE = /^func\s+(?:\(([^)]+)\)\s+)?([A-Za-z_][\w]*)\s*(\([^)]*\))/;
const GO_TYPE_RE = /^type\s+([A-Za-z_][\w]*)\s+(struct|interface)\b/;

function outlineGo(source: string): OutlineEntry[] {
	const out: OutlineEntry[] = [];
	const lines = source.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		let m: RegExpExecArray | null;
		if ((m = GO_FN_RE.exec(line))) {
			const recv = m[1];
			const name = m[2]!;
			const params = m[3]!;
			let parent: string | undefined;
			if (recv) {
				// "r *Receiver" or "Receiver" → take last token, strip `*`.
				const recvType = recv.trim().split(/\s+/).pop() ?? "";
				parent = recvType.replace(/^\*/, "");
			}
			out.push({
				line: i + 1,
				lineEnd: findBlockEnd(lines, i),
				kind: parent ? "method" : "function",
				name,
				parent,
				signature: flattenSignature(params),
				docFirstLine: lineCommentAbove(lines, i, "//"),
			});
		} else if ((m = GO_TYPE_RE.exec(line))) {
			out.push({
				line: i + 1,
				lineEnd: findBlockEnd(lines, i),
				kind: "class",
				name: m[1]!,
				signature: `(${m[2]})`,
				docFirstLine: lineCommentAbove(lines, i, "//"),
			});
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// Shell (bash / zsh)
// ---------------------------------------------------------------------------

// `name() {` or `function name {` or `function name() {`
const SHELL_FN_RE = /^\s*(?:function\s+([A-Za-z_][\w-]*)\s*(?:\(\))?|([A-Za-z_][\w-]*)\s*\(\))\s*\{?/;

function outlineShell(source: string): OutlineEntry[] {
	const out: OutlineEntry[] = [];
	const lines = source.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		const m = SHELL_FN_RE.exec(line);
		if (!m) continue;
		const name = m[1] ?? m[2];
		if (!name) continue;
		// guard against false matches like `if (...)`
		if (["if", "for", "while", "case", "function"].includes(name)) continue;
		out.push({
			line: i + 1,
			lineEnd: findBlockEnd(lines, i),
			kind: "function",
			name,
			signature: "()",
			docFirstLine: lineCommentAbove(lines, i, "#"),
		});
	}
	return out;
}

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

const SQL_CREATE_RE = /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:TEMP(?:ORARY)?\s+)?(?:MATERIALIZED\s+VIEW|TABLE|VIEW|INDEX|UNIQUE\s+INDEX|FUNCTION|PROCEDURE|TYPE|TRIGGER|SCHEMA|SEQUENCE|EXTENSION)\s+(?:IF\s+NOT\s+EXISTS\s+)?([\w.]+|"[^"]+"|`[^`]+`)/i;

function outlineSql(source: string): OutlineEntry[] {
	const out: OutlineEntry[] = [];
	const lines = source.split("\n");
	const starts: { i: number; name: string; sub: string }[] = [];
	for (let i = 0; i < lines.length; i++) {
		const m = SQL_CREATE_RE.exec(lines[i]!);
		if (!m) continue;
		const sub = (m[0].match(/CREATE\s+(?:OR\s+REPLACE\s+)?(?:TEMP(?:ORARY)?\s+)?([\w\s]+?)\s+(?:IF|[\w."`])/i)?.[1] ?? "object").trim().toLowerCase();
		starts.push({ i, name: m[1]!.replace(/^["`]|["`]$/g, ""), sub });
	}
	for (let s = 0; s < starts.length; s++) {
		const { i, name, sub } = starts[s]!;
		const nextStart = s + 1 < starts.length ? starts[s + 1]!.i : lines.length;
		// find `;` between i and nextStart for a tighter end
		let end = nextStart;
		for (let k = i; k < nextStart; k++) {
			if (/;\s*(--.*)?$/.test(lines[k]!)) { end = k + 1; break; }
		}
		out.push({
			line: i + 1,
			lineEnd: end,
			kind: sub.includes("function") || sub.includes("procedure") ? "function" : "class",
			name,
			signature: `(${sub})`,
			docFirstLine: lineCommentAbove(lines, i, "--"),
		});
	}
	return out;
}

// ---------------------------------------------------------------------------
// CSS / SCSS / LESS
// ---------------------------------------------------------------------------

function outlineCss(source: string): OutlineEntry[] {
	const out: OutlineEntry[] = [];
	// Strip /* ... */ block comments while preserving newlines so line counts stay correct.
	const cleaned = source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
	let i = 0;
	let line = 1;
	let depth = 0;
	let selStart = -1;
	let selStartLine = -1;
	const stack: number[] = [];

	while (i < cleaned.length) {
		const ch = cleaned[i]!;
		if (ch === "{") {
			if (depth === 0 && selStart >= 0) {
				const sel = cleaned.slice(selStart, i).replace(/\s+/g, " ").trim();
				if (sel) {
					out.push({
						line: selStartLine,
						lineEnd: line,
						kind: "block",
						name: truncate(sel, 100),
					});
					stack.push(out.length - 1);
				}
				selStart = -1;
				selStartLine = -1;
			}
			depth++;
		} else if (ch === "}") {
			depth--;
			if (depth === 0 && stack.length) {
				const idx = stack.pop()!;
				out[idx]!.lineEnd = line;
			}
		} else if (depth === 0) {
			if (ch === ";") {
				// top-level statement (e.g. `@charset "...";`) — discard pending selector.
				selStart = -1;
				selStartLine = -1;
			} else if (/\S/.test(ch) && selStart < 0) {
				selStart = i;
				selStartLine = line;
			}
		}
		if (ch === "\n") line++;
		i++;
	}
	return out;
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

function outlineHtml(source: string): OutlineEntry[] {
	const out: OutlineEntry[] = [];
	const lines = source.split("\n");
	// Track current line for offset computation as we walk regex matches.
	const lineStarts: number[] = [0];
	for (let i = 0; i < source.length; i++) {
		if (source[i] === "\n") lineStarts.push(i + 1);
	}
	const offsetToLine = (off: number): number => {
		// binary search
		let lo = 0, hi = lineStarts.length - 1;
		while (lo < hi) {
			const mid = (lo + hi + 1) >> 1;
			if (lineStarts[mid]! <= off) lo = mid; else hi = mid - 1;
		}
		return lo + 1;
	};

	const headingRe = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi;
	let m: RegExpExecArray | null;
	while ((m = headingRe.exec(source))) {
		const level = Number(m[1]);
		const text = m[2]!.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
		const startLine = offsetToLine(m.index);
		const endLine = offsetToLine(m.index + m[0].length - 1);
		out.push({
			line: startLine,
			lineEnd: endLine,
			kind: "heading",
			name: truncate(text || `h${level}`, DOC_CAP),
			signature: "#".repeat(level),
		});
	}

	// Elements with id attribute — useful anchors in large HTML files.
	const idRe = /<([A-Za-z][\w-]*)\b[^>]*\sid\s*=\s*["']([^"']+)["'][^>]*>/g;
	while ((m = idRe.exec(source))) {
		const tag = m[1]!;
		const id = m[2]!;
		const startLine = offsetToLine(m.index);
		out.push({
			line: startLine,
			lineEnd: startLine,
			kind: "block",
			name: `#${id}`,
			signature: `(<${tag}>)`,
		});
	}
	out.sort((a, b) => a.line - b.line);
	return out;
}

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------

type JsonShape = {
	kind: "object" | "array" | "string" | "number" | "boolean" | "null";
	size?: number;
	preview?: string;
};

function describeJsonValue(v: unknown): JsonShape {
	if (v === null) return { kind: "null" };
	if (Array.isArray(v)) return { kind: "array", size: v.length };
	if (typeof v === "object") return { kind: "object", size: Object.keys(v as object).length };
	if (typeof v === "string") return { kind: "string", preview: truncate(v, 60) };
	if (typeof v === "number") return { kind: "number", preview: String(v) };
	if (typeof v === "boolean") return { kind: "boolean", preview: String(v) };
	return { kind: "null" };
}

function jsonShapeLabel(s: JsonShape): string {
	switch (s.kind) {
		case "object": return `object (${s.size} keys)`;
		case "array": return `array (${s.size} items)`;
		case "string": return `"${s.preview}"`;
		case "number":
		case "boolean": return s.preview!;
		case "null": return "null";
	}
}

// Locate top-level keys of the root JSON object with their line numbers.
function jsonTopLevelKeyPositions(source: string): { key: string; line: number }[] {
	const out: { key: string; line: number }[] = [];
	const len = source.length;
	let i = 0;
	let line = 1;

	const advanceWs = () => {
		while (i < len) {
			const c = source[i]!;
			if (c === " " || c === "\t" || c === "\r") { i++; continue; }
			if (c === "\n") { line++; i++; continue; }
			// JSONC-style comments — be lenient.
			if (c === "/" && source[i + 1] === "/") { while (i < len && source[i] !== "\n") i++; continue; }
			if (c === "/" && source[i + 1] === "*") {
				i += 2;
				while (i < len && !(source[i] === "*" && source[i + 1] === "/")) {
					if (source[i] === "\n") line++;
					i++;
				}
				i += 2;
				continue;
			}
			break;
		}
	};

	advanceWs();
	if (source[i] !== "{") return out;
	i++;

	while (i < len) {
		advanceWs();
		if (i >= len || source[i] === "}") break;
		if (source[i] === ",") { i++; continue; }
		if (source[i] !== '"') { i++; continue; }
		const keyStartLine = line;
		let j = i + 1;
		while (j < len) {
			const c = source[j]!;
			if (c === "\\") { j += 2; continue; }
			if (c === '"') break;
			if (c === "\n") line++;
			j++;
		}
		const key = source.slice(i + 1, j);
		i = j + 1;
		advanceWs();
		if (source[i] !== ":") continue;
		i++;
		// Skip the value, balancing braces/brackets and respecting strings.
		let depth = 0;
		let inStr = false;
		let esc = false;
		while (i < len) {
			const c = source[i]!;
			if (inStr) {
				if (esc) esc = false;
				else if (c === "\\") esc = true;
				else if (c === '"') inStr = false;
				if (c === "\n") line++;
				i++;
				continue;
			}
			if (c === '"') { inStr = true; i++; continue; }
			if (c === "{" || c === "[") { depth++; i++; continue; }
			if (c === "}" || c === "]") {
				if (depth === 0) break;
				depth--;
				i++;
				continue;
			}
			if (c === "," && depth === 0) { i++; break; }
			if (c === "\n") line++;
			i++;
		}
		out.push({ key, line: keyStartLine });
	}
	return out;
}

function outlineJson(source: string): OutlineResult {
	let parsed: unknown;
	try { parsed = JSON.parse(source); } catch {
		return { entries: fallbackOutline(source), moduleDoc: "JSON parse failed; falling back to heuristic outline." };
	}
	const shape = describeJsonValue(parsed);
	const lines = source.split("\n");

	if (shape.kind !== "object" || !parsed || typeof parsed !== "object") {
		return { entries: [], moduleDoc: `top-level ${jsonShapeLabel(shape)}` };
	}

	const positions = jsonTopLevelKeyPositions(source);
	const totalLines = lines.length;
	const obj = parsed as Record<string, unknown>;
	const entries: OutlineEntry[] = positions.map((p, idx) => {
		const nextLine = idx + 1 < positions.length ? positions[idx + 1]!.line - 1 : totalLines;
		const childShape = describeJsonValue(obj[p.key]);
		return {
			line: p.line,
			lineEnd: nextLine,
			kind: "block",
			name: p.key,
			signature: `: ${jsonShapeLabel(childShape)}`,
		};
	});
	return { entries, moduleDoc: `object (${entries.length} top-level keys)` };
}

// ---------------------------------------------------------------------------
// JSONL / NDJSON
// ---------------------------------------------------------------------------

function outlineJsonl(source: string): OutlineResult {
	const lines = source.split("\n");
	const recordIdx: number[] = [];
	for (let i = 0; i < lines.length; i++) {
		if (lines[i]!.trim()) recordIdx.push(i);
	}
	const count = recordIdx.length;
	if (count === 0) return { entries: [], moduleDoc: "empty file" };

	const SAMPLE = 50;
	const keyTypes = new Map<string, Set<string>>();
	let firstKeys: string[] | undefined;
	let firstRecord: Record<string, unknown> | undefined;
	let parseErrors = 0;
	const sampled = Math.min(SAMPLE, count);

	for (let i = 0; i < sampled; i++) {
		const line = lines[recordIdx[i]!]!;
		try {
			const v = JSON.parse(line);
			if (i === 0 && v && typeof v === "object" && !Array.isArray(v)) {
				firstRecord = v as Record<string, unknown>;
				firstKeys = Object.keys(firstRecord);
			}
			if (v && typeof v === "object" && !Array.isArray(v)) {
				for (const [k, val] of Object.entries(v)) {
					if (!keyTypes.has(k)) keyTypes.set(k, new Set());
					keyTypes.get(k)!.add(describeJsonValue(val).kind);
				}
			}
		} catch {
			parseErrors++;
		}
	}

	const schemaPairs: string[] = [];
	if (firstKeys) {
		// Preserve first-record key order, then append any extras.
		const seen = new Set<string>();
		const order = [...firstKeys, ...[...keyTypes.keys()].filter((k) => !firstKeys!.includes(k))];
		for (const k of order) {
			if (seen.has(k)) continue;
			seen.add(k);
			const types = keyTypes.get(k);
			if (!types) continue;
			schemaPairs.push(`${k}: ${[...types].join("|")}`);
		}
	}

	const parts: string[] = [`${count} records (sampled ${sampled})`];
	if (schemaPairs.length) {
		const shown = schemaPairs.slice(0, 12);
		const more = schemaPairs.length > 12 ? `, … (+${schemaPairs.length - 12} more)` : "";
		parts.push(`schema: ${shown.join(", ")}${more}`);
	}
	if (parseErrors) parts.push(`${parseErrors} parse error(s) in first ${sampled} records`);

	const entries: OutlineEntry[] = [];
	const firstLine = recordIdx[0]! + 1;
	const lastLine = recordIdx[count - 1]! + 1;
	entries.push({
		line: firstLine,
		lineEnd: firstLine,
		kind: "block",
		name: "head",
		signature: "(first record)",
	});
	if (count >= 2) {
		const sampleN = Math.min(5, count);
		const sampleEnd = recordIdx[sampleN - 1]! + 1;
		entries.push({
			line: firstLine,
			lineEnd: sampleEnd,
			kind: "block",
			name: "sample",
			signature: `(first ${sampleN} records)`,
		});
		entries.push({
			line: lastLine,
			lineEnd: lastLine,
			kind: "block",
			name: "tail",
			signature: "(last record)",
		});
	}
	return { entries, moduleDoc: parts.join(" — ") };
}

// ---------------------------------------------------------------------------
// CSV / TSV
// ---------------------------------------------------------------------------

function csvSplit(line: string, sep: string): string[] {
	const out: string[] = [];
	let cur = "";
	let inQuotes = false;
	for (let i = 0; i < line.length; i++) {
		const c = line[i]!;
		if (inQuotes) {
			if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
			else if (c === '"') inQuotes = false;
			else cur += c;
		} else {
			if (c === '"' && cur === "") inQuotes = true;
			else if (c === sep) { out.push(cur); cur = ""; }
			else cur += c;
		}
	}
	out.push(cur);
	return out;
}

function outlineCsv(source: string): OutlineResult {
	const lines = source.split("\n");
	if (lines.length === 0 || (lines.length === 1 && !lines[0])) {
		return { entries: [], moduleDoc: "empty file" };
	}
	// Detect separator from the first non-empty line.
	let headerLine = "";
	let headerIdx = 0;
	while (headerIdx < lines.length && lines[headerIdx]!.trim() === "") headerIdx++;
	headerLine = lines[headerIdx] ?? "";
	const tabCount = (headerLine.match(/\t/g) ?? []).length;
	const commaCount = (headerLine.match(/,/g) ?? []).length;
	const sep = tabCount > commaCount ? "\t" : ",";
	const cols = csvSplit(headerLine, sep);
	let rows = 0;
	for (let i = headerIdx + 1; i < lines.length; i++) {
		if (lines[i]!.trim() !== "") rows++;
	}
	const entries: OutlineEntry[] = cols.map((c, idx) => ({
		line: headerIdx + 1,
		lineEnd: headerIdx + 1,
		kind: "block",
		name: c.trim() || `col${idx + 1}`,
		signature: `(col ${idx + 1})`,
	}));
	return {
		entries,
		moduleDoc: `${rows} rows × ${cols.length} cols (separator: ${sep === "\t" ? "tab" : "comma"})`,
	};
}

// ---------------------------------------------------------------------------
// YAML
// ---------------------------------------------------------------------------

const YAML_TOP_KEY_RE = /^([\w][\w.-]*)\s*:(?:\s|$)/;

function outlineYaml(source: string): OutlineEntry[] {
	const out: OutlineEntry[] = [];
	const lines = source.split("\n");
	let lastIdx = -1;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		if (line.startsWith("#") || line.trim() === "" || line.startsWith("---") || line.startsWith("...")) continue;
		if (line.startsWith(" ") || line.startsWith("\t") || line.startsWith("-")) continue;
		const m = YAML_TOP_KEY_RE.exec(line);
		if (!m) continue;
		const restOfLine = line.slice(m[0].length).trim();
		const valuePreview = restOfLine && !restOfLine.startsWith("#")
			? truncate(restOfLine, 60)
			: "";
		if (lastIdx >= 0) out[lastIdx]!.lineEnd = i;
		out.push({
			line: i + 1,
			lineEnd: lines.length,
			kind: "block",
			name: m[1]!,
			signature: valuePreview ? `: ${valuePreview}` : ":",
		});
		lastIdx = out.length - 1;
	}
	return out;
}

// ---------------------------------------------------------------------------
// TOML
// ---------------------------------------------------------------------------

const TOML_TABLE_RE = /^\s*\[([^\]]+)\]\s*$/;
const TOML_ARRAY_TABLE_RE = /^\s*\[\[([^\]]+)\]\]\s*$/;

function outlineToml(source: string): OutlineEntry[] {
	const out: OutlineEntry[] = [];
	const lines = source.split("\n");
	let lastIdx = -1;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		let m = TOML_ARRAY_TABLE_RE.exec(line);
		let isArray = false;
		if (m) { isArray = true; } else { m = TOML_TABLE_RE.exec(line); }
		if (!m) continue;
		const name = m[1]!.trim();
		if (lastIdx >= 0) out[lastIdx]!.lineEnd = i;
		out.push({
			line: i + 1,
			lineEnd: lines.length,
			kind: "heading",
			name,
			signature: isArray ? "[[...]]" : "[...]",
		});
		lastIdx = out.length - 1;
	}
	return out;
}
