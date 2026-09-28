/**
 * Firefox-backed `web_browse` tool.
 *
 * Native Firefox is driven through Selenium/geckodriver using a dedicated,
 * persistent profile. The public command API is intentionally narrower than
 * raw WebDriver: password values, cookies, storage, arbitrary JavaScript,
 * network bodies, and screenshots are never exposed to the model.
 */

import type { AgentToolResult, ExtensionAPI, Theme, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import { interactiveQueue } from "../_interactive_queue/queue.ts";
import { parseCommand, safeCommandPreview } from "./command.ts";
import { FirefoxSession, type HandoffHandler } from "./firefox-session.ts";

const DEFAULT_TIMEOUT_MS = 60_000;

const Params = Type.Object({
	command: Type.String({
		description:
			"Firefox browser command. Start with `help`. Common commands: `open <url>`, `snapshot`, `click @e1`, " +
			"`fill @e2 <text>`, `start --headed`, `handoff`, and `close`. Headless is the default; session state persists between calls.",
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

async function withDeadline<T>(
	operation: (signal: AbortSignal) => Promise<T>,
	timeoutMs: number,
	signal: AbortSignal | undefined,
	onInterrupt: () => Promise<unknown>,
): Promise<T> {
	const controller = new AbortController();
	let timer: NodeJS.Timeout | undefined;
	let interrupted = false;
	let onAbort: (() => void) | undefined;
	const deadline = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => {
			interrupted = true;
			const error = new Error(`browser command timed out after ${timeoutMs}ms`);
			controller.abort(error);
			reject(error);
		}, timeoutMs);
		onAbort = () => {
			interrupted = true;
			const error = new Error("browser command aborted");
			controller.abort(error);
			reject(error);
		};
		if (signal?.aborted) onAbort();
		else signal?.addEventListener("abort", onAbort, { once: true });
	});

	try {
		return await Promise.race([operation(controller.signal), deadline]);
	} catch (error) {
		if (interrupted) await onInterrupt();
		throw error;
	} finally {
		if (timer) clearTimeout(timer);
		if (onAbort) signal?.removeEventListener("abort", onAbort);
	}
}

function resultText(result: AgentToolResult<unknown>): string {
	return (
		result.content
			.filter(
				(content: { type: string; text?: string }): content is { type: "text"; text: string } =>
					content.type === "text" && content.text != null,
			)
			.map((content: { type: string; text?: string }) => content.text)
			.join("\n") || "(no output)"
	);
}

export default function (pi: ExtensionAPI) {
	const session = new FirefoxSession();

	pi.on("session_shutdown", async () => {
		await session.close();
	});

	pi.registerTool({
		name: "web_browse",
		label: "web browse",
		description:
			"Drive native Firefox through a constrained, persistent automation session. Use `help` to list commands. " +
			"Headless mode is the default; use `start --headed` for human Bitwarden unlock/autofill handoff without sending passwords through Pi. " +
			"Use for interactive flows and JS-rendered pages; prefer `read` for static pages.",
		parameters: Params,
		executionMode: "sequential",

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const preview = safeCommandPreview(params.command);
			try {
				const command = parseCommand(params.command);
				const handoff: HandoffHandler = async ({ title, message }, handoffSignal) => {
					if (!ctx.hasUI) return false;
					return await interactiveQueue.run(
						(interactionSignal) => ctx.ui.confirm(title, message, { signal: interactionSignal }),
						handoffSignal,
					);
				};
				const text = await withDeadline(
					(operationSignal) => session.execute(command, handoff, operationSignal),
					params.timeout_ms ?? DEFAULT_TIMEOUT_MS,
					signal,
					() => session.close(),
				);
				return {
					content: [{ type: "text" as const, text: `# Firefox ${preview}\n${text}` }],
					details: { command: command.name, mode: "firefox" },
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text" as const, text: `# Firefox ${preview}\nError: ${message}` }],
					details: { error: message, mode: "firefox" },
				};
			}
		},

		renderCall(args, theme) {
			return new Text(
				`${theme.fg("toolTitle", theme.bold("web_browse "))}${theme.fg("accent", safeCommandPreview((args?.command as string) || ""))}`,
				0,
				0,
			);
		},

		renderResult(
			result: AgentToolResult<unknown>,
			{ expanded }: ToolRenderResultOptions,
			theme: Theme,
			context: { isError: boolean },
		) {
			if (expanded) return new Text(resultText(result), 0, 0);
			const details = result.details as { error?: string } | undefined;
			if (context.isError || details?.error) {
				return new Text(theme.fg("error", "✗ Firefox action failed"), 0, 0);
			}
			return new Text(theme.fg("success", "✓ Firefox action completed"), 0, 0);
		},
	});
}
