/**
 * `skill` tool.
 *
 * Loads the full SKILL.md for a named skill, in one shot, with no outlining,
 * no dedupe, no symbol slicing — the file goes back verbatim.
 *
 * This is intentionally distinct from `read`. The modified `read` in this
 * config returns an outline for large files, which is the wrong behaviour for
 * skill loading: a skill's whole point is the procedural instructions in its
 * body, and those frequently exceed the small-file threshold.
 *
 * Splitting `skill` out from `read` also lets us hand an agent the ability to
 * load skills without granting it general filesystem read access (e.g. an
 * orchestrator that should look up its own playbook but not poke at source
 * files).
 *
 * Skill discovery delegates to `loadSkills` from pi-coding-agent so we honour
 * exactly the same locations pi advertises in its system prompt.
 */

import * as fs from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir, loadSkills, type Skill } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const Params = Type.Object({
	name: Type.String({
		description: "Skill name (the `name:` from the skill's frontmatter, e.g. 'commit', 'fastapi').",
	}),
});

function discoverSkills(cwd: string): Skill[] {
	const { skills } = loadSkills({
		cwd,
		agentDir: getAgentDir(),
		skillPaths: [],
		includeDefaults: true,
	});
	return skills;
}

export default function (pi: ExtensionAPI) {
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
				content = fs.readFileSync(skill.filePath, "utf-8");
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

			return {
				content: [{ type: "text", text: `Skill "${skill.name}" loaded.` }],
				details: undefined,
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
	});
}
