/**
 * `question` tool.
 */

import * as crypto from "node:crypto";
import * as net from "node:net";

import type { AgentToolResult, ExtensionAPI, ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { Text, type Theme } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import { isLidClosed } from "../_lid_state/lid.ts";

import {
	encodeRequest,
	tryParseResponse,
	type QuestionItem,
	type QuestionResponse,
} from "../_question_protocol/protocol.ts";

const OTHER_LABEL = "Other (type your own)…";

// ANSI color codes
const colors = {
	reset: "\x1b[0m",
	bold: "\x1b[1m",
	dim: "\x1b[2m",
	orange: "\x1b[38;5;208m",
	green: "\x1b[32m",
	cyan: "\x1b[36m",
};

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
	multiSelect: Type.Optional(
		Type.Boolean({
			description:
				"If true and options are provided, the user can select multiple options (presented as a checklist) and submit them together. Default is false (single selection).",
			default: false,
		}),
	),
});

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
		if (item.options && item.options.length > 0 && item.multiSelect) {
			const selected = new Set<number>();
			return new Promise<AskOutcome>((resolve) => {
				let cursorIndex = 0;

				const unsubscribe = ui.onTerminalInput((data) => {
					const key = data;
					// Down Arrow
					if (key === "\x1b[B") {
						cursorIndex = (cursorIndex + 1) % item.options.length;
						render();
						return { consume: true };
					}
					// Up Arrow
					if (key === "\x1b[A") {
						cursorIndex = (cursorIndex - 1 + item.options.length) % item.options.length;
						render();
						return { consume: true };
					}
					// Space - toggle selection
					if (key === " ") {
						if (selected.has(cursorIndex)) {
							selected.delete(cursorIndex);
						} else {
							selected.add(cursorIndex);
						}
						render();
						return { consume: true };
					}
					// Enter - submit
					if (key === "\r" || key === "\n") {
						unsubscribe();
						if (selected.size === 0) {
							resolve({ error: "empty" });
						} else {
							const answers = Array.from(selected).map((i) => item.options[i]);
							resolve({ answer: answers.join(", ") });
						}
						return { consume: true };
					}
					// Esc - dismiss
					if (key === "\x1b") {
						unsubscribe();
						resolve({ error: "dismissed" });
						return { consume: true };
					}
					return { consume: true };
				});

				if (signal) {
					signal.addEventListener("abort", () => {
						unsubscribe();
						resolve({ error: "aborted" });
					}, { once: true });
				}

				const render = () => {
					const lines: string[] = [];
					lines.push(colors.orange + colors.bold + title + colors.reset);
					lines.push("");
					for (let i = 0; i < item.options.length; i++) {
						const isSelected = selected.has(i);
						const isCursor = i === cursorIndex;
						const cursor = isCursor ? colors.orange + "→" + colors.reset : " ";
						const box = isSelected ? colors.green + "[✓]" + colors.reset : colors.dim + "[ ]" + colors.reset;
						const optionText = isCursor ? colors.orange + colors.bold + item.options[i] + colors.reset : item.options[i];
						lines.push(cursor + " " + box + " " + optionText);
					}
					lines.push("");
					lines.push(colors.dim + "↑↓ navigate · Space: toggle · Enter: submit · Esc: cancel" + colors.reset);
					ui.setWorkingMessage(lines.join("\n"));
				};

				render();
			});
		}

		if (item.options && item.options.length > 0) {
			const choices = [...item.options, OTHER_LABEL];
			const choice = await ui.select(title, choices, { signal });
			if (choice === undefined) return { error: "dismissed" };
			if (choice === OTHER_LABEL) {
				const typed = await ui.input(title, undefined, { signal });
				if (typed === undefined) return { error: "dismissed" };
				if (!typed.trim()) return { error: "empty" };
				return { answer: typed.trim() };
			}
			return { answer: choice };
		}

		const typed = await ui.input(title, undefined, { signal });
		if (typed === undefined) return { error: "dismissed" };
		if (!typed.trim()) return { error: "empty" };
		return { answer: typed.trim() };
	} catch (err) {
		return { error: "dialog failed: " + (err as Error).message };
	}
}

export async function askLocally(
	ui: ExtensionUIContext,
	questions: QuestionItem[],
	signal: AbortSignal | undefined,
): Promise<{ answers?: string[]; error?: string }> {
	const total = questions.length;
	const answers: string[] = [];
	for (let i = 0; i < total; i++) {
		const item = questions[i];
		const prefix = total > 1 ? "(" + (i + 1) + "/" + total + ") " : "";
		const title = prefix + item.question;
		const outcome = await askOneLocally(ui, item, title, signal);
		if (outcome.error) {
			return { error: outcome.error === "dismissed" ? "User dismissed question." : outcome.error === "empty" ? "User submitted empty answer." : outcome.error, answers };
		}
		answers.push(outcome.answer!);
	}
	return { answers };
}

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

function askViaBridge(
	questions: QuestionItem[],
	signal: AbortSignal | undefined,
): Promise<QuestionResponse> {
	return new Promise((resolve) => {
		const id = crypto.randomBytes(6).toString("hex");
		const channel = getResponseStream();
		if (!channel) {
			resolve({ id, error: "No question response channel from parent." });
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
			settle({ id, error: "Parent closed response channel." });
		};
		channel.on("data", onData);
		channel.on("end", onEnd);
		channel.on("close", onEnd);
		process.stderr.write(encodeRequest({ id, questions }));
	});
}

export async function dispatchAsk(
	ctx: { hasUI: boolean; ui: ExtensionUIContext },
	questions: QuestionItem[],
	signal: AbortSignal | undefined,
): Promise<{ answers?: string[]; error?: string }> {
	if (process.env.PI_NON_INTERACTIVE === "1") {
		return { error: "Non-interactive mode active — questions disabled." };
	}
	if (isLidClosed()) {
		return { error: "Lid closed — interactive questions unavailable." };
	}
	if (ctx.hasUI) {
		return askLocally(ctx.ui, questions, signal);
	}
	if (process.env.PI_SUBAGENT_CHILD === "1") {
		const res = await askViaBridge(questions, signal);
		return { answers: res.answers, error: res.error };
	}
	return { error: "No interactive UI available." };
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "question",
		label: "question",
		description:
			"Ask the user a single question and wait for their answer. " +
			"Pass `question` and optionally `options` (list of choices with 'Other…' auto-appended). " +
			"Pass `multiSelect: true` for checkbox-list multi-select (↑↓ navigate, Space toggle, Enter submit).",
		parameters: Params,
		async execute(_toolCallId, { question, options, multiSelect }, signal, _onUpdate, ctx: ExtensionContext): Promise<AgentToolResult<unknown>> {
			const item: QuestionItem = { question, ...(options ? { options } : {}), ...(multiSelect ? { multiSelect } : {}) };
			const out = await dispatchAsk(ctx, [item], signal);
			return buildResult(item, out);
		},
		renderCall(args, theme) {
			const q = typeof args?.question === "string" ? args.question : "...";
			const preview = q.length > 50 ? q.slice(0, 47) + "..." : q;
			return new Text(theme.fg("toolTitle", theme.bold("question")) + " " + theme.fg("accent", preview), 0, 0);
		},
	});
}

function buildResult(item: QuestionItem, out: { answers?: string[]; error?: string }) {
	if (out.error) {
		return { content: [{ type: "text", text: out.error + " Proceed with a reasonable default." }], details: undefined };
	}
	const answer = out.answers?.[0] ?? "";
	return { content: [{ type: "question_response", answer, question: item.question, ...(item.options ? { options: item.options } : {}) }], details: undefined };
}
