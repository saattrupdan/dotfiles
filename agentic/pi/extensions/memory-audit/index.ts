/**
 * Memory audit extension — two responsibilities:
 *
 * 1. Background memory audit (turn_end): spawns the memory-audit script to
 *    process new conversation lines and save memories. Throttled by a cooldown.
 *
 * 2. Trigger-based auto-injection: memories that declare `triggers:` in their
 *    frontmatter are injected into the conversation when a trigger fires —
 *      • `input`       evaluates startup + pattern triggers against the user
 *                      message and prepends the matched memories to it;
 *      • `tool_call`   evaluates pattern triggers against the tool's arguments
 *                      *before* it runs and, on a match, blocks the call with
 *                      the matched memories as the reason — a one-time nudge
 *                      that lets the LLM reconsider with the memory in context;
 *      • `tool_result` evaluates tool + pattern triggers against the tool name
 *                      and its output, appending matched memories to the result.
 *    A memory is injected at most once per session (deduped via a per-session
 *    file so it survives extension hot-reloads). Memories without triggers are
 *    never auto-injected.
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

function formatMemories(mems: MemoryDoc[]): string {
	const lines = mems.map(
		(m) => `- \`${m.scope}/${m.name}\`${m.description ? ` — ${m.description}` : ""}`,
	);
	const plural = mems.length > 1;
	return (
		`Relevant ${plural ? "memories" : "memory"} found for this request (auto-injected). ` +
		`${plural ? "These capture" : "This captures"} prior context, user preferences, and gotchas ` +
		`that apply to what you're doing right now and reflect how the user expects you to work.\n\n` +
		`Before you respond, call \`memory_read\` on ${plural ? "each one" : "it"} below to load the ` +
		`full body, then actually apply what you learn — let it shape your answer, your plan, and the ` +
		`commands you run. Only the name + description are shown here, which is not enough to act on:\n\n` +
		`${lines.join("\n")}\n\n` +
		`If this was injected after a tool call of yours, we might have blocked it. Check ` +
    `if this is the case, and if so, read the ${plural ? "memories" : "memory"} above ` +
    `and try again where you take into account the ${plural ? "memories" : "memory"}.`
	);
}

export default function (pi: ExtensionAPI) {
	// In-memory mirror of the current session's injected set.
	const injected = new Set<string>();
	let loadedSession: string | null = null;

	function ensureLoaded(sessionId: string): void {
		if (loadedSession === sessionId) return;
		loadedSession = sessionId;
		injected.clear();
		try {
			const arr = JSON.parse(readFileSync(injectedFile(sessionId), "utf8")) as string[];
			for (const s of arr) injected.add(s);
		} catch {
			// No prior file for this session — start empty.
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
	): string | null {
		const sessionId = ctx.sessionManager?.getSessionId() ?? "unknown";
		ensureLoaded(sessionId);

		const fired: MemoryDoc[] = [];
		for (const m of loadTriggeredMemories(ctx.cwd)) {
			const key = memKey(m);
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

		// Track once-semantics memories in the injected set so they don't re-fire.
		for (const m of fired) {
			if (forceOnce || m.triggerFrequency !== "always") injected.add(memKey(m));
		}
		persist(sessionId);
		return formatMemories(fired);
	}

	const INPUT_EVENTS = new Set<Trigger["event"]>(["startup", "pattern"]);
	const TOOL_CALL_EVENTS = new Set<Trigger["event"]>(["pattern"]);
	const TOOL_EVENTS = new Set<Trigger["event"]>(["tool", "pattern"]);

	// Background memory audit — fires after each turn.
	pi.on("turn_end", async () => {
		if (!touchCooldown()) return;
		const { exec } = await import("node:child_process");
		exec(`nohup bash -c '${AUDIT_SCRIPT}' </dev/null >/dev/null 2>&1 &`, () => {});
	});

	// Auto-inject on user input: startup + pattern triggers (matched against the
	// message text). Prepended so the memories precede the user's request.
	pi.on("input", async (event, ctx) => {
		const query = event.text;
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
	pi.on("tool_call", async (event, ctx) => {
		const block = collect(
			ctx,
			{ tool_calls: [event.toolName], tool_input: JSON.stringify(event.input ?? {}) },
			TOOL_CALL_EVENTS,
			true, // forceOnce: a repeated block would livelock the tool call
		);
		if (!block) return undefined;

		return { block: true, reason: block };
	});

	// Auto-inject on tool output: tool + pattern triggers (matched against the
	// tool name and its textual output). Appended to the tool result content so
	// pattern triggers can fire on what a tool actually produced.
	pi.on("tool_result", async (event, ctx) => {
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
}
