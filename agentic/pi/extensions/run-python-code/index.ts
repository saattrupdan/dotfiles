/** Execute multiline Python directly instead of wrapping it in bash/heredocs. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { pythonCodeRenderers } from "../_tool-display/renderers.ts";
import { runPythonCode } from "./runner.ts";

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "python",
		label: "python",
		description: "Run multiline Python source locally or on an SSH config alias. Prefer this tool over bash Python heredocs, python -c, and shell-quoted Python snippets. Pass code as plain source with normal newlines, indentation, quotes, and Unicode; no shell escaping or heredoc delimiters. Uses uv run with the selected Python interpreter and project environment. Returns stdout/stderr, exit code, and a full-output file; output is limited to the last 2000 lines/50 KiB. Execution is cancelled on abort or timeout (default 120 seconds). SSH uses non-interactive authentication and requires uv on the remote PATH. Code runs with the same permissions as bash; respect the current agent's read-only or write restrictions.",
		parameters: Type.Object({
			description: Type.String({ description: "Very brief description of what the code does (1–5 words), for example Checking the API validation.", pattern: "^(?![\\s\\S]*[\\x00-\\x1F\\x7F-\\x9F])\\S+(?: \\S+){0,4}$" }),
			code: Type.String({ description: "Python source, including literal newlines and indentation. Do not wrap it in a shell command or heredoc." }),
			ssh_alias: Type.Optional(Type.String({ description: "SSH config alias, for example sparkie. Omit to run locally." })),
			cwd: Type.Optional(Type.String({ description: "Working directory. Locally resolves relative to the current project; remotely use a path on the SSH server (defaults to its login directory)." })),
			python: Type.Optional(Type.String({ description: "Python executable name or path passed to uv run; defaults to python. No shell arguments." })),
			timeout: Type.Optional(Type.Number({ description: "Timeout in seconds, including launch/connection time; default 120, maximum 86400.", exclusiveMinimum: 0, maximum: 86400 })),
		}),
		async execute(_id, params, signal, onUpdate, ctx) {
			onUpdate?.({ content: [], details: undefined });
			try {
				const result = await runPythonCode(params, ctx.cwd, signal);
				const text = `${result.output || "(no output)"}\n\nExit code: ${result.exitCode ?? "terminated"}${result.truncated ? `\nOutput truncated. Full output: ${result.outputPath}` : ""}`;
				return { content: [{ type: "text", text }], details: result, isError: result.exitCode !== 0 };
			} catch (error) {
				return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], details: undefined, isError: true };
			}
		},
		...pythonCodeRenderers,
	});
}
