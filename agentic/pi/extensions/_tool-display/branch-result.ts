import type { DisplayRenderers } from "./types.ts";
import { Text } from "@earendil-works/pi-tui";
export function renderBranchResult(
	result: { content: Array<{ type: string; text?: string }> },
	options: { expanded: boolean; isPartial: boolean },
	theme: { fg: (color: "success" | "warning", text: string) => string },
	isError: boolean,
	summary: string,
	progress: string,
): Text {
	if (options.isPartial) return new Text(theme.fg("warning", `⋯ ${progress}`), 0, 0);
	const text = result.content
		.filter((item) => item.type === "text")
		.map((item) => item.text ?? "")
		.join("\n");
	if (options.expanded || isError)
		return new Text(text || (isError ? "Operation failed" : ""), 0, 0);
	return new Text(theme.fg("success", `✓ ${summary}`), 0, 0);
}

const labels: Record<string, [string, string]> = {
	isolated_new_branch: ["switched to new branch", "creating branch"],
	clean_up_isolated_branch: ["cleaned up branch and worktree", "cleaning up branch"],
	discard_isolated_branch: ["discarded branch and worktree", "discarding branch"],
};
export const branchRenderers: Record<string, DisplayRenderers> = Object.fromEntries(
	Object.entries(labels).map(([name, [summary, progress]]) => {
		const renderers: DisplayRenderers = {
			renderCall(args, theme) {
				return new Text(
					theme.fg("toolTitle", theme.bold(name)) +
						(name === "isolated_new_branch" ? " " + theme.fg("accent", args.name ?? "...") : ""),
					0,
					0,
				);
			},
			renderResult(result, options, theme, context) {
				return renderBranchResult(result, options, theme, context.isError, summary!, progress!);
			},
		};
		return [name, renderers];
	}),
);
