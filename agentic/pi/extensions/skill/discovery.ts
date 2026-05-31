import * as fs from "node:fs";

import { getAgentDir, loadSkills, type Skill } from "@earendil-works/pi-coding-agent";

import { AUTOLOAD_DEFAULT_TOOLS, type DiscoveredSkill, type SkillAutoloadConfig } from "./types.ts";

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const AUTOLOAD_KEYS = new Set(["tools", "extensions", "files", "paths"]);

function toStringArray(value: unknown): string[] {
	if (Array.isArray(value)) {
		return value.map((v) => String(v).trim()).filter(Boolean);
	}
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (!trimmed) return [];
		if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
			return trimmed
				.slice(1, -1)
				.split(",")
				.map((v) => v.trim().replace(/^['\"]|['\"]$/g, ""))
				.filter(Boolean);
		}
		return [trimmed.replace(/^['\"]|['\"]$/g, "")].filter(Boolean);
	}
	return [];
}

function parseInlineValue(value: string): string[] {
	const trimmed = value.trim();
	if (!trimmed) return [];
	return toStringArray(trimmed);
}

/**
 * Parse only the optional `autoload` frontmatter block from a SKILL.md file.
 * This deliberately stays small and conservative: skill metadata supports the
 * simple YAML shapes we use for autoload arrays without pulling in a YAML dep.
 */
export function parseSkillAutoloadFrontmatter(markdown: string): SkillAutoloadConfig | undefined {
	const match = markdown.match(FRONTMATTER_RE);
	if (!match) return undefined;

	const values: Partial<Record<keyof SkillAutoloadConfig, string[]>> = {};
	let inAutoload = false;
	let currentKey: keyof SkillAutoloadConfig | null = null;

	for (const rawLine of match[1].split(/\r?\n/)) {
		if (!rawLine.trim() || rawLine.trimStart().startsWith("#")) continue;

		const indent = rawLine.match(/^\s*/)?.[0].length ?? 0;
		const line = rawLine.trim();

		if (indent === 0) {
			inAutoload = line === "autoload:";
			currentKey = null;
			continue;
		}

		if (!inAutoload) continue;

		if (indent <= 2 && line.includes(":")) {
			const [rawKey, ...rest] = line.split(":");
			const key = rawKey.trim() as keyof SkillAutoloadConfig;
			if (!AUTOLOAD_KEYS.has(key)) {
				currentKey = null;
				continue;
			}
			currentKey = key;
			const inlineValue = rest.join(":").trim();
			values[key] = inlineValue ? parseInlineValue(inlineValue) : [];
			continue;
		}

		if (currentKey && line.startsWith("- ")) {
			values[currentKey] = [...(values[currentKey] ?? []), ...parseInlineValue(line.slice(2))];
		}
	}

	const extensions = toStringArray(values.extensions);
	const files = toStringArray(values.files);
	const paths = toStringArray(values.paths);
	if (extensions.length === 0 && files.length === 0 && paths.length === 0) {
		return undefined;
	}

	const tools = toStringArray(values.tools);
	return {
		tools: tools.length > 0 ? tools : [...AUTOLOAD_DEFAULT_TOOLS],
		extensions,
		files,
		paths,
	};
}

export function discoverSkills(cwd: string): Skill[] {
	const { skills } = loadSkills({
		cwd,
		agentDir: getAgentDir(),
		skillPaths: [],
		includeDefaults: true,
	});
	return skills;
}

export function readSkillContent(skill: Skill): string {
	return fs.readFileSync(skill.filePath, "utf-8");
}

export function discoverAutoloadSkills(cwd: string): DiscoveredSkill[] {
	return discoverSkills(cwd).flatMap((skill) => {
		try {
			const content = readSkillContent(skill);
			const autoload = parseSkillAutoloadFrontmatter(content);
			return autoload ? [{ ...skill, content, autoload }] : [];
		} catch {
			return [];
		}
	});
}
