/**
 * Language dispatch and tree-sitter language loading for the outliner.
 *
 * Centralises file-extension -> language mapping so that `outliner.ts`
 * can stay focused on the actual entry-extraction logic.
 */

import * as path from "node:path";
// @ts-ignore - tree-sitter ships without bundled types
import Parser from "tree-sitter";
// @ts-ignore
import Python from "tree-sitter-python";
// @ts-ignore
import JavaScript from "tree-sitter-javascript";
// @ts-ignore
import TypeScript from "tree-sitter-typescript";

export type LanguageKind = "python" | "typescript" | "javascript" | "tsx" | "markdown" | "vue" | "fallback";

export type LanguageInfo = {
	kind: LanguageKind;
	parserLanguage?: unknown;
};

export function detectLanguage(filePath: string): LanguageInfo {
	const ext = path.extname(filePath).toLowerCase();
	switch (ext) {
		case ".py":
			return { kind: "python", parserLanguage: Python };
		case ".ts":
			return { kind: "typescript", parserLanguage: TypeScript.typescript };
		case ".tsx":
			return { kind: "tsx", parserLanguage: TypeScript.tsx };
		case ".js":
		case ".jsx":
		case ".mjs":
		case ".cjs":
			return { kind: "javascript", parserLanguage: JavaScript };
		case ".vue":
			return { kind: "vue" };
		case ".md":
		case ".markdown":
			return { kind: "markdown" };
		default:
			return { kind: "fallback" };
	}
}

export function makeParser(language: unknown): Parser {
	const parser = new Parser();
	parser.setLanguage(language as never);
	return parser;
}
