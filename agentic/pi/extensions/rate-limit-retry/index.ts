/**
 * Quiet, unbounded recovery for rate-limited, overloaded, and transiently disconnected model requests.
 *
 * Pi renders every failed assistant message and reports when its built-in retry
 * budget expires. Mask only empty, retryable responses in message_end, then
 * continue at turn_end with an invisible context message. This keeps attempts
 * in one agent run. Partial responses and unrelated errors keep Pi's normal path.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const WORKING_OVERRIDE = "thinking-status:override";
export const RETRY_STATE_EVENT = "rate-limit-retry:state";
const CUSTOM_TYPE = "rate-limit-retry:continue";
const PROMPT = "The previous model request failed transiently. Resume the user's task.";
const BASE_DELAY_MS = 2_000;
const MAX_DELAY_MS = 60_000;

export function isTransientWebSocketClosure(error: string | undefined): boolean {
	// 1000 is a clean close without a completed response; 1006 is a dropped connection.
	// Do not quietly retry policy, auth, or message-too-big close codes.
	return /(?:^|:\s*)websocket closed (?:1000|1006)\b/i.test(error ?? "");
}

function isRetryableError(error: string | undefined): boolean {
	const text = (error ?? "").toLowerCase();
	return isTransientWebSocketClosure(error) || /\b429\b/.test(text) ||
		/rate[ _-]?limit/.test(text) || text.includes("too many requests") ||
		/\b(?:servers?|service) (?:is|are) (?:currently )?overloaded\b/.test(text) ||
		/\b(econnreset|econnrefused|etimedout|enotfound|eai_again|enetunreach|ehostunreach)\b/.test(text) ||
		/\b(fetch failed|network error|socket hang up|connection (?:reset|refused|timed out)|no route to host|temporary failure in name resolution)\b/.test(text);
}

function hasNoOutput(content: ReadonlyArray<{ type: string; text?: string; thinking?: string }>): boolean {
	return content.every((block) =>
		(block.type === "thinking" && !block.thinking) || (block.type === "text" && !block.text));
}

function retryLabel(attempt: number): string {
	if (attempt === 1) return "Retrying...";
	const suffix = attempt % 100 >= 11 && attempt % 100 <= 13
		? "th"
		: attempt % 10 === 1 ? "st" : attempt % 10 === 2 ? "nd" : attempt % 10 === 3 ? "rd" : "th";
	return `Retrying for the ${attempt}${suffix} time...`;
}

function waitForRetry(delayMs: number, signal: AbortSignal | undefined): Promise<boolean> {
	if (signal?.aborted) return Promise.resolve(false);
	return new Promise((resolve) => {
		const finish = (completed: boolean) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			resolve(completed);
		};
		const onAbort = () => finish(false);
		const timer = setTimeout(() => finish(true), delayMs);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

export default function (pi: ExtensionAPI, wait = waitForRetry) {
	let sessionEnabled = true;
	let pendingRetry = false;
	let retryCount = 0;

	const clearRetry = () => {
		pendingRetry = false;
		retryCount = 0;
		pi.events.emit(WORKING_OVERRIDE, { label: undefined });
		pi.events.emit(RETRY_STATE_EVENT, { retrying: false });
	};

	pi.on("session_start", () => clearRetry());

	pi.on("message_start", (event) => {
		// Some providers emit no stream-start event on a 429. Pi then starts
		// the assistant component with the *final error* before message_end.
		// This is a shallow copy of the final message, safe to mask for the UI.
		const message = event.message;
		if (
			sessionEnabled && message.role === "assistant" &&
			message.stopReason === "error" && isRetryableError(message.errorMessage) &&
			hasNoOutput(message.content)
		) {
			message.stopReason = "pending";
			message.errorMessage = undefined;
		}
	});

	pi.on("message_update", (event) => {
		if (retryCount === 0 || event.message.role !== "assistant") return;
		// A bare stream start can still be followed immediately by another 429.
		// Restore the normal phase label once actual output starts arriving.
		const type = event.assistantMessageEvent.type;
		if (type === "thinking_delta" || type === "text_delta" || type === "toolcall_delta") clearRetry();
	});

	pi.on("message_end", (event) => {
		const message = event.message;
		if (message.role !== "assistant") return;
		if (
			!sessionEnabled || message.stopReason !== "error" ||
			!isRetryableError(message.errorMessage) || !hasNoOutput(message.content)
		) {
			// Only empty retryable responses are masked. Leave other responses
			// untouched, but restore the working label if recovery has ended.
			if (retryCount > 0) clearRetry();
			return;
		}

		pendingRetry = true;
		retryCount++;
		pi.events.emit(RETRY_STATE_EVENT, { retrying: true });
		// The working spinner is shared with thinking-status; overriding it
		// replaces "Thinking..." rather than adding a separate footer item.
		pi.events.emit(WORKING_OVERRIDE, { label: retryLabel(retryCount) });
		// The replacement is applied in-place before the TUI receives message_end
		// and before Pi decides whether to use its three-attempt retry policy.
		return { message: { ...message, content: [], stopReason: "stop" as const, errorMessage: undefined } };
	});

	pi.on("turn_end", async (_event, ctx) => {
		if (!pendingRetry || !sessionEnabled) return;
		pendingRetry = false;
		const delay = Math.min(BASE_DELAY_MS * 2 ** Math.min(retryCount - 1, 20), MAX_DELAY_MS);
		if (!(await wait(delay, ctx.signal)) || !sessionEnabled) {
			clearRetry();
			return;
		}
		// A hidden user-context message makes the boundary runnable without
		// printing a prompt or starting a separate agent run. Only retryable
		// attempts get this continuation; all other outcomes settle normally.
		return {
			entries: [{ type: "custom_message" as const, customType: CUSTOM_TYPE, content: PROMPT, display: false }],
			continue: true,
		};
	});

	pi.registerCommand("rate-limit-retry", {
		description: "Toggle quiet retry of rate limits, server overloads, and transient model network errors",
		handler: async (args) => {
			const arg = args.trim().toLowerCase();
			if (arg === "off") {
				sessionEnabled = false;
				clearRetry();
			} else if (arg === "on") {
				sessionEnabled = true;
			} else if (arg !== "" && arg !== "status") {
				pi.sendMessage({
					customType: "rate-limit-retry:error",
					content: "Usage: /rate-limit-retry [on|off|status]",
					display: true,
				});
				return;
			}

			pi.sendMessage({
				customType: "rate-limit-retry:status",
				content: sessionEnabled
					? "Model retry: armed — 429, server overload, and transient network errors retry quietly until success."
					: "Model retry: off for this session (`/rate-limit-retry on` to re-enable).",
				display: true,
			});
		},
	});
}
