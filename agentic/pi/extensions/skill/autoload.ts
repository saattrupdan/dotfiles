import type { ExtensionAPI, ExtensionContext, Skill } from "@earendil-works/pi-coding-agent";

import { recordAutoloadRetry } from "../no-repeat/retry.ts";
import { discoverAutoloadSkills, readSkillContent } from "./discovery.ts";
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

function formatInjectedSummary(skills: DiscoveredSkill[]): string {
	if (skills.length === 1) return `↪ ${skills[0].name} skill injected`;
	const names = skills.map((skill) => skill.name).join(", ");
	return `↪ ${names} skills injected`;
}

function formatInjectedSkill(skill: DiscoveredSkill, content: string): string {
	return [`<skill name="${skill.name}">`, content.trimEnd(), "</skill>"].join("\n");
}

function formatAutoloadInjection(
	skills: Array<{ skill: DiscoveredSkill; content: string }>,
	toolName: string,
	rawPath: string,
): string {
	const summary = formatInjectedSummary(skills.map(({ skill }) => skill));
	const injected = skills.map(({ skill, content }) => formatInjectedSkill(skill, content)).join("\n\n");

	return (
		`${summary}\n\n` +
		`Relevant skill${skills.length === 1 ? "" : "s"} matched this ${toolName} call for \`${rawPath}\`. ` +
		"The original tool call was blocked once so the full skill guidance could be injected directly below. " +
		"Retry the exact original tool call now; no explicit `skill` tool call is needed for this autoload.\n\n" +
		injected
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

		const injected = matches.flatMap((skill) => {
			try {
				return [{ skill, content: readSkillContent(skill) }];
			} catch {
				return [];
			}
		});

		if (injected.length === 0) return undefined;

		const session = syncSession(ctx);
		for (const { skill } of injected) {
			markSkillLoadedForSession(ctx, skill);
		}
		recordAutoloadRetry(session, event.toolName, event.input);

		return {
			block: true,
			reason: formatAutoloadInjection(injected, event.toolName, target.raw),
		};
	});
}
