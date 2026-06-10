/**
 * `question` tool.
 *
 * Pop one or more dialogs asking the user something and return their answers.
 *
 * Three execution paths:
 *
 *  1. Orchestrator process (has UI):
 *     calls ctx.ui.select / ctx.ui.input directly.
 *
 *  2. Subagent process (no UI, but PI_SUBAGENT_CHILD=1):
 *     emits a `PI_QUESTION_REQUEST` line on stderr; the parent's `subagent`
 *     extension intercepts it, opens the dialog on the orchestrator's UI,
 *     and writes a `PI_QUESTION_RESPONSE` line back on a dedicated extra
 *     pipe (fd advertised via `PI_QUESTION_RESPONSE_FD`, typically fd 3).
 *     Stdin is deliberately left attached to /dev/null in the child so it
 *     never blocks on startup. See `../_question_protocol/protocol.ts` for
 *     the wire format.
 *
 *  3. Neither (e.g. print/RPC mode with no UI and not a subagent child):
 *     returns an error nudge so the model recovers with a sensible default.
 *
 * Each question item is either free-text (`question` only) or multiple-choice
 * (`question` + `options`). Multiple-choice always gets an "Other…" entry
 * appended automatically so the user can type a custom answer instead of
 * being trapped by the given options.
 *
 * With more than one question, the dialog title is prefixed `(i/N) ` so the
 * user sees a progress indicator; answers are collected sequentially and
 * returned together.
 *
 * Non-interactive mode (PI_NON_INTERACTIVE=1, set by the `/non-interactive`
 * command) makes the tool refuse to ask anything and instruct the model to
 * pick a sensible default.
 */

import * as crypto from "node:crypto";
import * as net from "node:net";

import type { AgentToolResult, ExtensionAPI, ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import { isLidClosed } from "../_lid_state/lid.ts";

import {
	encodeRequest,
	tryParseResponse,
	type QuestionItem,
	type QuestionResponse,
} from "../_question_protocol/protocol.ts";

const OTHER_LABEL = "Other (type your own)…";

const Params = Type.Object({
	question: Type.String({
		description:
			"The question to ask. Be specific and self-contained — the user only sees this text, not your reasoning.",
	}),
	options: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"Optional list of choices. If provided, the user picks one of these strings; an 'Other…' entry is appended automatically so they can always type a freeform answer instead. Omit for a free-text question.",
			minItems: 2,
			maxItems: 10,
		}),
	),
});

// ---------------------------------------------------------------------------
// Local (UI) ask path
// ---------------------------------------------------------------------------

interface AskOutcome {
	answer?: string;
	error?: "dismissed" | "empty" | string;
}

async function askOneLocally(
	ui: ExtensionUIContext,
	item: QuestionItem,
	title: string,
	signal: AbortSignal | undefined,
): Promise<AskOutcome> {
	try {
		if (item.options && item.options.length > 0) {
			const choices = [...item.options, OTHER_LABEL];
			const choice = await ui.select(title, choices, { signal });
			if (choice === undefined) return { error: "dismissed" };
			if (choice !== OTHER_LABEL) return { answer: choice };
			const typed = await ui.input(title, undefined, { signal });
			if (typed === undefined) return { error: "dismissed" };
			if (!typed.trim()) return { error: "empty" };
			return { answer: typed.trim() };
		}

		const typed = await ui.input(title, undefined, { signal });
		if (typed === undefined) return { error: "dismissed" };
		if (!typed.trim()) return { error: "empty" };
		return { answer: typed.trim() };
	} catch (err) {
		return { error: `dialog failed: ${(err as Error).message}` };
	}
}

/**
 * Run the full question sequence locally against `ui`. Exported so the
 * parent subagent extension can reuse the same loop when bridging a child's
 * request to the orchestrator's UI.
 */
export async function askLocally(
	ui: ExtensionUIContext,
	questions: QuestionItem[],
	signal: AbortSignal | undefined,
): Promise<{ answers?: string[]; error?: string }> {
	const total = questions.length;
	const answers: string[] = [];
	for (let i = 0; i < total; i++) {
		const item = questions[i];
		const prefix = total > 1 ? `(${i + 1}/${total}) ` : "";
		const title = `${prefix}${item.question}`;
		const outcome = await askOneLocally(ui, item, title, signal);
		if (outcome.error) {
			return {
				error:
					outcome.error === "dismissed"
						? `User dismissed question ${i + 1}/${total} without answering.`
						: outcome.error === "empty"
							? `User submitted an empty answer to question ${i + 1}/${total}.`
							: `Question ${i + 1}/${total} failed: ${outcome.error}`,
				answers,
			} as { answers?: string[]; error?: string };
		}
		answers.push(outcome.answer!);
	}
	return { answers };
}

// ---------------------------------------------------------------------------
// Remote (bridge) ask path: child subagent → parent orchestrator
// ---------------------------------------------------------------------------

/**
 * Lazily-opened read stream for the parent→child response channel.
 *
 * The parent spawns us with an extra pipe on a dedicated fd (advertised via
 * `PI_QUESTION_RESPONSE_FD`, typically 3) — we never use stdin for this, so
 * the child's fd 0 can stay attached to /dev/null and never blocks startup.
 */
