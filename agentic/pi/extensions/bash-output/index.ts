import { createBashResultRenderer } from "../_tool-display/renderers.ts";
/**
 * Bash output visibility control.
 * 
 * Re-registers the built-in `bash` tool with a custom `renderResult` that
 * hides the output when collapsed. When expanded (Ctrl+O), full output is shown.
 * 
 * Use cases:
 * - Keep chat view clean when running verbose commands
 * - Hide noise from build/test output unless explicitly requested
 * - Still reference outputs verbatim via {tool: <id>} placeholders
 */

import { createBashToolDefinition, type ExtensionAPI, type ToolExecutionStartEvent } from "@earendil-works/pi-coding-agent";

// Track bash execution state by toolCallId
const bashState = new Map<string, { status: "running" | "completed" | "failed"; exitCode?: number | null }>();

export default function (pi: ExtensionAPI) {
	// Track when bash starts executing
	pi.on("tool_execution_start", (event: ToolExecutionStartEvent) => {
		if (event.toolName === "bash") {
			bashState.set(event.toolCallId, { status: "running" });
		}
	});

	// Capture exit code and update status when bash completes
	// Note: BashResult.exitCode is on event.result directly, NOT on result.details
	pi.on("tool_execution_end", (event) => {
		if (event.toolName === "bash") {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const bashResult = event.result as any;
			const exitCode = bashResult?.exitCode ?? null;
			const isError = exitCode !== null && exitCode !== 0;
			bashState.set(event.toolCallId, {
				status: isError ? "failed" : "completed",
				exitCode,
			});
		}
	});

	// Create the built-in bash tool definition to get its execute/logic
	const builtInBash = createBashToolDefinition(process.cwd());

	// Wrap renderResult to hide output when collapsed
	const baseRenderResult = builtInBash.renderResult;

	builtInBash.renderResult = createBashResultRenderer(bashState, baseRenderResult);

	// Re-register the wrapped bash tool
	pi.registerTool(builtInBash);
}
