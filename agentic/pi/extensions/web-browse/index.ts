import { webBrowseRenderers } from "../_tool-display/renderers.ts";
import { remotePromptsEnabled } from "../_remote_bridge/prompts.ts";
import { dispatchAsk } from "../question/index.ts";
/**
 * Firefox-backed `web_browse` tool.
 *
 * Native Firefox is driven through Selenium/geckodriver using a dedicated,
 * persistent profile. The public command API is intentionally narrower than
 * raw WebDriver: password values, cookies, storage, arbitrary JavaScript,
 * network bodies, and screenshots are never exposed to the model.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { Type } from "typebox";

import { interactiveQueue } from "../_interactive_queue/queue.ts";
import { parseCommand, safeCommandPreview } from "./command.ts";
import { FirefoxSession, type HandoffHandler } from "./firefox-session.ts";

const DEFAULT_TIMEOUT_MS = 60_000;
const HANDOFF_TIMEOUT_MS = 600_000;

const Params = Type.Object({
	command: Type.String({
		description:
			"Firefox browser command. Start with `help`. Common commands: `open <url>`, `snapshot`, `click @e1`, " +
			"`fill @e2 <text>`, `handoff [<url>]`, and `close`. Handoff opens normal Firefox for manual sign-in and resumes the same profile after you quit it. Headless is the default for automation.",
	}),
	timeout_ms: Type.Optional(
		Type.Integer({
			description: `Hard timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS}, or ${HANDOFF_TIMEOUT_MS} for handoff).`,
			minimum: 1000,
			maximum: 600_000,
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

export default function (pi: ExtensionAPI) {
	const session = new FirefoxSession();
	// Pi can exit without emitting session_shutdown (e.g. a fatal error or terminal exit).
	const onExit = () => session.terminateOnExit();
	const onTerm = () => {
		session.terminateOnExit();
		if (process.listenerCount("SIGTERM") === 1) {
			process.removeListener("SIGTERM", onTerm);
			process.kill(process.pid, "SIGTERM");
		}
	};
	process.on("exit", onExit);
	process.on("SIGTERM", onTerm);

	pi.on("session_shutdown", async () => {
		await session.shutdown();
		process.removeListener("exit", onExit);
		process.removeListener("SIGTERM", onTerm);
	});

	pi.registerTool({
		name: "web_browse",
		label: "web browse",
		description:
			"Drive native Firefox through a constrained, persistent automation session. Use `help` to list commands. " +
			"Headless mode is the default for automation. Use `handoff [<url>]` for manual sign-in in normal Firefox, then quit that window to resume the same profile without sending passwords through Pi. " +
			"Use for interactive flows and JS-rendered pages; prefer `read` for static pages.",
		parameters: Params,
		executionMode: "sequential",

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const preview = safeCommandPreview(params.command);
			try {
				const command = parseCommand(params.command);
				const handoff: HandoffHandler = async ({ title, message }, handoffSignal) => {
					if(remotePromptsEnabled()){
      const result=await dispatchAsk(ctx,[{question:`${title}\n${message}\nComplete the requested action on the Mac, then select Done.`,options:["Done","Cancel"]}],handoffSignal);
      if(result.error)throw new Error(result.error);return result.answers?.[0]==="Done";
     }
     if (!ctx.hasUI) return false;
					return await interactiveQueue.run(
						(interactionSignal) => ctx.ui.confirm(title, message, { signal: interactionSignal }),
						handoffSignal,
					);
				};
				const text = await withDeadline(
					(operationSignal) => session.execute(command, handoff, operationSignal),
					params.timeout_ms ?? (command.name === "handoff" ? HANDOFF_TIMEOUT_MS : DEFAULT_TIMEOUT_MS),
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

		...webBrowseRenderers,


	});
}
