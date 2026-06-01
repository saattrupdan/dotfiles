import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import { markSkillLoadedForSession, registerAutoload } from "./autoload.ts";
import { discoverSkills, readSkillContent } from "./discovery.ts";
import { registerAutoloadRenderOverrides } from "./render-overrides.ts";

const Params = Type.Object({
	name: Type.String({
		description: "Skill name (the `name:` from the skill's frontmatter, e.g. 'commit', 'fastapi').",
	}),
});

function registerSkillTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "skill",
		label: "skill",
		description:
			"Load a named skill's full SKILL.md content. Returns the file verbatim — no outlining, no truncation. " +
			"Use this when you need the procedural instructions for a skill you've seen advertised in the system prompt. " +
			"Distinct from `read`: this is for skills only and always returns the whole file.",
		parameters: Params,

		async execute(_toolCallId, { name }, _signal, _onUpdate, ctx) {
			const skills = discoverSkills(ctx.cwd);
			const skill = skills.find((s) => s.name === name);

			if (!skill) {
				const available = skills.map((s) => s.name).sort().join(", ") || "(none)";
				return {
					content: [
						{
							type: "text",
							text: `Skill "${name}" not found. Available skills: ${available}`,
						},
					],
					details: undefined,
				};
			}

			let content: string;
			try {
				content = readSkillContent(skill);
			} catch (err) {
				return {
					content: [
						{
							type: "text",
							text: `Failed to read skill "${name}" at ${skill.filePath}: ${(err as Error).message}`,
						},
					],
					details: undefined,
				};
			}

			markSkillLoadedForSession(ctx, skill);

			// The full markdown goes in `content` so the *model* receives it.
			// The chat view is kept to a one-line status via `renderResult`
			// below — `details` carries the skill name for that render.
			return {
				content: [{ type: "text", text: content }],
				details: { name: skill.name },
			};
		},

		renderCall(args, theme) {
			const name = args?.name ? String(args.name) : "...";
			return new Text(
				`${theme.fg("toolTitle", theme.bold("skill"))} ${theme.fg("accent", name)}`,
				0,
				0,
			);
		},

		// The model gets the full SKILL.md via `content`. Keep the collapsed
		// chat view concise, but show the full content when expanded (Ctrl+O).
		renderResult(result, { expanded }, theme, _context) {
			const text = textContent(result.content);
			if (expanded) return new Text(text, 0, 0);

			const details = result.details as { name?: string } | undefined;
			if (!details?.name) return new Text(firstLine(text), 0, 0);

			return new Text(theme.fg("success", `✓ loaded skill "${details.name}"`), 0, 0);
		},
	});
}

function textContent(content: Array<{ type: string; text?: string }>): string {
	return content
		.filter((item) => item.type === "text" && item.text)
		.map((item) => item.text)
		.join("\n");
}

function firstLine(text: string): string {
	return text.split("\n")[0] || "(no output)";
}

export default function (pi: ExtensionAPI): void {
	registerSkillTool(pi);
	registerAutoload(pi);
	registerAutoloadRenderOverrides(pi);
}
