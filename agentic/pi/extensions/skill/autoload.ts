import type { ExtensionAPI, ExtensionContext, Skill } from "@earendil-works/pi-coding-agent";

import { discoverAutoloadSkills } from "./discovery.ts";
import { matchingAutoloadSkills, targetPathForToolCall } from "./matchers.ts";
import { AUTOLOAD_TOOL_NAMES, type DiscoveredSkill } from "./types.ts";

const loaded = new Set<string>();
let currentSessionId: string | undefined;

function sessionId(ctx: ExtensionContext): string {
	return ctx.sessionManager?.getSessionId() ?? "runtime";
}

function skillKey(session: string, skill: Pick<Skill, "name" | "filePath">): string {
	return `${session}\0${skill.name}\0${skill.filePath}`;
}

function syncSession(ctx: ExtensionContext): string {
	const id = sessionId(ctx);
	if (currentSessionId && currentSessionId !== id) {
		loaded.clear();
	}
	currentSessionId = id;
	return id;
}

export function alreadyLoadedForSession(ctx: ExtensionContext, skill: Pick<Skill, "name" | "filePath">): boolean {
	return loaded.has(skillKey(syncSession(ctx), skill));
}

export function markSkillLoadedForSession(ctx: ExtensionContext, skill: Pick<Skill, "name" | "filePath">): void {
	loaded.add(skillKey(syncSession(ctx), skill));
}

function formatSkillCall(name: string): string {
	return `\`skill\` with ${JSON.stringify({ name })}`;
}

function formatAutoloadRequest(skills: DiscoveredSkill[], toolName: string, rawPath: string): string {
	const skillNames = skills.map((skill) => `\`${skill.name}\``).join(", ");
	const calls = skills.map((skill) => `- Call ${formatSkillCall(skill.name)}`).join("\n");

	return (
		`Relevant skill${skills.length === 1 ? "" : "s"} matched this ${toolName} call for \`${rawPath}\`: ${skillNames}.\n\n` +
		"The original tool call has been blocked so the matching skill guidance can be loaded explicitly first. " +
		"Call the `skill` tool as listed below, then retry the original tool call with the same arguments. " +
		"This autoload block intentionally does not include full skill content; the explicit `skill` tool result remains the source of model-visible guidance.\n\n" +
		calls
	);
}

export function registerAutoload(pi: ExtensionAPI): void {
	pi.on("session_start", async () => {
		loaded.clear();
		currentSessionId = undefined;
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!AUTOLOAD_TOOL_NAMES.has(event.toolName)) return undefined;

		const target = targetPathForToolCall(event.input, ctx.cwd);
		if (!target) return undefined;

		let matches: DiscoveredSkill[];
		try {
			matches = matchingAutoloadSkills(discoverAutoloadSkills(ctx.cwd), event.toolName, target).filter(
				(skill) => !alreadyLoadedForSession(ctx, skill),
			);
		} catch {
			return undefined;
		}

		if (matches.length === 0) return undefined;

		return {
			block: true,
			reason: formatAutoloadRequest(matches, event.toolName, target.raw),
		};
	});
}
