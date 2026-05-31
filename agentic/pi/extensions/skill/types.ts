import type { Skill } from "@earendil-works/pi-coding-agent";

export const AUTOLOAD_DEFAULT_TOOLS = ["read", "write", "edit"] as const;
export const AUTOLOAD_TOOL_NAMES = new Set<string>(AUTOLOAD_DEFAULT_TOOLS);

export type AutoloadTool = (typeof AUTOLOAD_DEFAULT_TOOLS)[number];

export interface SkillAutoloadConfig {
	tools: string[];
	extensions: string[];
	files: string[];
	paths: string[];
}

export interface DiscoveredSkill extends Skill {
	autoload?: SkillAutoloadConfig;
}

export interface TargetPath {
	raw: string;
	absolute: string;
	repoRelative?: string;
	basename: string;
	posix: string;
}
