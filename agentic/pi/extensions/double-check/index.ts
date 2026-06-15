/**
 * Nudge the agent to keep going when it stops mid-task.
 *
 * Agents — especially local ones — sometimes end a turn without actually
 * finishing: the loop stops right after a tool call it never acted on, or after
 * a bare thinking block with no concluding response. A genuine turn ends with a
 * real text answer; those content-less stops are the failure this catches.
 *
 * So the nudge is *conditional* on the shape of the final message. When the
 * orchestrator's loop ends with a regular text response, the agent meant to
 * stop — we leave it alone. When it ends on a tool call or a thinking block
 * with no concluding text, we inject one hidden prompt asking the agent to
 * re-read the request, verify nothing was missed, and finish the job. The agent
 * gets exactly one extra shot per user turn.
 *
 * Two things stay out of the transcript so the meta-exchange is invisible:
 *
 *   1. The double-check prompt itself is a `display: false` custom message —
 *      it reaches the LLM (custom messages convert to a user turn in context)
 *      but is never rendered in the chat.
 *
 *   2. If the agent decides nothing was missed it replies with the single word
 *      `done`. We blank that assistant message on `message_end` so it renders
 *      as nothing. Any *real* follow-up work the agent does (tool calls, a
 *      substantive summary) is left fully visible — only a bare "done" is
 *      hidden.
 *
 * Loop safety is the whole game here, since the nudge triggers a fresh agent
 * loop from inside `agent_end`:
 *
 *   - `armed` is set on `agent_start` for a genuine run and consumed on the
 *     first `agent_end`, so each user turn is checked at most once.
 *   - `checking` is true for the lifetime of the injected loop. Its own
 *     `agent_start` is ignored (won't re-arm) and its own `agent_end` just
 *     clears the flag and returns (won't re-inject).
 *
 * Orchestrator-only: a subagent reports back to its parent rather than going
 * idle in front of the user, so a self-nudge there is just wasted tokens — and
 * the parent's own run already brackets the subagent's work.
 *
 * Non-interactive mode: when Pi runs with `-p` (print/headless mode), there
 * is no UI and the double-check nudge is suppressed to avoid unwanted delay
 * in scripted / CI contexts.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * Minimal structural view of an agent message. We avoid importing the full
 * `AgentMessage` type from `@earendil-works/pi-agent-core` (it doesn't resolve
 * cleanly here — see the `subagent` extension's `@ts-expect-error` dance) and
 * only read the few fields we actually touch.
 */
interface MessageLike {
	role?: string;
	stopReason?: string;
	content?: string | Array<{ type?: string; text?: string }>;
}

const CUSTOM_TYPE = "double-check:nudge";

/** The hidden nudge. Kept terse — it's prepended to a full context window. */
const PROMPT =
	"Your last turn ended on a tool call or a thinking step rather than a finished response — " +
	"it looks like you may have stopped mid-task. Re-read the original request and check your " +
	"work against it: did you finish everything that was asked, or stop early? Look for " +
	"unfinished steps, pending tool calls you never acted on, checks or tests you meant to run, " +
	"and claims you haven't verified.\n\n" +
	"If anything is missing or incomplete, finish it now without asking. If — and only if — the " +
	"work is genuinely complete, reply with exactly the single word `done` and nothing else.\n\n" +
	"(This is an automated self-check, not a message from the user.)";

/** True while a genuine user run is in flight and still owes a double-check. */
let armed = false;
/** True for the entire lifetime of the injected double-check loop. */
let checking = false;
/** User-facing kill switch for the session (`/double-check off`). Defaults on. */
let sessionEnabled = true;

/** Flatten an assistant message's text blocks into one string. */
function messageText(message: MessageLike): string {
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((c) => c?.type === "text" && typeof c.text === "string")
		.map((c) => c.text)
		.join("");
}

/** Is this assistant reply a bare "done" acknowledgement and nothing else? */
function isBareDone(message: MessageLike): boolean {
	const text = messageText(message).trim().toLowerCase().replace(/[.!]+$/, "");
	return text === "done" || text === "`done`";
}

/** The most recent assistant message in the loop's transcript, if any. */
function lastAssistant(messages: readonly MessageLike[]): MessageLike | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i]?.role === "assistant") return messages[i];
	}
	return undefined;
}

/**
 * Check if the message text mentions a bash command without actually calling
 * the bash tool. Common failure: agent writes "Let me run: `git status`" or
 * includes a shell code block, but never invokes the tool.
 */
