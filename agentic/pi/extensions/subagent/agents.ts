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

export interface RefuseRule {
	pattern: string;
	message: string;
	flags?: string;
}

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string[];
	worktree: boolean;
	/**
	 * Allow-list of skill names. Semantics:
	 *  - undefined  → no `skills:` field in frontmatter; child sees all
	 *                discovered skills (backwards compatible).
	 *  - string[]   → explicit allow-list (may be empty for "no skills").
	 */
	skills?: string[];
	/**
	 * Optional list of regex patterns the agent will refuse to act on. When a
	 * task matches, the subagent is not spawned; instead the configured
	 * `message` is returned to the caller as the agent's error. Useful for
	 * cheaply enforcing "don't ask me to X" contracts without relying on the
	 * child model to obey instructions in its system prompt.
	 */
	refuse?: RefuseRule[];
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

function parseModelList(raw: unknown, filePath: string): string[] | undefined {
	if (raw === undefined || raw === null) return undefined;
	if (typeof raw === "string") {
		const model = raw.trim();
		return model ? [model] : undefined;
	}
	if (!Array.isArray(raw)) {
		console.error(
			`subagent: invalid \`model:\` in ${filePath} — must be a string or YAML list; ignoring.`,
		);
		return undefined;
	}

	const models: string[] = [];
	for (const entry of raw) {
		if (typeof entry !== "string") {
			console.error(`subagent: invalid model entry in ${filePath} — must be a string; skipping.`);
			continue;
		}
		const model = entry.trim();
		if (!model) {
			console.error(`subagent: empty model entry in ${filePath}; skipping.`);
			continue;
		}
		models.push(model);
	}
	return models.length > 0 ? models : undefined;
}

function parseRefuseRules(raw: unknown, filePath: string): RefuseRule[] | undefined {
	if (raw === undefined || raw === null) return undefined;
	if (!Array.isArray(raw)) {
		console.error(`subagent: invalid \`refuse:\` in ${filePath} — must be a YAML list; ignoring.`);
		return undefined;
	}
	const rules: RefuseRule[] = [];
	for (const entry of raw) {
		if (!entry || typeof entry !== "object") {
			console.error(`subagent: invalid refuse entry in ${filePath} — must be a mapping; skipping.`);
			continue;
		}
		const obj = entry as Record<string, unknown>;
		const pattern = typeof obj.pattern === "string" ? obj.pattern : undefined;
		const message = typeof obj.message === "string" ? obj.message : undefined;
		const flags = typeof obj.flags === "string" ? obj.flags : undefined;
		if (!pattern || !message) {
			console.error(`subagent: refuse entry in ${filePath} needs both \`pattern\` and \`message\`; skipping.`);
			continue;
		}
		try {
			// Validate the regex up front so bad configs are caught at load time.
			new RegExp(pattern, flags ?? "i");
		} catch (err) {
			console.error(`subagent: refuse pattern in ${filePath} is not a valid regex (${(err as Error).message}); skipping.`);
			continue;
		}
		rules.push({ pattern, message, flags });
	}
	return rules.length > 0 ? rules : undefined;
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
		// `skills` omitted → undefined (= "all skills", backwards compatible).
		// `skills: []`     → empty allow-list (= "no skills").
		const skillsRaw = frontmatter.skills;
		let skills: string[] | undefined;
		if (Array.isArray(skillsRaw)) {
			skills = skillsRaw.map((s: unknown) => String(s));
		} else if (typeof skillsRaw === "string") {
			skills = skillsRaw
				.split(",")
				.map((t: string) => t.trim())
				.filter(Boolean);
		} else if (skillsRaw !== undefined) {
			skills = [];
		}

		const models = parseModelList(frontmatter.model, filePath);
		const refuse = parseRefuseRules(frontmatter.refuse, filePath);

		agents.push({
			name: String(frontmatter.name),
			description: String(frontmatter.description),
			tools: tools && tools.length > 0 ? tools : undefined,
			model: models,
			worktree: parseBool(frontmatter.worktree),
			skills,
			refuse,
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
