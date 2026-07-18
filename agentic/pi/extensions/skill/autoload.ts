import type { ExtensionAPI, ExtensionContext, Skill } from "@earendil-works/pi-coding-agent";

import { recordAutoloadRetry } from "../no-repeat/retry.ts";
import { discoverAutoloadSkills, readSkillContent } from "./discovery.ts";
import { extractPathFromPartialInput, matchingAutoloadSkills, targetPathForToolCall } from "./matchers.ts";
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
	});

	let earlyAutoloadInFlight = false;

	/**
	 * Handle early skill autoload from streamed tool-call arguments.
	 * This runs during message_update to detect matching skills as soon as
	 * the path is fully available, before large write/edit bodies finish streaming.
	 */
	function handleEarlyDetection(
		ctx: ExtensionContext,
		toolName: string,
		partialInput: unknown,
	): void {
		if (earlyAutoloadInFlight) return;

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

		const injected = matches.flatMap((skill) => {
			try {
				return [{ skill, content: readSkillContent(skill) }];
			} catch {
				return [];
			}
		});

		if (injected.length === 0) return;

		const session = syncSession(ctx);
		const retryInput = { path: target.raw };
		for (const { skill } of injected) {
			markSkillLoadedForSession(ctx, skill);
		}
		recordAutoloadRetry(session, toolName, retryInput);

		earlyAutoloadInFlight = true;
		ctx.abort();
		pi.sendUserMessage(formatAutoloadInjection(injected, toolName, target.raw), {
			deliverAs: "followUp",
		});
		setImmediate(() => {
			earlyAutoloadInFlight = false;
		});
	}

	pi.on("message_update", (event, ctx) => {
		if (!ctx.hasUI) return;

		// Detect toolCall blocks streaming in the message.
		const content = (event.message as { content?: unknown } | undefined)?.content;
		const blocks = Array.isArray(content) ? content : undefined;
		if (!blocks || blocks.length === 0) return;

		const last = blocks[blocks.length - 1];
		if (!last || last.type !== "toolCall") return;

		const toolName = (last as { name?: string }).name;
		if (!toolName || !AUTOLOAD_TOOL_NAMES.has(toolName)) return;

		// Try to extract path from raw streamed JSON text. Do not trust partial
		// parsed argument objects here: string fields may still be incomplete.
		const streamed = (last as { text?: unknown; arguments?: unknown }).text;
		const args = typeof streamed === "string" ? streamed : (last as { arguments?: unknown }).arguments;
		handleEarlyDetection(ctx, toolName, args);
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
