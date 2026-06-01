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

// Skill-autoload blocks inject their guidance as the *reason* of a blocked tool
// call, which the harness turns into an error tool result. The reason always
// leads with a one-line summary (`↪ fastapi, python skills injected`) produced
// by `formatInjectedSummary` in autoload.ts. The read/write/edit result
// renderers key off this to collapse the (long) injected guidance down to that
// summary line — full guidance is still shown when the result is expanded
// (Ctrl+O).
const AUTOLOAD_SUMMARY_RE = /^↪ .+ skills? injected$/;

/**
 * If `text` is a skill-autoload injection, return its one-line summary;
 * otherwise return undefined. Keep in sync with `formatInjectedSummary`.
 */
export function autoloadSummaryLine(text: string): string | undefined {
	const first = text.split("\n", 1)[0] ?? "";
	return AUTOLOAD_SUMMARY_RE.test(first) ? first : undefined;
}

type ResultContent = ReadonlyArray<{ type: string; text?: string }>;

/**
 * Collapse a skill-autoload injection down to its summary line for a *collapsed*
 * tool-result view, leaving every other result untouched. Tool result renderers
 * delegate to the built-in renderer with this applied first, so the full
 * guidance still shows on expand (Ctrl+O) and normal output is unaffected.
 *
 * Autoload injects guidance as the reason of a blocked tool call, which the
 * harness turns into an *error* result the built-in renderers show in full even
 * when collapsed — this is what trims it back to the one-line summary.
 */
export function collapseAutoloadResult<R extends { content: ResultContent }>(
	result: R,
	expanded: boolean,
	isError: boolean,
): R {
	if (expanded || !isError) return result;
	const text = result.content
		.filter((item) => item.type === "text" && item.text)
		.map((item) => item.text)
		.join("\n");
	const summary = autoloadSummaryLine(text);
	if (!summary) return result;
	return { ...result, content: [{ type: "text", text: summary }] };
}
