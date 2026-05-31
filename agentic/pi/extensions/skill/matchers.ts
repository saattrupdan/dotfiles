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
