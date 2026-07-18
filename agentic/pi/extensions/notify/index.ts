/**
 * Desktop notifications for attention-worthy agent events.
 *
 * Fires a macOS Notification Center alert (with a gentle sound) when the
 * orchestrator agent:
 *
 *  - asked the user a question (the `question` tool is about to run),
 *  - finished the entire workflow normally with no errors (agent loop ended,
 *    ready for next prompt),
 *  - failed or was aborted with a non-retryable error (last assistant message
 *    has stopReason "error" or "aborted").
 *
 * Note:
 *  - The "finished" notification is suppressed if any tool errors occurred
 *    during the turn, even if the agent recovered and finished anyway.
 *  - The "failed" notification is suppressed for transient/retryable errors
 *    (rate limits, tool timeouts, network errors, Node version mismatches)
 *    that Pi automatically recovers from.
 *  - Notifications fire only on `agent_end`, not on intermediate `turn_end`
 *    events within multi-step workflows (e.g., planner → builders → reviewer).
 *  - Notifications are also suppressed for extension-injected retry loops
 *    (e.g., rate-limit-retry's 429 retry turns, double-check's nudge turns),
 *    detected by checking for their injected user prompts.
 *
 * The notification reaches the user even when the terminal is not focused
 * (that's the whole point — macOS surfaces it system-wide). Sounds are
 * built-in macOS system sounds chosen to be brief and unobtrusive.
 *
 * Orchestrator-only: subagent processes never have a UI and their question
 * dialogs are bridged to the parent — the parent's own listeners already
 * see those, so subagent-side notifications would just duplicate noise.
 *
 * Non-interactive mode: when Pi runs with `-p` (print/headless mode), there
 * is no UI and notifications are suppressed to avoid unwanted noise in
 * scripted / CI contexts.
 *
 * macOS-only. On other platforms the extension loads but does nothing.
 */

import { spawn } from "node:child_process";
import * as os from "node:os";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const IS_MACOS = os.platform() === "darwin";

// Built-in /System/Library/Sounds/*.aiff names. All chosen to be short and
// gentle; Basso is the lowest-pitched of the bunch, used for failures.
const SOUND_FINISHED = "Glass";
const SOUND_QUESTION = "Tink";
const SOUND_FAILED = "Basso";

// Minimum gap between any two notifications. Cheap defence against
// back-to-back events (e.g. question dialog dismissed → agent_end fires
// immediately after the question notification) collapsing into one
// indistinguishable beep.
const MIN_GAP_MS = 400;

let lastNotifyAt = 0;
let hasUI = false;
let sessionManager: { getSessionName(): string | undefined } | undefined;

