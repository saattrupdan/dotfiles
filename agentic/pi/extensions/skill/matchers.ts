import * as path from "node:path";

import type { DiscoveredSkill, SkillAutoloadConfig, TargetPath } from "./types.ts";

function toPosix(value: string): string {
	return value.replace(/\\/g, "/");
}

function stripDotSlash(value: string): string {
	return value.replace(/^\.\//, "");
}

function escapeRegex(value: string): string {
	return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function globToRegex(glob: string): RegExp {
	const pattern = stripDotSlash(toPosix(glob));
	let source = "^";
	for (let i = 0; i < pattern.length; i++) {
		const ch = pattern[i];
		const next = pattern[i + 1];

		if (ch === "*" && next === "*") {
			const after = pattern[i + 2];
			if (after === "/") {
				source += "(?:.*/)?";
				i += 2;
			} else {
				source += ".*";
				i += 1;
			}
			continue;
		}
		if (ch === "*") {
			source += "[^/]*";
			continue;
		}
		if (ch === "?") {
			source += "[^/]";
			continue;
		}
		source += escapeRegex(ch);
	}
	return new RegExp(`${source}$`);
}

export function targetPathForToolCall(input: unknown, cwd: string): TargetPath | undefined {
	const raw = (input as { path?: unknown } | null)?.path;
	if (typeof raw !== "string" || raw.trim().length === 0) return undefined;

	const absolute = path.resolve(cwd, raw);
	const relative = toPosix(path.relative(cwd, absolute));
	const repoRelative = relative && !relative.startsWith("../") && relative !== ".." ? stripDotSlash(relative) : undefined;

	return {
		raw,
		absolute,
		repoRelative,
		basename: path.basename(raw),
		posix: stripDotSlash(toPosix(raw)),
	};
}

export function matchesAutoloadRule(config: SkillAutoloadConfig, toolName: string, target: TargetPath): boolean {
	if (!config.tools.includes(toolName)) return false;

	const lowerTarget = target.posix.toLowerCase();
	const lowerRelative = target.repoRelative?.toLowerCase();
	const lowerBasename = target.basename.toLowerCase();

	if (config.extensions.some((ext) => lowerTarget.endsWith(ext.toLowerCase()))) {
		return true;
	}

	if (config.files.some((file) => lowerBasename === path.basename(file).toLowerCase())) {
		return true;
	}

	if (lowerRelative && config.paths.some((glob) => globToRegex(glob.toLowerCase()).test(lowerRelative))) {
		return true;
	}

	return false;
}

export function matchingAutoloadSkills(skills: DiscoveredSkill[], toolName: string, target: TargetPath): DiscoveredSkill[] {
	return skills.filter((skill) => skill.autoload && matchesAutoloadRule(skill.autoload, toolName, target));
}

/**
 * Extract a complete `path` value from streamed/partial tool-call input.
 *
 * Handles:
 * - Full object input: `{ path: "foo.txt", ... }`
 * - Incomplete JSON streaming: `{ "path": "foo` (partial, return undefined)
 * - String input: raw text where we extract quoted path values
 *
 * Returns the path only if it is fully quoted and complete.
 * If path is incomplete or malformed, returns undefined to let fallback handle it.
 */
export function extractPathFromPartialInput(input: unknown): string | undefined {
	// Case 1: input is already a complete object with path
	if (input && typeof input === "object" && !Array.isArray(input)) {
		const raw = (input as { path?: unknown }).path;
		if (typeof raw === "string" && raw.length > 0) {
			return raw;
		}
	}

	// Case 2: input is a string (streaming JSON text or partial)
	// Try to extract a complete quoted "path" value
	if (typeof input === "string") {
		// Try parsing as complete JSON first
		try {
			const parsed = JSON.parse(input) as { path?: unknown };
			if (parsed && typeof parsed === "object" && typeof parsed.path === "string" && parsed.path.length > 0) {
				return parsed.path;
			}
		} catch {
			// Not valid JSON yet, try extracting path from partial stream
		}

		// Extract path from partial/incomplete JSON
		// Match patterns like: "path":"value" or "path": "value" or 'path':'value'
		// We need the value to be fully quoted (closing quote present)
		const pathMatch = /"path"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(input);
		if (pathMatch) {
			// Unescape the JSON string value
			try {
				return JSON.parse(`"${pathMatch[1]}"`) as string;
			} catch {
				return pathMatch[1];
			}
		}
	}

	return undefined;
}
