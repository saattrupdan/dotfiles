/**
 * `web_browse` tool.
 *
 * Thin wrapper around the `agent-browser` CLI. The agent passes a single
 * command string (e.g. `open https://example.com`, `click @ref-2`,
 * `type "input.search" "hello"`) and we run `agent-browser <command>` and
 * return its stdout/stderr. `agent-browser` is already designed for AI
 * agents and produces token-efficient output, so this is mostly a pass-through.
 *
 * For multi-step exploration the agent issues several `web_browse` calls
 * (session state is preserved across calls by `agent-browser` itself).
 */

import { spawn } from "node:child_process";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_CHARS = 30_000;

const Params = Type.Object({
	command: Type.String({
		description:
			"Single agent-browser command (e.g. \"open https://example.com\", \"click @ref-2\", \"type input.search hello\", \"skills get core\"). " +
			"Shell-quoting rules apply. Run \"skills get core\" first if you do not already know the command surface.",
	}),
	timeout_ms: Type.Optional(
		Type.Integer({
			description: `Hard timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS}).`,
			minimum: 1000,
			maximum: 600_000,
			default: DEFAULT_TIMEOUT_MS,
		}),
	),
});

function parseCommand(command: string): string[] {
	const args: string[] = [];
	let current = "";
	let quote: '"' | "'" | null = null;
	let escaped = false;
	for (const ch of command) {
		if (escaped) {
			current += ch;
			escaped = false;
			continue;
		}
		if (ch === "\\") {
			escaped = true;
			continue;
		}
		if (quote) {
			if (ch === quote) quote = null;
			else current += ch;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			continue;
		}
		if (/\s/.test(ch)) {
			if (current) {
				args.push(current);
				current = "";
			}
			continue;
		}
		current += ch;
	}
	if (current) args.push(current);
	return args;
}

function truncate(s: string): { text: string; truncated: boolean } {
	if (s.length <= MAX_OUTPUT_CHARS) return { text: s, truncated: false };
	return {
		text: `${s.slice(0, MAX_OUTPUT_CHARS)}\n[truncated ${s.length - MAX_OUTPUT_CHARS} chars]`,
		truncated: true,
	};
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "web_browse",
		label: "web browse",
		description:
			"Drive a real browser via the `agent-browser` CLI. Pass a single command string per call. " +
			"Session state (open page, cookies, refs) is preserved across consecutive calls. " +
			"Use for interactive flows (login, JS-rendered pages, clicking, typing); for static pages prefer `read` (which fetches and converts URLs). " +
			"If unsure of the command surface, call once with `command=\"skills get core\"`.",
		parameters: Params,

		async execute(_toolCallId, params, signal, _onUpdate, _ctx): Promise<any> {
			const args = parseCommand(params.command);
			if (args.length === 0) {
				return {
					content: [{ type: "text", text: "web_browse: empty command" }],
				};
			}

			const timeout = params.timeout_ms ?? DEFAULT_TIMEOUT_MS;
			return await new Promise((resolve) => {
				const proc = spawn("agent-browser", args, { stdio: ["ignore", "pipe", "pipe"] });
				let stdout = "";
				let stderr = "";
				let timedOut = false;
				const timer = setTimeout(() => {
					timedOut = true;
					proc.kill("SIGTERM");
				}, timeout);
				const onAbort = () => proc.kill("SIGTERM");
				signal?.addEventListener("abort", onAbort, { once: true });

				proc.stdout.on("data", (d) => {
					stdout += d.toString();
				});
				proc.stderr.on("data", (d) => {
					stderr += d.toString();
				});
				proc.on("error", (err) => {
					clearTimeout(timer);
					signal?.removeEventListener("abort", onAbort);
					resolve({
						content: [{ type: "text", text: `web_browse: failed to spawn agent-browser: ${err.message}` }],
						details: { args, error: err.message },
					});
				});
				proc.on("close", (code) => {
					clearTimeout(timer);
					signal?.removeEventListener("abort", onAbort);
					const combined = stdout + (stderr ? `\n[stderr]\n${stderr}` : "");
					const { text, truncated } = truncate(combined.trim() || "(no output)");
					const status = timedOut ? `timeout after ${timeout}ms` : `exit ${code ?? 0}`;
					resolve({
						content: [{ type: "text", text: `# agent-browser ${args.join(" ")}  [${status}${truncated ? ", truncated" : ""}]\n${text}` }],
						details: { args, exitCode: code ?? 0, timedOut, truncated },
					});
				});
			});
		},

		renderCall(args, theme) {
			const cmd = (args?.command as string) || "...";
			const preview = cmd.length > 70 ? `${cmd.slice(0, 70)}...` : cmd;
			return new Text(
				`${theme.fg("toolTitle", theme.bold("web_browse "))}${theme.fg("accent", preview)}`,
				0,
				0,
			);
		},
	});
}
