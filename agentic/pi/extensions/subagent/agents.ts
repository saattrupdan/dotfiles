/**
 * Agent discovery and configuration.
 *
 * Agent profiles are shared by the top-level launcher and this extension.
 * Only profiles marked subagent: true are delegatable.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { parseAgentProfile, type AgentProfile } from "../../profile/definition.mjs";

export type AgentScope = "user" | "project" | "both";

export type AgentConfig = AgentProfile;

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
}

export function delegatableAgents(agents: AgentConfig[]): AgentConfig[] {
	return agents.filter((agent) => agent.subagent);
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
		agents.push(parseAgentProfile(frontmatter, body, filePath, source));
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

export function findNearestProjectAgentsDir(cwd: string): string | null {
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

	const allUserAgents = loadAgentsFromDir(userDir, "user");
	const userAgents = scope === "project" ? [] : allUserAgents;
	const projectAgents = scope === "user" || !projectAgentsDir ? [] : loadAgentsFromDir(projectAgentsDir, "project");

	// Project definitions must not expose private user profiles through delegation.
	const privateNames = new Set(allUserAgents.filter((a) => !a.subagent).map((a) => a.name));
	const agentMap = new Map<string, AgentConfig>();

	if (scope === "both") {
		for (const a of userAgents) agentMap.set(a.name, a);
		for (const a of projectAgents) if (!privateNames.has(a.name)) agentMap.set(a.name, a);
	} else if (scope === "user") {
		for (const a of userAgents) agentMap.set(a.name, a);
	} else {
		for (const a of projectAgents) if (!privateNames.has(a.name)) agentMap.set(a.name, a);
	}

	// Project-level overlay: merge project agent skills into user-level agents.
	if (projectAgentsDir && (scope === "both" || scope === "user")) {
		for (const userAgent of userAgents) {
			const projectAgentPath = path.join(projectAgentsDir, `${userAgent.name}.md`);
			if (!fs.existsSync(projectAgentPath)) continue;
			const existing = userAgents.find((a) => a.name === userAgent.name);
			if (!existing) {
				continue;
			}
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
				const merged = new Set([...(existing.skills ?? []), ...projectSkills]);
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
