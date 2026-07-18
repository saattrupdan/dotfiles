/**
 * Memory audit extension — two responsibilities:
 *
 * 1. Background memory audit (turn_end): spawns the memory-audit script to
 *    process new conversation lines and save memories. Throttled by a cooldown.
 *
 * 2. Trigger-based auto-injection: memories that declare `triggers:` in their
 *    frontmatter are injected when a trigger fires —
 *      • `startup`     injected once into the system prompt at session start
 *                      (hidden from UI, preserves prefix caching after turn 1);
 *      • `input`       pattern triggers matched against the user message;
 *      • `tool_call`   pattern triggers matched against the tool's arguments
 *                      *before* it runs — blocks the call once with the memory
 *                      as the reason, so the LLM reconsiders with context;
 *      • `tool_result` tool + pattern triggers matched against the tool output.
 *    A memory is injected at most once per session (deduped via a per-session
 *    file so it survives extension hot-reloads). Memories without triggers are
 *    never auto-injected.
 *
 * Non-interactive mode: when Pi runs with `-p` (print/headless mode), there
 * is no UI and all memory audit / injection is suppressed to avoid overhead
 * in scripted / CI contexts.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { writeFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import {
	type MemoryDoc,
	type Trigger,
	type TriggerContext,
	evaluateTrigger,
	loadTriggeredMemories,
} from "../_memory/triggers.ts";

const PI = join(process.env.HOME ?? "/Users/dansmart", ".pi", "agent");
const COOLDOWN_FILE = join(PI, "memories", ".audit-cooldown");
const AUDIT_SCRIPT = join(PI, "bin", "memory-audit");
const COOLDOWN_SEC = 300; // 5 minutes

// ---------------------------------------------------------------------------
// Background memory audit (turn_end)
// ---------------------------------------------------------------------------

function touchCooldown(): boolean {
	try {
		const now = Date.now();
		if (existsSync(COOLDOWN_FILE)) {
			const last = parseInt(readFileSync(COOLDOWN_FILE, "utf8").trim(), 10);
			if (!isNaN(last) && now - last < COOLDOWN_SEC * 1000) {
				return false;
			}
		}
		writeFileSync(COOLDOWN_FILE, String(now));
		return true;
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// Per-session dedup store — "at most once per session" for each memory.
// Persisted to disk so it survives extension hot-reloads within a session.
// ---------------------------------------------------------------------------

const INJECTED_DIR = join(PI, "memories", ".injected-slugs");

function injectedFile(sessionId: string): string {
	mkdirSync(INJECTED_DIR, { recursive: true });
	return join(INJECTED_DIR, sessionId + ".json");
}

function memKey(m: MemoryDoc): string {
	return `${m.scope}/${m.name}`;
}

// ---------------------------------------------------------------------------
// Injection formatting
// ---------------------------------------------------------------------------

function formatMemories(mems: MemoryDoc[], blocked = false): string {
	const lines = mems.map(
		(m) => `- \`${m.scope}/${m.name}\``,
	);
	const plural = mems.length > 1;
	const refEach = plural ? "each one" : "it";
	const memWord = plural ? "memories" : "memory";

	// Block path: the tool call was just cancelled, so the message has to be an
	// unambiguous order — read first, then retry — not the soft "you might want
	// to look at this" framing of the passive injection path. Earlier wording
	// hedged ("we might have blocked it"), which let the agent skip the read and
	// immediately retry the identical call.
	if (blocked) {
		return (
			`STOP — this tool call was deliberately blocked because ${plural ? "memories" : "a memory"} ` +
			`below applies to it and you have not read ${refEach} yet.\n\n` +
			`Do NOT retry this call as-is. Required steps, in order:\n` +
			`1. Call \`memory_read\` on ${refEach} listed below to load the full body ` +
			`(the name shown here is not enough to act on).\n` +
			`2. Change your approach so it honors the ${memWord}.\n` +
			`3. Only then issue the corrected tool call.\n\n` +
			`${lines.join("\n")}`
		);
	}

	return (
		`Relevant ${memWord} (auto-injected). Call \`memory_read\` on ${refEach} below before proceeding:\n\n` +
		`${lines.join("\n")}`
	);
}

export default function (pi: ExtensionAPI) {
	// In non-interactive / print mode (pi -p "..."), there's no UI and
	// background memory audit is unnecessary overhead.
	let hasUI = false;
	pi.on("session_start", (_event, ctx) => {
		hasUI = ctx.hasUI;
	});

	// In-memory mirror of the current session's injected set.
	const injected = new Set<string>();
	// Snapshot of memory keys that existed at session start — new memories saved
	// during the session are excluded from auto-injection (they're for future sessions).
	const existingMemories = new Set<string>();
	let loadedSession: string | null = null;

	function ensureLoaded(sessionId: string, cwd: string): void {
		if (loadedSession === sessionId) return;
		loadedSession = sessionId;
		injected.clear();
		existingMemories.clear();
		try {
			const arr = JSON.parse(readFileSync(injectedFile(sessionId), "utf8")) as string[];
			for (const s of arr) injected.add(s);
		} catch {
			// No prior file for this session — start empty.
		}
		// Snapshot which memories existed at session start
		for (const m of loadTriggeredMemories(cwd)) {
			existingMemories.add(memKey(m));
		}
	}

	function persist(sessionId: string): void {
		try {
			writeFileSync(injectedFile(sessionId), JSON.stringify([...injected]));
		} catch {
			// Best-effort; dedup degrades to in-memory only.
		}
	}

	/**
	 * Find not-yet-injected memories whose triggers fire for `context`, limited
	 * to the given trigger event kinds. Marks them injected and returns the
	 * formatted block, or null when nothing fires.
	 */
	function collect(
		ctx: ExtensionContext,
		context: TriggerContext,
		allowed: ReadonlySet<Trigger["event"]>,
		forceOnce = false,
		blocked = false,
	): string | null {
		const sessionId = ctx.sessionManager?.getSessionId() ?? "unknown";
		ensureLoaded(sessionId, ctx.cwd);

		const fired: MemoryDoc[] = [];
		for (const m of loadTriggeredMemories(ctx.cwd)) {
			const key = memKey(m);
			// Skip memories that were saved during this session — they're meant for
			// future sessions, not to be injected back immediately.
			if (!existingMemories.has(key)) continue;
			// "once" (default) memories are deduped per session; "always" memories
			// fire every time — except when `forceOnce` is set (the tool_call block
			// path), where re-firing would re-block the same call and livelock the
			// agent, so every memory is treated as once there.
			const once = forceOnce || m.triggerFrequency !== "always";
			if (once && injected.has(key)) continue;
			if (m.triggers.some((t) => allowed.has(t.event) && evaluateTrigger(t, context))) {
				fired.push(m);
			}
		}
		if (fired.length === 0) return null;

		// CAP at 3 memories per injection event to prevent context explosion
		// when multiple patterns narrowly match. Highest-priority memories first.
		const MAX_PER_INJECTION = 3;
		if (fired.length > MAX_PER_INJECTION) {
			// Prioritize: "always" > "once", then by description length (shorter = more important)
			fired.sort((a, b) => {
				const aAlways = a.triggerFrequency === "always" ? 1 : 0;
				const bAlways = b.triggerFrequency === "always" ? 1 : 0;
				if (aAlways !== bAlways) return bAlways - aAlways;
				return a.description.length - b.description.length;
			});
			fired.splice(MAX_PER_INJECTION);
		}

		// Track once-semantics memories in the injected set so they don't re-fire.
		for (const m of fired) {
			if (forceOnce || m.triggerFrequency !== "always") injected.add(memKey(m));
		}
		persist(sessionId);
		return formatMemories(fired, blocked);
	}

	const INPUT_EVENTS = new Set<Trigger["event"]>(["pattern"]); // startup handled separately via before_agent_start
	const STARTUP_EVENTS = new Set<Trigger["event"]>(["startup"]);
	const TOOL_CALL_EVENTS = new Set<Trigger["event"]>(["pattern"]);
	const TOOL_EVENTS = new Set<Trigger["event"]>(["tool", "pattern"]);

	// Background memory audit — fires after each turn.
	pi.on("turn_end", async () => {
		if (!hasUI) return;
		if (!touchCooldown()) return;
		const { exec } = await import("node:child_process");
		exec(`nohup bash -c '${AUDIT_SCRIPT}' </dev/null >/dev/null 2>&1 &`, () => {});
	});

	// Auto-inject on user input: pattern triggers (matched against the message text).
	// Prepended so the memories precede the user's request.
	pi.on("input", async (event, ctx) => {
		if (!hasUI) return { action: "continue" };
		const query = event.text;

		// Don't transform slash commands — they must start at position 0 to be expanded
		if (query?.trim().startsWith("/")) {
			return { action: "continue" };
		}

		if (!query || query.trim().length < 3) {
			return { action: "continue" };
		}
		const block = collect(ctx, { message: query }, INPUT_EVENTS);
		if (!block) {
			return { action: "continue" };
		}
		return { action: "transform", text: `${block}\n\n---\n${query}` };
	});

	// Nudge on tool call: pattern triggers (matched against the tool's serialized
	// arguments) fire *before* the tool runs. There is no append-and-continue at
	// this point, so a match blocks the call once with the memory as the reason;
	// the LLM then reconsiders with the memory in context. Per-session dedup means
	// it fires at most once, after which the same call proceeds untouched. Only
	// `pattern` is wired here — a bare `tool` trigger would block the first use of
	// that tool every session, which is noise.
	//
	// Memory tools are exempt from blocking — they're the mechanism for reading
	// memories, so blocking them would create deadlocks. However, we do track
	// memory_read calls to mark those memories as "already seen" so they won't
	// be auto-injected later in the same session.
	pi.on("tool_call", async (event, ctx) => {
		if (!hasUI) return undefined;
		// Track memory_read calls to prevent later auto-injection of already-read memories
		if (event.toolName === "memory_read") {
			const sessionId = ctx.sessionManager?.getSessionId() ?? "unknown";
			ensureLoaded(sessionId, ctx.cwd);
			const args = event.input as { scope?: string; name?: string } | undefined;
			if (args?.scope && args?.name) {
				const key = `${args.scope}/${args.name}`;
				injected.add(key);
				persist(sessionId);
			}
			return undefined;
		}
		if (event.toolName === "memory_index" || event.toolName === "memory_suggest") {
			return undefined;
		}
		const block = collect(
			ctx,
			{ tool_calls: [event.toolName], tool_input: JSON.stringify(event.input ?? {}) },
			TOOL_CALL_EVENTS,
			true, // forceOnce: a repeated block would livelock the tool call
			true, // blocked: emit the hard "stop, read, then retry" directive
		);
		if (!block) return undefined;

		// Blocking a tool surfaces `reason` as the tool's result. For `bash` we
		// tack on a failed-command tail so the agent treats the block like a
		// genuine shell failure and retries. The tool never actually ran, so the
		// code is a conventional non-zero stand-in, not a real exit status — and
		// the wording only fits `bash`, so other tools get the bare reason.
		const reason =
			event.toolName === "bash" ? `${block}\n\nCommand exited with code 1.` : block;

		return { block: true, reason };
	});

	// Early streamed blocking for tool-name triggers (event: "tool").
	// Watches message_update for toolCall blocks, aborts generation early so
	// the model sees the memory before finishing the call. Guarded against
	// recursive loops via a per-turn flag.
	const MEMORY_TOOLS = new Set(["memory_read", "memory_index", "memory_suggest"]);
	let abortArmed = false; // True while we've aborted and are sending a user message

	pi.on("message_update", async (event, ctx) => {
		if (!hasUI) return;
		if (abortArmed) return; // Prevent recursive abort loops

		// Detect streaming tool call: last content block has type === "toolCall"
		const content = (event.message as { content?: unknown } | undefined)?.content;
		const blocks = Array.isArray(content) ? content : undefined;
		const last = blocks ? blocks[blocks.length - 1] : undefined;
		if (!last || last.type !== "toolCall" || typeof last.name !== "string") return;

		const toolName = last.name;

		// Exclude memory tools to avoid deadlocks
		if (MEMORY_TOOLS.has(toolName)) return;

		// Check for tool-name triggers (event: "tool") matching this tool
		const sessionId = ctx.sessionManager?.getSessionId() ?? "unknown";
		ensureLoaded(sessionId, ctx.cwd);

		// Track tool-name blocks separately (once per session, even for trigger_frequency: always)
		const toolBlockKey = `tool-block:${toolName}`;
		if (injected.has(toolBlockKey)) return; // Already blocked this tool this session

		// Find matching memories with event: "tool" for this tool name
		const fired: MemoryDoc[] = [];
		for (const m of loadTriggeredMemories(ctx.cwd)) {
			const key = memKey(m);
			// Skip memories saved during this session
			if (!existingMemories.has(key)) continue;
			// Tool-name blocks are always once-per-session
			if (injected.has(key)) continue;

			// Check for event: "tool" trigger matching this tool name
			const hasToolTrigger = m.triggers.some(
				(t) => t.event === "tool" && t.tool === toolName,
			);
			if (hasToolTrigger) {
				fired.push(m);
			}
		}

		if (fired.length === 0) return;

		// CAP at 3 memories per injection event
		const MAX_PER_INJECTION = 3;
		if (fired.length > MAX_PER_INJECTION) {
			fired.sort((a, b) => {
				const aAlways = a.triggerFrequency === "always" ? 1 : 0;
				const bAlways = b.triggerFrequency === "always" ? 1 : 0;
				if (aAlways !== bAlways) return bAlways - aAlways;
				return a.description.length - b.description.length;
			});
			fired.splice(MAX_PER_INJECTION);
		}

		// Mark as injected (both the memory keys and the tool-block key)
		for (const m of fired) {
			injected.add(memKey(m));
		}
		injected.add(toolBlockKey);
		persist(sessionId);

		// Abort the current streaming generation
		abortArmed = true;
		ctx.abort();

		// Send user message with the memory block (hard directive to read first)
		const block = formatMemories(fired, true);
		// Release the abort guard on next tick so the input event passes through
		setImmediate(() => {
			abortArmed = false;
		});
		pi.sendUserMessage(block);
	});

	// Auto-inject on tool output: tool + pattern triggers (matched against the
	// tool name and its textual output). Appended to the tool result content so
	// pattern triggers can fire on what a tool actually produced.
	//
	// CASCADE PREVENTION: memory tools (memory_read, memory_index, memory_suggest)
	// are excluded from pattern triggers to prevent recursive injection loops where
	// reading memories triggers more memories ad infinitum.
	pi.on("tool_result", async (event, ctx) => {
		if (!hasUI) return undefined;

		// Skip memory tools to prevent cascade injection
		if (MEMORY_TOOLS.has(event.toolName)) {
			return undefined;
		}

		const output = event.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n");

		const block = collect(
			ctx,
			{ tool_calls: [event.toolName], tool_results: output ? [output] : [] },
			TOOL_EVENTS,
		);
		if (!block) return undefined;

		return { content: [...event.content, { type: "text" as const, text: `\n\n${block}` }] };
	});

	// Inject startup-trigger memories into the system prompt (hidden from UI).
	// This runs once per session at agent start, preserving prefix caching.
	let startupInjected = false;
	pi.on("before_agent_start", async (event, ctx) => {
		if (!hasUI) return undefined;
		if (startupInjected) return undefined; // only once per session

		const block = collect(ctx, { message: event.prompt }, STARTUP_EVENTS);
		if (!block) {
			startupInjected = true;
			return undefined;
		}
		startupInjected = true;
		// Append to system prompt — goes to model but not visible in conversation UI
		return { systemPrompt: `${event.systemPrompt}\n\n--- AUTO-INJECTED CONTEXT (startup) ---\n${block}` };
	});
}
