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

import { createBashToolDefinition, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

// Store exit codes by toolCallId since they're not available in renderResult
const exitCodes = new Map<string, number | null>();
let lastBashToolCallId: string | null = null;

export default function (pi: ExtensionAPI) {
	// Capture toolCallId and exit code from bash tool events
	// Note: BashResult.exitCode is on event.result directly, NOT on result.details
	pi.on("tool_execution_end", (event) => {
		if (event.toolName === "bash") {
			lastBashToolCallId = event.toolCallId;
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const bashResult = event.result as any;
			exitCodes.set(event.toolCallId, bashResult?.exitCode ?? null);
		}
	});

	// Create the built-in bash tool definition to get its execute/logic
	const builtInBash = createBashToolDefinition(process.cwd());
	
	// Wrap renderResult to hide output when collapsed
	const baseRenderResult = builtInBash.renderResult;
	
	builtInBash.renderResult = (result, options, theme, context) => {
		// If collapsed (not expanded), show only a status indicator
		if (!options.expanded) {
			// Try to get exit code from our captured map using the last bash toolCallId
			let exitCode: number | null | undefined;
			
			if (lastBashToolCallId && exitCodes.has(lastBashToolCallId)) {
				exitCode = exitCodes.get(lastBashToolCallId);
			} else {
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				const details = result.details as any;
				exitCode = details?.exitCode;
			}
			
			const isError = context.isError || (exitCode !== null && exitCode !== 0);
			
			if (isError) {
				return new Text(theme.fg("error", `✗ bash failed (exit ${exitCode ?? "?"})`), 0, 0);
			}
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
