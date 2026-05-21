/**
 * Agent discovery and configuration.
 *
 * Mirrors the upstream pi `subagent` example, with one addition:
 * a `worktree: true|false` boolean in the frontmatter. When true,
 * the subagent is spawned in a fresh git worktree on a new branch
 * and the branch is merged back into the parent worktree on exit.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export type AgentScope = "user" | "project" | "both";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	worktree: boolean;
	skills: string[];
	systemPrompt: string;
	source: "user" | "project";
	filePath: string;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
}

function parseBool(v: unknown): boolean {
	if (typeof v === "boolean") return v;
	if (typeof v === "string") {
		const s = v.trim().toLowerCase();
		return s === "true" || s === "yes" || s === "1";
	}
	return false;
}

function loadAgentsFromDir(dir: string, source: "user" | "project"): AgentConfig[] {
	const agents: AgentConfig[] = [];

	if (!fs.existsSync(dir)) return agents;

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return agents;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(content);

		if (!frontmatter.name || !frontmatter.description) continue;

		const toolsRaw = frontmatter.tools;
		const tools =
			typeof toolsRaw === "string"
				? toolsRaw
						.split(",")
						.map((t) => t.trim())
						.filter(Boolean)
				: undefined;

		// Parse skills as a YAML list (array), not comma-split.
		const skillsRaw = frontmatter.skills;
		let skills: string[] = [];
		if (Array.isArray(skillsRaw)) {
			skills = skillsRaw.map((s: unknown) => String(s));
		} else if (typeof skillsRaw === "string") {
			skills = skillsRaw
				.split(",")
				.map((t: string) => t.trim())
				.filter(Boolean);
		}

		agents.push({
			name: String(frontmatter.name),
			description: String(frontmatter.description),
			tools: tools && tools.length > 0 ? tools : undefined,
			model: frontmatter.model ? String(frontmatter.model) : undefined,
			worktree: parseBool(frontmatter.worktree),
			skills,
			systemPrompt: body,
			source,
			filePath,
		});
	}

	return agents;
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function findNearestProjectAgentsDir(cwd: string): string | null {
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(currentDir, ".pi", "agents");
		if (isDirectory(candidate)) return candidate;
		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {
	const userDir = path.join(getAgentDir(), "agents");
	const projectAgentsDir = findNearestProjectAgentsDir(cwd);

	const userAgents = scope === "project" ? [] : loadAgentsFromDir(userDir, "user");
	const projectAgents = scope === "user" || !projectAgentsDir ? [] : loadAgentsFromDir(projectAgentsDir, "project");

	const agentMap = new Map<string, AgentConfig>();

	if (scope === "both") {
		for (const a of userAgents) agentMap.set(a.name, a);
		for (const a of projectAgents) agentMap.set(a.name, a);
	} else if (scope === "user") {
		for (const a of userAgents) agentMap.set(a.name, a);
	} else {
		for (const a of projectAgents) agentMap.set(a.name, a);
	}

	// Project-level overlay: merge project agent skills into user-level agents.
	if (projectAgentsDir && (scope === "both" || scope === "user")) {
		for (const userAgent of userAgents) {
			const projectAgentPath = path.join(projectAgentsDir, `${userAgent.name}.md`);
			if (!fs.existsSync(projectAgentPath)) continue;
			try {
				const content = fs.readFileSync(projectAgentPath, "utf-8");
				const { frontmatter } = parseFrontmatter<Record<string, unknown>>(content);
				const skillsRaw = frontmatter.skills;
				if (!skillsRaw) continue;
				const projectSkills: string[] = Array.isArray(skillsRaw)
					? skillsRaw.map((s: unknown) => String(s))
					: typeof skillsRaw === "string"
						? skillsRaw.split(",").map((t: string) => t.trim()).filter(Boolean)
						: [];
				const merged = new Set([...userAgents.find((a) => a.name === userAgent.name)!.skills, ...projectSkills]);
				const entry = agentMap.get(userAgent.name);
				if (entry) {
					agentMap.set(userAgent.name, { ...entry, skills: Array.from(merged) });
				}
			} catch {
				// Ignore parse errors for project-level overlays.
			}
		}
	}

	return { agents: Array.from(agentMap.values()), projectAgentsDir };
}
