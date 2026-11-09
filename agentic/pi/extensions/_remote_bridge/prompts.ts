/** One prompt promise, two answer sources, one non-resetting deadline. */
import { randomUUID } from "node:crypto";
import type { QuestionItem } from "../_question_protocol/protocol.ts";
export interface RemotePrompt {
	id: string;
	title: string;
	options?: string[];
	multiSelect?: boolean;
	deadline: number;
	state: "pending" | "resolved" | "expired";
}
type Outcome = { answer?: string; error?: string };
interface Adapter {
	publish: (prompt: RemotePrompt) => void;
	expire: (prompt: RemotePrompt) => void;
}
interface Pending {
	prompt: RemotePrompt;
	resolve: (answer: string) => void;
	cancel: () => void;
}
const root = globalThis as typeof globalThis & {
	__piRemotePrompts?: { adapter?: Adapter; pending?: Pending };
};
const state = (root.__piRemotePrompts ??= {});
export const currentPrompt = () => state.pending?.prompt;
export const remotePromptsEnabled = () => Boolean(state.adapter);
export function configurePrompts(adapter?: Adapter) {
	state.pending?.cancel();
	state.adapter = adapter;
}
export function respondPrompt(id: string, answer: unknown) {
	const pending = state.pending;
	if (!pending || pending.prompt.id !== id || pending.prompt.deadline <= Date.now())
		throw new Error("prompt_expired");
	const prompt = pending.prompt;
	if (prompt.multiSelect) {
		if (
			!Array.isArray(answer) ||
			!answer.length ||
			!answer.every((a) => typeof a === "string" && prompt.options?.includes(a))
		)
			throw new Error("invalid_answer");
		pending.resolve(answer.join(", "));
	} else {
		if (typeof answer !== "string" || !answer.trim() || answer.length > 20000)
			throw new Error("invalid_answer");
		pending.resolve(answer.trim());
	}
}
export function askRemote(
	item: QuestionItem,
	local: ((signal: AbortSignal) => Promise<Outcome>) | undefined,
	signal?: AbortSignal,
	timeoutMs = 30 * 60 * 1000,
): Promise<Outcome> {
	if (!state.adapter) throw new Error("Remote prompt adapter unavailable");
	if (state.pending) throw new Error("Interactive queue violation");
	return new Promise((resolve) => {
		const controller = new AbortController();
		const adapter = state.adapter!;
		let settled = false;
		const prompt: RemotePrompt = {
			id: randomUUID(),
			title: item.question,
			options: item.options,
			multiSelect: item.multiSelect,
			deadline: Date.now() + timeoutMs,
			state: "pending",
		};
		const finish = (out: Outcome, expired = false) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
			controller.abort();
			state.pending = undefined;
			prompt.state = expired ? "expired" : "resolved";
			adapter.publish(prompt);
			if (expired) adapter.expire(prompt);
			resolve(out);
		};
		const abort = () => finish({ error: "aborted" });
		const timer = setTimeout(() => finish({ error: "answer needed" }, true), timeoutMs);
		state.pending = { prompt, resolve: (answer) => finish({ answer }), cancel: abort };
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) {
			abort();
			return;
		}
		adapter.publish(prompt);
		if (local)
			void local(controller.signal)
				.then((out) => {
					if (out.answer || out.error === "dismissed") finish(out);
					else if (out.error === "aborted" && signal?.aborted) abort();
				})
				.catch(() => {});
	});
}
