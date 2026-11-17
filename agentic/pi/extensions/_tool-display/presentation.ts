/** Replay native renderers without extension registration, tool execution, or session writers. */
import { initTheme, ToolExecutionComponent, type ToolRenderers } from "@earendil-works/pi-coding-agent";
import { displayBlock, type ToolBlock, type ToolLineStyle } from "./block.ts";
import { createSubagentRenderers } from "../subagent/display.ts";
import { boundedToolArguments } from "./arguments.ts";
import { toolRenderers } from "./catalog.ts";

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
	let renderers: ToolRenderers = toolRenderers(name);
	if (name === "subagent") {
		const label = result?.details?.sessionLabel;
		renderers = createSubagentRenderers(
			typeof label === "string" ? new Map([[id, label]]) : undefined,
		) as ToolRenderers;
	}
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
	if (!result && name === "python")
		row.updateResult({ content: [], details: undefined, isError: false }, true);
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
