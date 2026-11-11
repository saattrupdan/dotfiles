/** Replay native renderers without extension registration, tool execution, or session writers. */
import {
	createBashToolDefinition,
	createEditToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	initTheme,
	ToolExecutionComponent,
	type ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import { displayBlock, type ToolBlock, type ToolLineStyle } from "./block.ts";
import { makeRenderCall, makeRenderResult } from "../mcp-collapse/display.ts";
import { collapseAutoloadResult } from "../skill/types.ts";
import { createSubagentRenderers } from "../subagent/display.ts";
import { boundedToolArguments } from "./arguments.ts";
import { branchRenderers } from "./branch-result.ts";
import {
	codeTreeRenderers,
	codemodeRenderers,
	createBashResultRenderer,
	generateImageRenderers,
	generateVideoRenderers,
	questionRenderers,
	readCallRenderers,
	recallMemoryRenderers,
	searchRenderers,
	skillRenderers,
	storeMemoryRenderers,
	webBrowseRenderers,
	webSearchRenderers,
} from "./renderers.ts";

interface Result {
	content: Array<{ type: string; text?: string; [key: string]: unknown }>;
	details?: Record<string, unknown>;
	isError?: boolean;
}
const shorten = (text: string) => {
	const lines = text.slice(0, 16384).split("\n");
	const value = lines
		.slice(0, 1000)
		.map((line) => line.slice(0, 2048))
		.join("\n");
	return value;
};

const builtins = {
	read: createReadToolDefinition("/"),
	write: createWriteToolDefinition("/"),
	edit: createEditToolDefinition("/"),
	bash: createBashToolDefinition("/"),
};
const custom = {
	code_tree: codeTreeRenderers,
	codemode: codemodeRenderers,
	generate_image: generateImageRenderers,
	generate_video: generateVideoRenderers,
	question: questionRenderers,
	recall_memory: recallMemoryRenderers,
	search: searchRenderers,
	skill: skillRenderers,
	store_memory: storeMemoryRenderers,
	web_browse: webBrowseRenderers,
	web_search: webSearchRenderers,
};
let initialized = false;

/** The returned text is the laptop's collapsed tool block, without terminal styling. */
export function toolPresentationBlock(
	name: string,
	args: unknown,
	result: Result | undefined,
	id: string,
	cwd: string,
): ToolBlock {
	if (!initialized) {
		initTheme("dark");
		initialized = true;
	}
	let renderers: object = custom[name as keyof typeof custom] ?? {};
	const builtin = builtins[name as keyof typeof builtins];
	if (builtin) {
		const original = builtin.renderResult as ToolRenderers["renderResult"];
		renderers = {
			renderShell: builtin.renderShell,
			renderCall: name === "read" ? readCallRenderers.renderCall : builtin.renderCall,
			renderResult:
				name === "bash"
					? createBashResultRenderer(new Map(), builtins.bash.renderResult)
					: original &&
						(((value, options, theme, context) =>
							original(
								collapseAutoloadResult(value, options.expanded, context.isError),
								options,
								theme,
								context as never,
							)) as typeof original),
		};
	}
	if (
		name === "mcp" ||
		name.startsWith("mcp_") ||
		["memory_query", "memory_add", "memory_update"].includes(name)
	)
		renderers = { renderCall: makeRenderCall(name), renderResult: makeRenderResult(name) };
	if (name === "subagent") {
		const label = result?.details?.sessionLabel;
		renderers = createSubagentRenderers(
			typeof label === "string" ? new Map([[id, label]]) : undefined,
		);
	}
	if (branchRenderers[name]) renderers = branchRenderers[name]!;
	const bounded = boundedToolArguments(args);
	const details = result?.details ? boundedToolArguments(result.details) : undefined;
	const colors: Partial<Record<Exclude<ToolLineStyle, "plain">, string>> = {};
	const call = (renderers as ToolRenderers).renderCall;
	if (call)
		renderers = {
			...renderers,
			renderCall: ((args, theme, context) => {
				colors.command = theme.getFgAnsi("toolTitle");
				if (!result?.isError && typeof result?.details?.diff === "string") {
					colors.added = theme.getFgAnsi("toolDiffAdded");
					colors.removed = theme.getFgAnsi("toolDiffRemoved");
				}
				return call(args, theme, context);
			}) as ToolRenderers["renderCall"],
		};
	const row = new ToolExecutionComponent(
		name,
		id,
		bounded.args,
		{ showImages: false, outputPad: 0 },
		renderers as never,
		{ requestRender() {} } as never,
		cwd,
	);
	// argsComplete stays false: historical rows must never compute previews from live files.
	row.markExecutionStarted();
	if (result)
		row.updateResult({
			...result,
			content: result.content.map((part) =>
				part.type === "text" ? { ...part, text: shorten(part.text ?? "") } : part,
			),
			details: details?.args,
		} as never);
	return displayBlock(row.render(2048), name, colors);
}

/** The same native text for consumers that do not need line styling. */
export function toolPresentation(...args: Parameters<typeof toolPresentationBlock>): string {
	return toolPresentationBlock(...args).text;
}
