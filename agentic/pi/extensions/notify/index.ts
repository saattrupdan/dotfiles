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
 *    (rate limits, Codex overloads, tool timeouts, network errors, Node version mismatches)
 *    that Pi automatically recovers from.
 *  - Notifications fire only on `agent_end`, not on intermediate `turn_end`
 *    events within multi-step workflows (e.g., planner → builders → reviewer).
 *  - Notifications are also suppressed for extension-injected retry loops
 *    (e.g., rate-limit-retry's 429 retry turns, double-check's nudge turns),
 *    detected by checking for their injected user prompts.
 *
 * The notification reaches the user even when the terminal is not focused
 * (that's the whole point — macOS surfaces it system-wide). In iTerm2, the
 * terminal-notifier helper makes alerts clickable: a click runs AppleScript
 * that reveals the originating window, tab, and pane. Alerts are suppressed
 * when that iTerm2 pane is already active and iTerm2 is frontmost. No
 * notification is sent outside iTerm2 or if terminal-notifier is unavailable.
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

function getSessionName(): string {
	if (!sessionManager) return "";
	try {
		return sessionManager.getSessionName() || "";
	} catch {
		return "";
	}
}

function quoteForShell(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

function isOriginatingITermPaneFocused(sessionID: string, callback: (focused: boolean) => void): void {
	const script = `
		on run argv
			set targetID to item 1 of argv
			tell application "System Events"
				if not (exists application process "iTerm2") then return "false"
				if not frontmost of application process "iTerm2" then return "false"
			end tell
			tell application "iTerm2"
				try
					if id of current session of current window is targetID then return "true"
				end try
			end tell
			return "false"
		end run
	`.trim();

	let settled = false;
	let output = "";
	const finish = (focused: boolean) => {
		if (settled) return;
		settled = true;
		callback(focused);
	};

	try {
		const p = spawn("/usr/bin/osascript", ["-e", script, sessionID], {
			stdio: ["ignore", "pipe", "ignore"],
		});
		const timeout = setTimeout(() => {
			p.kill();
			finish(false);
		}, 1_000);
		p.stdout?.setEncoding("utf8");
		p.stdout?.on("data", (chunk: string) => {
			output += chunk;
		});
		p.on("error", () => {
			clearTimeout(timeout);
			finish(false);
		});
		p.on("close", (code) => {
			clearTimeout(timeout);
			finish(code === 0 && output.trim() === "true");
		});
	} catch {
		finish(false);
	}
}

function notifyViaITerm(title: string, body: string, sound: string): void {
	if (process.env.TERM_PROGRAM !== "iTerm.app") return;
	const rawSessionID = process.env.ITERM_SESSION_ID;
	if (!rawSessionID) return;
	const sessionID = rawSessionID.slice(rawSessionID.indexOf(":") + 1);

	const focusScript = `
		on run argv
			set targetID to item 1 of argv
			tell application "iTerm2"
				repeat with aWindow in windows
					repeat with aTab in tabs of aWindow
						repeat with aSession in sessions of aTab
							if id of aSession is targetID then
								activate
								select aTab
								select aSession
								-- Selecting the window last gives it keyboard focus.
								-- Selecting a session alone only activates its pane within the tab.
								select aWindow
								return
							end if
						end repeat
					end repeat
				end repeat
			end tell
		end run
	`.trim();
	const clickCommand = `/usr/bin/osascript -e ${quoteForShell(focusScript)} ${quoteForShell(sessionID)}`;

	const sendNotification = () => {
		try {
			// terminal-notifier treats leading JSON/quote/bracket characters as
			// argument syntax unless escaped (e.g. {"detail":"Rate limit exceeded"}).
			const message = /^[{[('"]/.test(body) ? `\\${body}` : body;
			const p = spawn(
				"terminal-notifier",
				["-title", title, "-message", message, "-sound", sound, "-execute", clickCommand],
				{ stdio: "ignore", detached: true },
			);
			p.on("error", () => {});
			p.unref();
		} catch {
			// Best-effort: don't fail the agent when terminal-notifier is unavailable.
		}
	};

	// Treat the focus check as best-effort. If AppleScript fails or times out,
	// show the notification rather than risk silently losing an alert.
	isOriginatingITermPaneFocused(sessionID, (focused) => {
		if (!focused) sendNotification();
	});
}

function notify(title: string, body: string, sound: string): void {
	if (!IS_MACOS) return;
	if (!hasUI) return;
	if (process.env.TERM_PROGRAM !== "iTerm.app" || !process.env.ITERM_SESSION_ID) return;
	const now = Date.now();
	if (now - lastNotifyAt < MIN_GAP_MS) return;
	lastNotifyAt = now;
	// Prefix the title with the session name if available (format: "Session — Title")
	const name = getSessionName();
	const fullTitle = name ? `${name} — ${title}` : title;
	notifyViaITerm(fullTitle, body, sound);
}

function truncate(s: string, max = 120): string {
	const clean = s.replace(/\s+/g, " ").trim();
	return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function isInjectedContinuationPrompt(text: string): boolean {
	return (
		text.startsWith("you hit a rate limit") ||
		text.includes("http 429") ||
		text.startsWith("your last turn ended on a tool call") ||
		text.startsWith("stop — this tool call was deliberately blocked") ||
		text.includes("the original tool call was blocked once") ||
		text.includes("retry the exact original tool call now") ||
		text.startsWith("re-reading the same path won't show more") ||
		text.startsWith("you already have the body of") ||
		(text.startsWith("you just called `") && text.includes("with identical arguments")) ||
		text.startsWith("alternating loop detected:")
	);
}

function isRetryableBlockedAbort(stopReason: string | undefined, errorMessage: string | undefined): boolean {
	if (stopReason !== "aborted") return false;
	const msg = errorMessage?.toLowerCase() ?? "";
	return (
		msg.length === 0 ||
		msg === "operation aborted" ||
		msg.includes("block") ||
		msg.includes("tool call")
	);
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

		// Skip notifications for extension-injected retry/nudge/block loops.
		// These are prompts inserted by extensions so the agent can continue on
		// its own; notifying the user would incorrectly suggest Pi needs help.
		// This is deliberate text-based coupling to avoid requiring exports or
		// a protocol between extensions.
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
			if (isInjectedContinuationPrompt(text))
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
			if (isRetryableBlockedAbort(stopReason, errorMessage)) return;

			// Skip notifications for transient/retryable errors:
			// - "terminated" = Node.js version mismatch (Node 26 undici bug), auto-recovers
			// - rate-limit and Codex overload errors, Pi retries automatically
			// - tool_call_timeout = tool call timed out, Pi retries automatically
			// - http_error = transient network errors, Pi retries automatically
			// Only notify for blocking errors where no retries are attempted.
			const msg = errorMessage?.toLowerCase() ?? "";
			if (
				msg === "terminated" ||
				msg.includes("429") ||
				msg.includes("rate limit") ||
				msg.includes("rate-limited") ||
				msg.includes("rate_limited") ||
				msg.includes("too many requests") ||
				msg.includes("our servers are currently overloaded. please try again later.") ||
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
