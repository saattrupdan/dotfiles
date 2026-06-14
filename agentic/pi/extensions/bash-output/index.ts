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
import { Text } from "@earendil-works/pi-tui";

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
	
	builtInBash.renderResult = (result, options, theme, context) => {
		// If collapsed (not expanded), show only a status indicator
		if (!options.expanded) {
			// Check context for error state (available even if state map lookup fails)
			const isError = context.isError;
			
			// Try to get state for this tool call from our tracked map
			const toolCallId = options.toolCallId;
			const state = toolCallId ? bashState.get(toolCallId) : undefined;
			
			// If we have tracked state and it's not running, use it
			if (state && state.status !== "running") {
				if (state.status === "failed") {
					return new Text(theme.fg("error", "✗ bash failed"), 0, 0);
				}
				return new Text(theme.fg("success", "✓ bash executed"), 0, 0);
			}
			
			// Fallback: use context.isError if state lookup failed
			if (isError) {
				return new Text(theme.fg("error", "✗ bash failed"), 0, 0);
			}
			if (state?.status === "running") {
				return new Text(theme.fg("warning", "⋯ bash running"), 0, 0);
			}
			
			// Default: assume success if we got here (renderResult means execution completed)
			return new Text(theme.fg("success", "✓ bash executed"), 0, 0);
		}
		
		// Expanded: delegate to the built-in renderer for full output
		if (baseRenderResult) {
			return baseRenderResult(result, options, theme, context);
		}
		
		// Fallback: show raw text content
		const text = (result.content ?? [])
			.filter((c) => c.type === "text")
			.map((c) => c.text ?? "")
			.join("\n");
		return new Text(text || "(no output)", 0, 0);
	};
	
	// Re-register the wrapped bash tool
	pi.registerTool(builtInBash);
}
