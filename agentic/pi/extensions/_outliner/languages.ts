/**
 * Language dispatch and tree-sitter language loading for the outliner.
 *
 * Centralises file-extension -> language mapping so that `outliner.ts`
 * can stay focused on the actual entry-extraction logic.
 */

import { createRequire } from "node:module";
import * as path from "node:path";
import Parser from "tree-sitter";
import Python from "tree-sitter-python";
import JavaScript from "tree-sitter-javascript";
import TypeScript from "tree-sitter-typescript";

type ParserConstructor = new () => Parser;

type ParserLanguage = {
	language: unknown;
	ParserCtor?: ParserConstructor;
};

type GrammarModule = Record<string, unknown> & {
	default?: Record<string, unknown>;
};

const require = createRequire(import.meta.url);

function loadTypeScriptParser(): ParserConstructor | undefined {
	try {
		return require("tree-sitter-typescript/node_modules/tree-sitter") as ParserConstructor;
	} catch {
		return undefined;
	}
}

const typeScriptParser = loadTypeScriptParser();

function parserLanguage(language: unknown, ParserCtor?: ParserConstructor): ParserLanguage {
	return { language, ParserCtor };
}

function grammar(mod: unknown, key?: string): unknown {
	const grammarModule = mod as GrammarModule;
	if (key) return grammarModule[key] ?? grammarModule.default?.[key];
	return grammarModule.default ?? mod;
}

function isParserLanguage(language: unknown): language is ParserLanguage {
	return typeof language === "object" && language !== null && "language" in language;
}

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
	| "xml"
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
			return { kind: "python", parserLanguage: parserLanguage(grammar(Python)) };
		case ".ts":
			return { kind: "typescript", parserLanguage: parserLanguage(grammar(TypeScript, "typescript"), typeScriptParser) };
		case ".tsx":
			return { kind: "tsx", parserLanguage: parserLanguage(grammar(TypeScript, "tsx"), typeScriptParser) };
		case ".js":
		case ".jsx":
		case ".mjs":
		case ".cjs":
			return { kind: "javascript", parserLanguage: parserLanguage(grammar(JavaScript)) };
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
		case ".xml":
		case ".rss":
		case ".atom":
		case ".svg":
		case ".xsd":
		case ".xsl":
		case ".xslt":
		case ".plist":
			return { kind: "xml" };
		default:
			return { kind: "fallback" };
	}
}

export function makeParser(language: unknown): Parser {
	const parserLanguage = isParserLanguage(language)
		? language
		: { language } satisfies ParserLanguage;
	const ParserCtor = parserLanguage.ParserCtor ?? Parser;
	const parser = new ParserCtor();
	parser.setLanguage(parserLanguage.language as never);
	return parser;
}
