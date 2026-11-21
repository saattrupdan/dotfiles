import { questionRenderers } from "../_tool-display/renderers.ts";
import { markGuard } from "../_remote_bridge/guards.ts";
/**
 * `question` tool.
 */

import * as crypto from "node:crypto";
import * as net from "node:net";

import type { AgentToolResult, ExtensionAPI, ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";

import { Type } from "typebox";
import { Key, matchesKey, Text } from "@earendil-works/pi-tui";

import { isLidClosed } from "../_lid_state/lid.ts";
import { askRemote, remotePromptsEnabled } from "../_remote_bridge/prompts.ts";
import { interactiveQueue } from "../_interactive_queue/queue.ts";

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
			"The user-facing question to ask. Use this only for a material choice about user intent, " +
			"user-visible scope or behavior, meaningful constraints or risk, or permission for a " +
			"consequential action. Resolve routine technical choices and uncertainty from tool or " +
			"subagent output yourself; do not forward them to the user. Reframe any genuine question " +
			"in plain user terms, and make it specific and self-contained — the user only sees this " +
			"text, not your reasoning.",
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
	// QuestionItem.options is optional on the wire, but every branch below needs a
	// defined list to index into.
	const choiceList: string[] = item.options ?? [];
	try {
		if (choiceList.length > 0 && item.multiSelect) {
			if (signal?.aborted) return { error: "aborted" };
			const choices = [...choiceList, OTHER_LABEL];
			const indices = await ui.custom<number[] | undefined>((tui, _theme, _keys, done) => {
				const selected = new Set<number>();
				let cursor = 0;
				const abort = () => done(undefined);
				signal?.addEventListener("abort", abort, { once: true });
				if (signal?.aborted) abort();
				return {
					render(width: number) {
						const lines = [title, "", ...choices.map((choice, i) =>
							`${i === cursor ? "→" : " "} [${selected.has(i) ? "✓" : " "}] ${choice}`),
						"", "↑↓ navigate · Space: toggle · Enter: submit · Esc: cancel"];
						return new Text(lines.join("\n"), 1, 1).render(width);
					},
					invalidate() {},
					handleInput(data: string) {
						if (matchesKey(data, Key.up)) cursor = (cursor - 1 + choices.length) % choices.length;
						else if (matchesKey(data, Key.down)) cursor = (cursor + 1) % choices.length;
						else if (matchesKey(data, Key.space)) {
							if (selected.has(cursor)) selected.delete(cursor);
							else selected.add(cursor);
						} else if (matchesKey(data, Key.enter)) {
							done([...selected].sort((a, b) => a - b));
							return;
						} else if (matchesKey(data, Key.escape)) {
							done(undefined);
							return;
						}
						tui.requestRender();
					},
					dispose() { signal?.removeEventListener("abort", abort); },
				};
			});
			if (signal?.aborted) return { error: "aborted" };
			if (indices === undefined) return { error: "dismissed" };
			if (!indices.length) return { error: "empty" };
			const answers = indices.filter((i) => i < choiceList.length).map((i) => choiceList[i]);
			if (indices.includes(choiceList.length)) {
				const typed = await ui.input(title, undefined, { signal });
				if (typed === undefined) return { error: "dismissed" };
				if (!typed.trim()) return { error: "empty" };
				answers.push(typed.trim());
			}
			return { answer: answers.join(", ") };
		}

		if (choiceList.length > 0) {
			const choices = [...choiceList, OTHER_LABEL];
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
			signal?.removeEventListener("abort", onAbort);
			resolve(res);
		};
		// Without this the reply might never arrive (run aborted while the ask sat
		// in the queue), and because the ask holds the queue slot every later prompt
		// in the process would block behind it.
		const onAbort = () => settle({ id, error: "aborted" });
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
		if (signal) {
			if (signal.aborted) onAbort();
			else signal.addEventListener("abort", onAbort, { once: true });
		}
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
	if (remotePromptsEnabled()) {
		const answers: string[] = [];
		for (const item of questions) {
			const outcome = await interactiveQueue.run((interactionSignal) => askRemote(
				item,
				ctx.hasUI && !isLidClosed()
					? (localSignal) => askOneLocally(ctx.ui, item, item.question, localSignal)
					: undefined,
				interactionSignal,
			), signal);
			if (outcome.error) return { error: outcome.error };
			answers.push(outcome.answer!);
		}
		return { answers };
	}
	if (isLidClosed()) {
		return { error: "Lid closed — interactive questions unavailable." };
	}
	// Pi renders one extension prompt at a time: two asks opened together would
	// overwrite each other's selector, and the abandoned promise would hang. Take
	// the process-wide queue instead, so asks appear one after another. The queue
	// hands the operation its own signal, which fires if the caller aborts while
	// waiting or while prompting.
	const runQueued = async (
		ask: (interactionSignal: AbortSignal) => Promise<{ answers?: string[]; error?: string }>,
	): Promise<{ answers?: string[]; error?: string }> => {
		try {
			return await interactiveQueue.run((interactionSignal) => ask(interactionSignal), signal);
		} catch (err) {
			if ((err as Error)?.name === "AbortError") return { error: "aborted" };
			return { error: "question queue failed: " + (err as Error).message };
		}
	};

	if (ctx.hasUI) {
		return runQueued((interactionSignal) => askLocally(ctx.ui, questions, interactionSignal));
	}
	if (process.env.PI_SUBAGENT_CHILD === "1") {
		return runQueued(async (interactionSignal) => {
			const res = await askViaBridge(questions, interactionSignal);
			return { answers: res.answers, error: res.error };
		});
	}
	return { error: "No interactive UI available." };
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "question",
		label: "question",
		description:
			"Ask the user one material, user-level question and wait for their answer. Use this for " +
			"unresolved user intent, user-visible scope or behavior, meaningful constraints or risk, " +
			"or permission for a consequential action — not for routine implementation details or " +
			"uncertainty merely found in tool or subagent output. Reframe genuine technical " +
			"uncertainty in terms of its user-visible consequences. Calls are asked one at a time: " +
			"several question calls in one turn are queued and posed in order, never at once, so a " +
			"later call is only shown after the earlier one is answered. Pass `question` and optionally " +
			"`options` (list of choices with 'Other…' auto-appended). Pass `multiSelect: true` for " +
			"checkbox-list multi-select (↑↓ navigate, Space toggle, Enter submit).",
		parameters: Params,
		// Ask batches in order: the next question is posed once the current one is
		// answered, which is what makes back-to-back calls safe.
		executionMode: "sequential",
		async execute(_toolCallId, { question, options, multiSelect }, signal, _onUpdate, ctx: ExtensionContext): Promise<AgentToolResult<unknown>> {
			const item: QuestionItem = { question, options: options ?? [], ...(multiSelect ? { multiSelect } : {}) };
			const out = await dispatchAsk(ctx, [item], signal);
			return buildResult(item, out);
		},
		...questionRenderers,
	});

	markGuard("question");
}

function buildResult(item: QuestionItem, out: { answers?: string[]; error?: string }): AgentToolResult<unknown> {
	if (out.error) {
		return { content: [{ type: "text", text: out.error === "answer needed"
			? "Answer needed: the question expired without an answer. The run has been stopped."
			: out.error + " Proceed with a reasonable default." }], details: undefined };
	}
	const answer = out.answers?.[0] ?? "";
	return { content: [{ type: "text", text: answer }], details: undefined };
}
