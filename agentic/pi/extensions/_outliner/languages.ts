/**
 * Language dispatch and tree-sitter language loading for the outliner.
 *
 * Centralises file-extension -> language mapping so that `outliner.ts`
 * can stay focused on the actual entry-extraction logic.
 */

import * as path from "node:path";
import Parser from "tree-sitter";
import Python from "tree-sitter-python";
import JavaScript from "tree-sitter-javascript";
import TypeScript from "tree-sitter-typescript";

export type LanguageKind =
	| "python"
	| "typescript"
	| "javascript"
	| "tsx"
	| "markdown"
	| "latex"
	| "vue"
	| "lua"
	| "rust"
	| "go"
	| "shell"
	| "sql"
	| "css"
	| "html"
	| "json"
	| "jsonl"
	| "csv"
	| "yaml"
	| "toml"
	| "fallback";

export type LanguageInfo = {
	kind: LanguageKind;
	parserLanguage?: unknown;
};

const SHELL_BASENAMES = new Set([
	".zshrc",
	".bashrc",
	".bash_profile",
	".profile",
	".zprofile",
	".zshenv",
	".bash_aliases",
	".kshrc",
]);

export function detectLanguage(filePath: string): LanguageInfo {
	const base = path.basename(filePath).toLowerCase();
	if (SHELL_BASENAMES.has(base)) return { kind: "shell" };
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
		case ".tex":
		case ".latex":
		case ".ltx":
		case ".sty":
		case ".cls":
			return { kind: "latex" };
		case ".lua":
			return { kind: "lua" };
		case ".rs":
			return { kind: "rust" };
		case ".go":
			return { kind: "go" };
		case ".sh":
		case ".bash":
		case ".zsh":
		case ".ksh":
			return { kind: "shell" };
		case ".sql":
			return { kind: "sql" };
		case ".css":
		case ".scss":
		case ".sass":
		case ".less":
			return { kind: "css" };
		case ".html":
		case ".htm":
			return { kind: "html" };
		case ".json":
			return { kind: "json" };
		case ".jsonl":
		case ".ndjson":
			return { kind: "jsonl" };
		case ".csv":
		case ".tsv":
			return { kind: "csv" };
		case ".yaml":
		case ".yml":
			return { kind: "yaml" };
		case ".toml":
			return { kind: "toml" };
		default:
			return { kind: "fallback" };
	}
}

export function makeParser(language: unknown): Parser {
	const parser = new Parser();
	parser.setLanguage(language as never);
	return parser;
}
