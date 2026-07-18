import type { ExtensionAPI, ExtensionContext, Skill } from "@earendil-works/pi-coding-agent";

import { recordAutoloadRetry } from "../no-repeat/retry.ts";
import { discoverAutoloadSkills, readSkillContent } from "./discovery.ts";
import { extractPathFromPartialInput, matchesAutoloadRule, matchingAutoloadSkills, targetPathForToolCall } from "./matchers.ts";
import { AUTOLOAD_TOOL_NAMES, type DiscoveredSkill } from "./types.ts";

const loaded = new Set<string>();
let currentSessionId: string | undefined;

// Cache for early-detected skills from message_update, used by tool_call to block/inject.
// Key: toolName\0path -> array of skill names to inject
const earlyDetectedSkills = new Map<string, string[]>();

function earlyCacheKey(toolName: string, path: string): string {
	return `${toolName}\0${path}`;
}

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

// The summary is the first line of every injection reason. The read/write/edit
// result renderers recognise it via `autoloadSummaryLine` (types.ts) to collapse
// the guidance, so keep the two in sync if this wording changes.
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
		earlyDetectedSkills.clear();
	});

	/**
	 * Handle early skill autoload from streamed tool-call arguments.
	 * This runs during message_update to detect matching skills as soon as
	 * the path is fully available. Skills are cached for tool_call to use.
	 */
	function handleEarlyDetection(
		ctx: ExtensionContext,
		toolName: string,
		partialInput: unknown,
	): void {
		const pathStr = extractPathFromPartialInput(partialInput);
		if (!pathStr || pathStr.length === 0) return;

		const target = targetPathForToolCall({ path: pathStr }, ctx.cwd);
		if (!target) return;

		let matches: DiscoveredSkill[];
		try {
			matches = matchingAutoloadSkills(discoverAutoloadSkills(ctx.cwd), toolName, target).filter(
				(skill) => !alreadyLoadedForSession(ctx, skill),
			);
		} catch {
			return;
		}

		if (matches.length === 0) return;

		// Cache the skill names for tool_call to use
		const key = earlyCacheKey(toolName, target.raw);
		const skillNames = matches.map((s) => s.name);
		earlyDetectedSkills.set(key, skillNames);

		// Abort the current generation to trigger a retry
		// The retry will fire tool_call where we can properly block/inject
		ctx.abort();
	}

	pi.on("message_update", (event, ctx) => {
		// Detect toolCall blocks streaming in the message
		const content = (event.message as { content?: unknown } | undefined)?.content;
		const blocks = Array.isArray(content) ? content : undefined;
		if (!blocks || blocks.length === 0) return;

		const last = blocks[blocks.length - 1];
		if (last?.type !== "toolCall") return;

		const toolName = (last as { name?: string }).name;
		if (!toolName || !AUTOLOAD_TOOL_NAMES.has(toolName)) return;

		// Try to extract path from the streaming arguments
		// Arguments may be a string (streaming JSON) or a partial object
		const args = (last as { arguments?: unknown }).arguments;
		handleEarlyDetection(ctx, toolName, args);
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!AUTOLOAD_TOOL_NAMES.has(event.toolName)) return undefined;

		const target = targetPathForToolCall(event.input, ctx.cwd);
		if (!target) return undefined;

		// Check if skills were detected early from message_update
		const earlyKey = earlyCacheKey(event.toolName, target.raw);
		const earlySkillNames = earlyDetectedSkills.get(earlyKey);
		let matches: DiscoveredSkill[];

		if (earlySkillNames && earlySkillNames.length > 0) {
			// Use early-detected skills
			const allSkills = discoverAutoloadSkills(ctx.cwd);
			matches = allSkills.filter(
				(skill) =>
					earlySkillNames.includes(skill.name) &&
					skill.autoload &&
					matchesAutoloadRule(skill.autoload, event.toolName, target) &&
					!alreadyLoadedForSession(ctx, skill),
			);
			// Clear the cache entry
			earlyDetectedSkills.delete(earlyKey);
		} else {
			// Normal autoload path (no early detection)
			try {
				matches = matchingAutoloadSkills(discoverAutoloadSkills(ctx.cwd), event.toolName, target).filter(
					(skill) => !alreadyLoadedForSession(ctx, skill),
				);
			} catch {
				return undefined;
			}
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
