/** One render-only catalog for native rows, subagent replay, and remote presentation. */
import type { ToolRenderers } from "@earendil-works/pi-coding-agent";
import { makeRenderCall, makeRenderResult } from "../mcp-collapse/display.ts";
import { collapseAutoloadResult } from "../skill/types.ts";
import { branchRenderers } from "./branch-result.ts";
import { nativeCodemodeRenderers, nativeToolRenderers } from "./native.ts";
import {
	codeTreeRenderers, collapseCodemodeRenderers, createBashResultRenderer,
	generateImageRenderers, generateVideoRenderers, pythonCodeRenderers,
	questionRenderers, readCallRenderers, recallMemoryRenderers, searchRenderers,
	skillRenderers, storeMemoryRenderers, webBrowseRenderers, webSearchRenderers, writeRenderers,
} from "./renderers.ts";

function withAutoload(renderers: ToolRenderers): ToolRenderers {
	const original = renderers.renderResult;
	return {
		...renderers,
		renderResult: original && ((result, options, theme, context) =>
			original(collapseAutoloadResult(result, options.expanded, context.isError), options, theme, context)),
	};
}

export const readToolRenderers = withAutoload({ ...nativeToolRenderers.read, ...readCallRenderers } as ToolRenderers);
export const editToolRenderers = withAutoload(nativeToolRenderers.edit!);
export const writeToolRenderers = withAutoload({ ...nativeToolRenderers.write, ...writeRenderers } as ToolRenderers);
export const bashToolRenderers: ToolRenderers = {
	...nativeToolRenderers.bash,
	renderResult: createBashResultRenderer(nativeToolRenderers.bash?.renderResult),
};

const catalog = {
	...nativeToolRenderers,
	read: readToolRenderers, edit: editToolRenderers, write: writeToolRenderers, bash: bashToolRenderers,
	code_tree: codeTreeRenderers,
	codemode: collapseCodemodeRenderers(nativeCodemodeRenderers),
	generate_image: generateImageRenderers, generate_video: generateVideoRenderers,
	question: questionRenderers, python: pythonCodeRenderers,
	recall_memory: recallMemoryRenderers, search: searchRenderers, skill: skillRenderers,
	store_memory: storeMemoryRenderers, web_browse: webBrowseRenderers, web_search: webSearchRenderers,
	...branchRenderers,
};

/** Unknown tools use Pi's own generic call/result rendering. No execution definitions are loaded. */
export function toolRenderers(name: string): ToolRenderers {
	if (name === "mcp" || name.startsWith("mcp_") || ["memory_query", "memory_add", "memory_update"].includes(name))
		return { renderCall: makeRenderCall(name), renderResult: makeRenderResult(name) } as ToolRenderers;
	return (catalog as Record<string, ToolRenderers>)[name] ?? {};
}
