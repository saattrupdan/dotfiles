import type {
	AgentToolResult,
	Theme,
	ToolRenderResultOptions,
	ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";

type NativeContext = Parameters<NonNullable<ToolRenderers["renderCall"]>>[2];
export type DisplayContext = Omit<NativeContext, "args" | "state"> & {
	args: DisplayArgs;
	state: unknown;
};

/** Partial arguments also cover the model's first streaming paint. */
export interface DisplayArgs {
	name?: string;
	path?: string;
	symbol?: string;
	query?: string;
	kind?: string;
	command?: string;
	text?: string;
	agent?: string;
	task?: string;
	taskName?: string;
	num?: number;
	depth?: number;
	agentScope?: unknown;
	question?: string;
	prompt?: string;
}

export interface DisplayRenderers {
	renderShell?: ToolRenderers["renderShell"];
	renderCall?: (args: DisplayArgs, theme: Theme, context: DisplayContext) => Component;
	renderResult?: (
		result: AgentToolResult<unknown>,
		options: ToolRenderResultOptions,
		theme: Theme,
		context: DisplayContext,
	) => Component;
}