function mentionsBashWithoutCalling(message: MessageLike): boolean {
	const text = messageText(message);
	if (!text) return false;

	// Check for bash tool call in content array.
	if (Array.isArray(message.content)) {
		const hasBashCall = message.content.some(
			(c) => c?.type === "toolCall" && typeof c.text === "string" && c.text.includes("\"tool\":\"bash\""),
		);
		if (hasBashCall) return false; // Already called bash properly.
	}

	// Patterns that suggest the agent intended to run a command.
	const bashPatterns = [
		/```\s*(?:shell|bash|sh|console|terminal|cmd)/i, // Code block with shell hint
		/```\n[\s]*\$\s+/m, // Code block starting with $ prompt
		/```\n[\s]*(?:git|npm|pip|yarn|pnpm|docker|kubectl|curl|wget|ssh|scp|rsync|make|cargo|go|python|node)\s+/m, // Common commands at start of code block
		/`(?:git|npm|pip|yarn|pnpm|docker|kubectl|curl|wget|ssh|scp|rsync|make|cargo|go|python|node)\s+[^`]+`/, // Inline code with command
		/(?:run|execute|call|invoke)\s+(?:the\s+)?(?:command|bash|shell|terminal)/i, // "run the command"
		/(?:let\s+(?:me|us)\s+(?:run|execute|call))\s*[`:]?/i, // "Let me run:"
	];

	if (bashPatterns.some((pattern) => pattern.test(text))) return true;

	// Case: the entire message is a bare shell command
	// (agent starts typing a command but forgets to call the bash tool).
	// Detect when the message looks like a shell command with no tool call.
	const trimmed = text.trim();
	if (trimmed && !trimmed.includes("\n") && trimmed.length < 200) {
		// Single-line, short text: likely a bare command if it starts with
		// a common command name or shell builtin.
		const commandStart = /^(?:\$\s+)?(?:(?:git|npm|pip|yarn|pnpm|docker|kubectl|curl|wget|ssh|scp|rsync|make|cargo|go|python|node|ls|cd|cat|grep|find|awk|sed|echo|mkdir|rm|cp|mv|chmod|chown|ps|top|htop|kill|pkill|killall|systemctl|journalctl|tail|head|less|more|wc|sort|uniq|cut|tr|tee|xargs|which|whereis|locate|df|du|free|uname|hostname|whoami|id|pwd|bash|sh|zsh|fish|tmux|screen|vim|vi|nano|emacs|mvim|code|gcc|clang|g\+\+|rustc|javac|dotnet|swiftc|rubyc|perlc|lua|php|ruby|perl|tsc|webpack|rollup|vite|esbuild|pnpm|bun|deno)\b)/i;
		if (commandStart.test(trimmed)) return true;
	}

	return false;
}

/**
 * Should we nudge? Only when the run ended *mid-task* — i.e. the final
 * assistant message is not a regular text response. That means it ended on a
 * tool call it never acted on, or on a thinking block with no concluding text.
 * A real text answer (the agent deliberately wrapping up) is left alone, as are
 * errored / user-aborted runs and runs with no assistant output at all.
 */
function endedMidTask(messages: readonly MessageLike[]): boolean {
	const m = lastAssistant(messages);
	if (!m) return false;
	if (m.stopReason === "error" || m.stopReason === "aborted") return false;

	const content = m.content;
	if (typeof content === "string") {
		// Plain-text final message → regular response, no nudge.
		return content.trim().length === 0;
	}
	if (!Array.isArray(content)) return true;

	const endedOnToolCall = content.some((c) => c?.type === "toolCall");
	const hasConcludingText = content.some((c) => c?.type === "text" && (c.text ?? "").trim().length > 0);

	// Also nudge if the agent mentioned a bash command but didn't call the tool.
	if (mentionsBashWithoutCalling(m)) return true;

	return endedOnToolCall || !hasConcludingText;
}

export default function (pi: ExtensionAPI) {
	// Subagents report back to the parent instead of idling in front of the
	// user; the parent's run already covers their work.
	if (process.env.PI_SUBAGENT_CHILD === "1") return;

	// In non-interactive / print mode (pi -p "..."), there's no UI and the
	// double-check nudge would just add unwanted delay. Gate on ctx.hasUI.
	let hasUI = false;
	pi.on("session_start", (_event, ctx) => {
		hasUI = ctx.hasUI;
	});

	// Arm on the start of a genuine run; the injected loop's own start is
	// skipped so it can never re-arm itself.
	pi.on("agent_start", async () => {
		if (!checking) armed = true;
	});

	pi.on("agent_end", async (event, ctx: ExtensionContext) => {
		// End of the injected loop: clear the flag and stop. Never re-inject.
		if (checking) {
			checking = false;
			return;
		}

		// Only the first end of a genuine run is eligible, and only once.
		if (!armed) return;
		armed = false;

		if (!sessionEnabled) return;
		if (!hasUI) return;
		// Only nudge when the run stopped mid-task (ended on a tool call or a
		// bare thinking block), not when it gave a real answer.
		if (!endedMidTask((event.messages ?? []) as MessageLike[])) return;

		// Enter the double-check loop. Set the flag now so the injected loop's
		// agent_start (which fires before the deferred send completes) is
		// recognised and doesn't re-arm.
		checking = true;

		// Defer the trigger so the current agent_end fully settles and the
		// session is idle before we start a fresh loop from underneath it.
		setImmediate(() => {
			if (!ctx.isIdle()) {
				checking = false;
				return;
			}
			pi.sendMessage(
				{ customType: CUSTOM_TYPE, content: PROMPT, display: false },
				{ triggerTurn: true },
			);
		});
	});

	// Suppress a bare "done" reply so the self-check leaves no trace. Real
	// follow-up work (anything that isn't just "done") is left untouched.
	pi.on("message_end", async (event) => {
		if (!checking) return;
		const message = event.message as MessageLike;
		if (message.role !== "assistant") return;
		if (!isBareDone(message)) return;
		// Keep the assistant role (required) but blank the text so it renders as
		// nothing — the "done" never reaches the chat.
		return { message: { ...event.message, content: [{ type: "text", text: "" }] } };
	});

	pi.registerCommand("double-check", {
		description: "Self-review-before-idle control: on | off | status.",
		async handler(args, _ctx) {
			const arg = args.trim().toLowerCase();
			if (arg === "off") {
				sessionEnabled = false;
			} else if (arg === "on") {
				sessionEnabled = true;
			} else if (arg !== "" && arg !== "status") {
				pi.sendMessage({
					customType: "double-check:error",
					content: "Usage: /double-check [on|off|status]",
					display: true,
				});
				return;
			}

			pi.sendMessage({
				customType: "double-check:status",
				content: sessionEnabled
					? "Double-check: armed — the agent gets one nudge to continue if it stops mid-task."
					: "Double-check: off for this session (`/double-check on` to re-arm).",
				display: true,
			});
		},
	});
}
