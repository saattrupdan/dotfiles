import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { discoverAutoloadSkills } from "./discovery.ts";
import { matchingAutoloadSkills, targetPathForToolCall } from "./matchers.ts";
import { AUTOLOAD_TOOL_NAMES, type DiscoveredSkill } from "./types.ts";

const delivered = new Set<string>();
let currentSessionId: string | undefined;

function sessionId(ctx: ExtensionContext): string {
	return ctx.sessionManager?.getSessionId() ?? "runtime";
}

function skillKey(session: string, skill: DiscoveredSkill): string {
	return `${session}\0${skill.name}\0${skill.filePath}`;
}

function syncSession(ctx: ExtensionContext): string {
	const id = sessionId(ctx);
	if (currentSessionId && currentSessionId !== id) {
		delivered.clear();
	}
	currentSessionId = id;
	return id;
}

export function alreadyInjectedForSession(ctx: ExtensionContext, skill: DiscoveredSkill): boolean {
	return delivered.has(skillKey(syncSession(ctx), skill));
}

function markDelivered(ctx: ExtensionContext, skills: DiscoveredSkill[]): void {
	const id = syncSession(ctx);
	for (const skill of skills) {
		delivered.add(skillKey(id, skill));
	}
}

function formatAutoloadBlock(skills: DiscoveredSkill[], toolName: string, rawPath: string): string {
	const skillNames = skills.map((s) => s.name).join(", ");
	const renderedSkills = skills
		.map((skill) => `<skill name="${skill.name}" path="${skill.filePath}">\n${skill.content}\n</skill>`)
		.join("\n\n");

	return (
		`Relevant skill${skills.length === 1 ? "" : "s"} matched this ${toolName} call for \`${rawPath}\`: ${skillNames}.\n\n` +
		"The original tool call has been blocked once so you can read and apply the guidance below. " +
		"After applying it, retry the original tool call; these skills are marked delivered for this session, so the retry will proceed.\n\n" +
		renderedSkills
	);
}

export function registerAutoload(pi: ExtensionAPI): void {
	pi.on("session_start", async () => {
		delivered.clear();
		currentSessionId = undefined;
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!AUTOLOAD_TOOL_NAMES.has(event.toolName)) return undefined;

		const target = targetPathForToolCall(event.input, ctx.cwd);
		if (!target) return undefined;

		let matches: DiscoveredSkill[];
		try {
			matches = matchingAutoloadSkills(discoverAutoloadSkills(ctx.cwd), event.toolName, target).filter(
				(skill) => !alreadyInjectedForSession(ctx, skill),
			);
		} catch {
			return undefined;
		}

		if (matches.length === 0) return undefined;

		markDelivered(ctx, matches);
		return {
			block: true,
			reason: formatAutoloadBlock(matches, event.toolName, target.raw),
		};
	});
}
