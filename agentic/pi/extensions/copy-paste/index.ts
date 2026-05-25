/**
 * `copy_paste` tool.
 *
 * Retrieves a previously captured tool output by its `toolCallId`. This
 * allows subagents to reference large tool outputs without retyping them,
 * saving tokens.
 *
 * The context file is per-conversation (per cwd) and is overwritten each
 * turn, so only the most recent tool outputs are available.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const CONTEXT_DIR = path.join(
	path.dirname(path.dirname(__dirname)),
	"copy-paste-contexts",
);

function encodeCwd(cwd: string): string {
	// Encode the absolute path as a URL-safe filename segment.
	return encodeURIComponent(cwd);
}

interface ContextEntry {
	toolCallId: string;
	toolName: string;
	content: string;
	timestamp: string;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "copy_paste",
		label: "copy paste",
		description:
			"Retrieve a previously captured tool output by its `toolCallId`. " +
			"Use this to reference large tool outputs without retyping them. " +
			"The toolCallId comes from the assistant's tool call parts or from " +
			"the tool result messages in the conversation history.",
		parameters: Type.Object({
			toolCallId: Type.String({
				description: "The toolCallId of the previous tool output to retrieve.",
			}),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const contextFile = path.join(CONTEXT_DIR, `${encodeCwd(ctx.cwd)}.json`);

			try {
				const raw = fs.readFileSync(contextFile, "utf-8");
				const entries = JSON.parse(raw) as ContextEntry[];

				for (const entry of entries) {
					if (entry.toolCallId === params.toolCallId) {
						return {
							content: [{ type: "text", text: entry.content }],
						};
					}
				}

				return {
					content: [
						{
							type: "text",
							text: `No tool output found for toolCallId: ${params.toolCallId}`,
						},
					],
					isError: true,
				};
			} catch {
				return {
					content: [
						{
							type: "text",
							text: `No tool output found for toolCallId: ${params.toolCallId}`,
						},
					],
					isError: true,
				};
			}
		},

		renderCall(args, theme) {
			const id = (args?.toolCallId as string) || "...";
			return new Text(
				`${theme.fg("toolTitle", theme.bold("copy_paste "))}${theme.fg("muted", id.slice(0, 40))}`,
				0,
				0,
			);
		},
	});
}
