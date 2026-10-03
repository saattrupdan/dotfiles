/**
 * Quiet, unbounded rate-limit recovery for model requests.
 *
 * Pi renders every failed assistant message and reports when its built-in retry
 * budget expires. Mask only empty 429 responses in message_end, then continue
 * at turn_end with an invisible context message. This keeps the attempts in one
 * agent run, so git-worktree finalization only runs after an actual result.
 * Other errors and responses containing partial output keep Pi's normal path.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "rate-limit-retry";
const CUSTOM_TYPE = "rate-limit-retry:continue";
const PROMPT = "The previous model request was rate-limited. Resume the user's task.";
const BASE_DELAY_MS = 2_000;
const MAX_DELAY_MS = 60_000;

function isRateLimitError(error: string | undefined): boolean {
	const text = (error ?? "").toLowerCase();
	return /\b429\b/.test(text) || /rate[ _-]?limit/.test(text) || text.includes("too many requests");
}

function retryLabel(attempt: number): string {
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
	let pendingRateLimit = false;
	let retryCount = 0;

	const clearRetry = (ctx: ExtensionContext) => {
		pendingRateLimit = false;
		retryCount = 0;
		ctx.ui.setStatus(STATUS_KEY, undefined);
	};

	pi.on("session_start", (_event, ctx) => clearRetry(ctx));

	pi.on("message_start", (event) => {
		// Some providers emit no stream-start event on a 429. Pi then starts
		// the assistant component with the *final error* before message_end.
		// This is a shallow copy of the final message, safe to mask for the UI.
		const message = event.message;
		if (
			sessionEnabled && message.role === "assistant" &&
			message.stopReason === "error" && isRateLimitError(message.errorMessage) &&
			message.content.length === 0
		) {
			message.stopReason = "pending";
			message.errorMessage = undefined;
		}
	});

	pi.on("message_end", (event, ctx) => {
		const message = event.message;
		if (message.role !== "assistant") return;
		if (
			!sessionEnabled || message.stopReason !== "error" ||
			!isRateLimitError(message.errorMessage) || message.content.length > 0
		) {
			// Only an empty rate-limit response is masked. Leave other responses
			// untouched, but clear stale retry status if recovery has ended.
			if (retryCount > 0) clearRetry(ctx);
			return;
		}

		pendingRateLimit = true;
		retryCount++;
		ctx.ui.setStatus(STATUS_KEY, retryLabel(retryCount));
		// The replacement is applied in-place before the TUI receives message_end
		// and before Pi decides whether to use its three-attempt retry policy.
		return { message: { ...message, stopReason: "stop" as const, errorMessage: undefined } };
	});

	pi.on("turn_end", async (_event, ctx) => {
		if (!pendingRateLimit || !sessionEnabled) return;
		pendingRateLimit = false;
		const delay = Math.min(BASE_DELAY_MS * 2 ** Math.min(retryCount - 1, 20), MAX_DELAY_MS);
		if (!(await wait(delay, ctx.signal)) || !sessionEnabled) {
			clearRetry(ctx);
			return;
		}
		// A hidden user-context message makes the boundary runnable without
		// printing a prompt or starting a separate agent run. Only rate-limit
		// attempts get this continuation; all other outcomes settle normally.
		return {
			entries: [{ type: "custom_message" as const, customType: CUSTOM_TYPE, content: PROMPT, display: false }],
			continue: true,
		};
	});

	pi.registerCommand("rate-limit-retry", {
		description: "Toggle indefinite quiet 429 retry for this session",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (arg === "off") {
				sessionEnabled = false;
				clearRetry(ctx);
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
					? "Rate-limit retry: armed — 429 errors retry quietly until success."
					: "Rate-limit retry: off for this session (`/rate-limit-retry on` to re-enable).",
				display: true,
			});
		},
	});
}
