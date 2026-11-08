/** Expand only discovered main-profile templates and skills using native parsing. */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type {
	ExtensionAPI,
	ExtensionContext,
	PromptTemplate,
} from "@earendil-works/pi-coding-agent";
import { resolvePiPackage } from "../../profile/pi-runtime.mjs";
export const isInputCommand = (command: ReturnType<ExtensionAPI["getCommands"]>[number]) =>
	command.source === "prompt" || command.source === "skill";
export async function expandCommandInput(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	name: string,
	args: string,
): Promise<string | undefined> {
	const command = pi.getCommands().find((c) => c.name === name);
	if (!command || !isInputCommand(command)) return undefined;
	const file = command.sourceInfo.path;
	if (command.source === "skill") {
		const { stripFrontmatter } = (await import(
			pathToFileURL(path.join(resolvePiPackage(), "dist/utils/frontmatter.js")).href
		)) as { stripFrontmatter: (text: string) => string };
		const body = stripFrontmatter(fs.readFileSync(file, "utf8")).trim();
		const skill = `<skill name="${name.replace(/^skill:/, "")}" location="${file}">\nReferences are relative to ${path.dirname(file)}.\n\n${body}\n</skill>`;
		return args.trim() ? `${skill}\n\n${args.trim()}` : skill;
	}
	const native = (await import(
		pathToFileURL(path.join(resolvePiPackage(), "dist/core/prompt-templates.js")).href
	)) as {
		loadPromptTemplates: (options: {
			cwd: string;
			agentDir: string;
			promptPaths: string[];
			includeDefaults: boolean;
		}) => { templates: PromptTemplate[] };
		expandPromptTemplate: (input: string, templates: PromptTemplate[]) => string;
	};
	const { templates } = native.loadPromptTemplates({
		cwd: ctx.cwd,
		agentDir: process.env.PI_CODING_AGENT_DIR || path.join(process.env.HOME!, ".pi", "agent"),
		promptPaths: [file],
		includeDefaults: false,
	});
	if (!templates.some((template) => template.name === name))
		throw new Error("template_unavailable");
	return native.expandPromptTemplate(`/${name} ${args}`, templates);
}