function escapeForAppleScript(s: string): string {
	return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function getSessionName(): string {
	if (!sessionManager) return "";
	try {
		return sessionManager.getSessionName() || "";
	} catch {
		return "";
	}
}

function notify(title: string, body: string, sound: string): void {
	if (!IS_MACOS) return;
	if (!hasUI) return;
	const now = Date.now();
	if (now - lastNotifyAt < MIN_GAP_MS) return;
	lastNotifyAt = now;
	// Prefix the title with the session name if available (format: "Session — Title")
	const name = getSessionName();
	const fullTitle = name ? `${name} — ${title}` : title;
	const script =
		`display notification "${escapeForAppleScript(body)}" ` +
		`with title "${escapeForAppleScript(fullTitle)}" ` +
		`sound name "${escapeForAppleScript(sound)}"`;
	try {
		const p = spawn("osascript", ["-e", script], { stdio: "ignore", detached: true });
		p.on("error", () => {});
		p.unref();
	} catch {
		// best-effort, never throw out of an event handler
	}
}

function truncate(s: string, max = 120): string {
	const clean = s.replace(/\s+/g, " ").trim();
	return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

export default function (pi: ExtensionAPI) {
	// Subagent children don't drive a UI; the orchestrator gets the events
	// that actually matter to the human.
	if (process.env.PI_SUBAGENT_CHILD === "1") return;
	if (!IS_MACOS) return;

	pi.on("session_start", (_event, ctx) => {
		// In non-interactive / print mode (pi -p "..."), there's no UI and
		// notifications would be unwanted noise. Gate on ctx.hasUI.
		hasUI = ctx.hasUI;
		sessionManager = ctx.sessionManager;
	});

	pi.on("tool_call", async (event) => {
		if (event.toolName !== "question") return;
		const input = event.input as { questions?: Array<{ question?: unknown }> } | undefined;
		const first = input?.questions?.[0]?.question;
		const preview = typeof first === "string" && first.length > 0 ? truncate(first) : "Pi needs your input.";
		notify("Pi has a question", preview, SOUND_QUESTION);
	});

	// Use agent_end to notify only when the entire agent loop finishes (ready for user input).
	// turn_end fires after every single turn, including intermediate turns in multi-step
	// workflows (e.g., planner → builders → reviewer), which causes excessive notifications.
	// agent_end fires when the agent is completely done and waiting for the next user prompt.
	//
	// Note: The session name is set by the conversation-name extension on session_start.
	// Even if it's async, getSessionName() reads from sessionManager state which is
	// available by the time agent_end fires.
	pi.on("agent_end", async (event) => {
		const msgs = event.messages ?? [];

		// Skip notifications for extension-injected retry/nudge loops.
		// Both rate-limit-retry and double-check inject hidden user messages
		// to trigger additional turns. We detect these by checking if the
		// most recent user message is an injected prompt.
		//
		// Coupling notes (text-based, not exported):
		// - rate-limit-retry: PROMPT = "You hit a rate limit (HTTP 429)..."
		//   → matches: text.startsWith("you hit a rate limit") || text.includes("http 429")
		// - double-check: PROMPT = "Your last turn ended on a tool call..."
		//   → matches: text.startsWith("your last turn ended on a tool call")
		//
		// If either extension changes its injected prompt text, update the
		// matching logic here. This is a deliberate text-based coupling to
		// avoid requiring exports or a protocol between extensions.
		let lastUserMsg: { role?: string; content?: string | Array<{ text?: string }> } | undefined;
		for (let i = msgs.length - 1; i >= 0; i--) {
			const msg = msgs[i] as { role?: string; content?: string | Array<{ text?: string }> };
			if (msg?.role === "user") {
				lastUserMsg = msg;
				break;
			}
		}
		if (lastUserMsg) {
			const content = Array.isArray(lastUserMsg.content)
				? lastUserMsg.content.map((b) => b.text ?? "").join("\n")
				: lastUserMsg.content ?? "";
			const text = typeof content === "string" ? content.toLowerCase() : "";
			if (text.startsWith("you hit a rate limit") || text.includes("http 429"))
				return;
			if (text.startsWith("your last turn ended on a tool call"))
				return;
			if (text.startsWith("stop — this tool call was deliberately blocked"))
				return;
			if (text.startsWith("↪ ") && (text.includes(" skill injected") || text.includes(" skills injected")))
				return;
		}

		// Walk from the end to find the most recent assistant message — tool
		// results may have been appended after it.
		let stopReason: string | undefined;
		let errorMessage: string | undefined;
		for (let i = msgs.length - 1; i >= 0; i--) {
			const m = msgs[i] as { role?: string; stopReason?: string; errorMessage?: string };
			if (m?.role === "assistant") {
				stopReason = m.stopReason;
				errorMessage = m.errorMessage;
				break;
			}
		}
		if (stopReason === "error" || stopReason === "aborted") {
			// Skip notifications for transient/retryable errors:
			// - "terminated" = Node.js version mismatch (Node 26 undici bug), auto-recovers
			// - 429 = rate limit, Pi retries automatically
			// - tool_call_timeout = tool call timed out, Pi retries automatically
			// - http_error = transient network errors, Pi retries automatically
			// Only notify for blocking errors where no retries are attempted.
			const msg = errorMessage?.toLowerCase() ?? "";
			if (
				msg === "terminated" ||
				msg.includes("429") ||
				msg.includes("tool_call_timeout") ||
				msg.includes("http_error")
			)
				return;
			const detail = errorMessage ? truncate(errorMessage) : stopReason;
			notify("Pi failed", detail, SOUND_FAILED);
		} else {
			// Only notify on success if no errors occurred during the turn.
			// Check for any tool results with isError: true — if the agent
			// recovered and finished anyway, skip the "finished" notification.
			const hadToolErrors = msgs.some((m) => {
				const toolMsg = m as { role?: string; isError?: boolean };
				return toolMsg?.role === "tool" && toolMsg.isError === true;
			});
			if (hadToolErrors) return;
			notify("Pi finished", "Ready for your next prompt.", SOUND_FINISHED);
		}
	});
}
