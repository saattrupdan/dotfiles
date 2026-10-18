export interface AgentProfile {
	name: string;
	description: string;
	subagent: boolean;
	tools?: string[];
	model?: string[];
	worktree: boolean;
	skills?: string[];
	extensions?: string[];
	refuse?: { pattern: string; message: string; flags?: string }[];
	systemPrompt: string;
	source: "user" | "project";
	filePath: string;
}

export function parseAgentProfile(
	frontmatter: Record<string, unknown>,
	body: string,
	filePath: string,
	source?: "user" | "project",
): AgentProfile;