let responseStream: net.Socket | null = null;
function getResponseStream(): net.Socket | null {
	if (responseStream) return responseStream;
	const raw = process.env.PI_QUESTION_RESPONSE_FD;
	if (!raw) return null;
	const fd = Number.parseInt(raw, 10);
	if (!Number.isInteger(fd) || fd < 0) return null;
	try {
		responseStream = new net.Socket({ fd, readable: true, writable: false });
		responseStream.setEncoding("utf-8");
	} catch {
		responseStream = null;
	}
	return responseStream;
}

/**
 * Emit a request on stderr and wait for a tagged response on fd 3. Resolves
 * when the parent writes back, the abort signal fires, or the channel closes.
 */
function askViaBridge(
	questions: QuestionItem[],
	signal: AbortSignal | undefined,
): Promise<QuestionResponse> {
	return new Promise((resolve) => {
		const id = crypto.randomBytes(6).toString("hex");
		const channel = getResponseStream();
		if (!channel) {
			resolve({ id, error: "No question response channel from parent (PI_QUESTION_RESPONSE_FD unset)." });
			return;
		}

		let buffer = "";
		let settled = false;

		const settle = (res: QuestionResponse) => {
			if (settled) return;
			settled = true;
			channel.off("data", onData);
			channel.off("end", onEnd);
			channel.off("close", onEnd);
			if (abortListener) signal?.removeEventListener("abort", abortListener);
			resolve(res);
		};

		const onData = (chunk: Buffer | string) => {
			buffer += chunk.toString();
			let nl = buffer.indexOf("\n");
			while (nl !== -1) {
				const line = buffer.slice(0, nl);
				buffer = buffer.slice(nl + 1);
				const parsed = tryParseResponse(line);
				if (parsed && parsed.id === id) {
					settle(parsed);
					return;
				}
				nl = buffer.indexOf("\n");
			}
		};

		const onEnd = () => {
			settle({ id, error: "Parent closed response channel before answering." });
		};

		const abortListener = signal
			? () => settle({ id, error: "Aborted before parent responded." })
			: null;

		channel.on("data", onData);
		channel.on("end", onEnd);
		channel.on("close", onEnd);
		if (abortListener) {
			if (signal?.aborted) {
				queueMicrotask(() => settle({ id, error: "Aborted before parent responded." }));
				return;
			}
			signal!.addEventListener("abort", abortListener, { once: true });
		}

		process.stderr.write(encodeRequest({ id, questions }));
	});
}

/**
 * Full dispatch used by both the `question` tool itself and by the subagent
 * extension when bridging a child's request: refuse if non-interactive,
 * ask via `ctx.ui` if we have one, otherwise forward to our own parent via
 * the protocol if we're a subagent child.
 *
 * Returns `{ answers }` on success, `{ error, answers? }` on any kind of
 * failure (non-interactive, user dismissal, no path to a user).
 */
export async function dispatchAsk(
	ctx: { hasUI: boolean; ui: ExtensionUIContext },
	questions: QuestionItem[],
	signal: AbortSignal | undefined,
): Promise<{ answers?: string[]; error?: string }> {
	if (process.env.PI_NON_INTERACTIVE === "1") {
		return {
			error:
				"Non-interactive mode is active — questions are disabled. " +
				"Pick the approach you think is best and state your assumption.",
		};
	}

	// Lid closed → no interactive UI is possible (screen is off).
	// Refuse with a clear error so the model picks a default.
	if (isLidClosed()) {
		return {
			error:
				"Lid is closed — interactive questions are unavailable. " +
				"Open the lid or pick a sensible default and proceed.",
		};
	}

	if (ctx.hasUI) {
		return askLocally(ctx.ui, questions, signal);
	}
	if (process.env.PI_SUBAGENT_CHILD === "1") {
		const res = await askViaBridge(questions, signal);
		return { answers: res.answers, error: res.error };
	}
	return { error: "No interactive UI available — cannot ask the user." };
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "question",
		label: "question",
		description:
			"Ask the user a single question and wait for their answer. " +
			"Call this whenever you need information from the user, or when the user explicitly asks you to ask them something. " +
			"Pass `question` (the text the user sees) and optionally `options` (a list of choices); " +
			"with `options`, an 'Other…' entry is appended automatically so the user can still type a custom answer. " +
			"To ask several things, call this tool multiple times in sequence.",
		parameters: Params,

		async execute(_toolCallId, { question, options }, signal, _onUpdate, ctx: ExtensionContext): Promise<AgentToolResult<unknown>> {
			const item: QuestionItem = { question, ...(options ? { options } : {}) };
			const out = await dispatchAsk(ctx, [item], signal);
			return buildResult(item, out);
		},

		renderCall(args, theme) {
			const q = typeof args?.question === "string" ? args.question : "...";
			const preview = q.length > 50 ? `${q.slice(0, 47)}...` : q;
			return new Text(
				`${theme.fg("toolTitle", theme.bold("question"))} ${theme.fg("accent", preview)}`,
				0,
				0,
			);
		},
	});
}

// ---------------------------------------------------------------------------
// Result formatting
// ---------------------------------------------------------------------------

function buildResult(
	_item: QuestionItem,
	out: { answers?: string[]; error?: string },
) {
	if (out.error) {
		return {
			content: [
				{
					type: "text",
					text:
						`${out.error} ` +
						`Proceed with a reasonable default and note the assumption, or ask a more specific question.`,
				},
			],
			details: undefined,
		};
	}
	const answer = out.answers?.[0] ?? "";
	return {
		content: [{ type: "text", text: `User answered: ${answer}` }],
		details: undefined,
	};
}
