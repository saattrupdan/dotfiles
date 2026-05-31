/**
 * Shared memory-trigger engine.
 *
 * Single source of truth for:
 *   • where memory files live (system + per-project scopes),
 *   • how `triggers:` frontmatter is parsed, and
 *   • how a trigger is evaluated against a turn's context.
 *
 * Imported by both the `memory` extension (the `memory_suggest` tool) and the
 * `memory-audit` extension (auto-injection on `input` / `tool_result`). Keeping
 * it here means the two can never drift on the trigger semantics or — crucially
 * — on the project-id derivation that decides which directory a project-scoped
 * memory is read from.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Paths (must match the `memory` extension exactly)
// ---------------------------------------------------------------------------

export const MEMORY_ROOT = path.join(os.homedir(), ".pi", "agent", "memories");

export function systemDir(): string {
	return path.join(MEMORY_ROOT, "system");
}

/**
 * Stable id for the current project: `<basename>-<sha1(root)[:10]>`, derived
 * from the git toplevel so memories persist across subdirectories of a repo.
 * Falls back to the absolute cwd when not in a git repo.
 */
export function projectId(cwd: string): string {
	let root = cwd;
	try {
		root = execSync("git rev-parse --show-toplevel", {
			cwd,
			stdio: ["ignore", "pipe", "ignore"],
		})
			.toString()
			.trim() || cwd;
	} catch {
		// Not a git repo — use cwd.
	}
	const base = path.basename(root) || "root";
	const hash = crypto.createHash("sha1").update(root).digest("hex").slice(0, 10);
	return `${base}-${hash}`;
}

export function projectDir(cwd: string): string {
	return path.join(MEMORY_ROOT, "projects", projectId(cwd));
}

export function scopeDir(scope: MemoryScope, cwd: string): string {
	return scope === "system" ? systemDir() : projectDir(cwd);
}

// ---------------------------------------------------------------------------
// Triggers
// ---------------------------------------------------------------------------

export type MemoryScope = "system" | "project";

/** How often a triggered memory is auto-injected: "once" (default, one-time) or "always" (every time it fires). */
export type MemoryTriggerFrequency = "once" | "always";

export interface Trigger {
	event: "startup" | "tool" | "pattern";
	tool?: string;
	pattern?: string;
}

/**
 * Context a trigger is evaluated against. Each auto-injection hook fills in the
 * fields it has: `input` provides `message`; `tool_call` provides `tool_calls`
 * + `tool_input` (the serialized arguments, before execution); `tool_result`
 * provides `tool_calls` + `tool_results` (the output, after execution).
 */
export interface TriggerContext {
	tool_calls?: string[];
	message?: string;
	tool_input?: string;
	tool_results?: string[];
}

/**
 * Parse the `triggers` frontmatter block (a YAML-style list) into structured
 * triggers. Returns null when no triggers are defined — such a memory is never
 * auto-injected.
 *
 *   triggers:
 *   - event: startup
 *   - event: tool
 *     tool: edit
 *   - event: pattern
 *     pattern: /commit/
 */
export function parseTriggers(raw: string | undefined): Trigger[] | null {
	if (!raw) return null;
	const lines = raw.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
	const triggers: Trigger[] = [];
	let current: Trigger = { event: "startup" };
	let inTrigger = false;

	for (const line of lines) {
		if (line.startsWith("- event:")) {
			if (inTrigger) triggers.push(current);
			current = { event: line.replace(/^\s*-\s*event:\s*/, "").trim() as Trigger["event"] };
			inTrigger = true;
		} else if (inTrigger && line.includes(":")) {
			const idx = line.indexOf(":");
			const key = line.slice(0, idx).trim();
			const val = line.slice(idx + 1).trim();
			if (key === "tool") current.tool = val;
			else if (key === "pattern") current.pattern = val;
		}
	}
	if (inTrigger) triggers.push(current);
	return triggers.length > 0 ? triggers : null;
}

/**
 * Evaluate a single trigger against the context. Returns true if it fires.
 *
 *   • startup — always fires (deduped to once per session by the caller).
 *   • tool    — fires when `context.tool_calls` includes the named tool.
 *   • pattern — regex-tests the combined message + tool-input + tool-output
 *               text, so it can match on a tool's pre-execution arguments (e.g.
 *               a `npm install` command) as well as the user message and a
 *               tool's output.
 */
export function evaluateTrigger(trigger: Trigger, context: TriggerContext): boolean {
	switch (trigger.event) {
		case "startup":
			return true;
		case "tool":
			if (!trigger.tool) return false;
			return (context.tool_calls ?? []).includes(trigger.tool);
		case "pattern": {
			if (!trigger.pattern) return false;
			const checkText = [context.message, context.tool_input, ...(context.tool_results ?? [])]
				.filter((t): t is string => Boolean(t))
				.join("\n");
			if (!checkText) return false;
			try {
				return new RegExp(trigger.pattern).test(checkText);
			} catch {
				return false; // invalid regex = no match
			}
		}
		default:
			return false;
	}
}

// ---------------------------------------------------------------------------
// Frontmatter + memory loading
// ---------------------------------------------------------------------------

export interface MemoryFrontmatter {
	name?: string;
	description?: string;
	created_at?: string;
	accessed_at?: string;
	triggers?: string;
	trigger_frequency?: string;
}

/** Tiny YAML-ish frontmatter parser. `triggers` is returned as its raw block. */
export function parseFrontmatter(content: string): { meta: MemoryFrontmatter; body: string } {
	if (!content.startsWith("---\n")) {
		return { meta: {}, body: content };
	}
	const end = content.indexOf("\n---\n", 4);
	if (end === -1) {
		return { meta: {}, body: content };
	}
	const block = content.slice(4, end);
	const body = content.slice(end + 5);
	const meta: MemoryFrontmatter = {};

	// `triggers` spans multiple lines (a list) so we parse it separately by
	// slurping every line from `triggers:` to the next top-level key.
	const lines = block.split("\n");
	const scalarRe = /^(name|description|created_at|accessed_at|trigger_frequency):\s*(.*)$/;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const m = line.match(scalarRe);
		if (m) {
			let value = m[2].trim();
			if (
				(value.startsWith('"') && value.endsWith('"')) ||
				(value.startsWith("'") && value.endsWith("'"))
			) {
				value = value.slice(1, -1);
			}
			(meta as Record<string, string>)[m[1]] = value;
			continue;
		}
		if (/^triggers:\s*(.*)$/.test(line)) {
			const inline = line.replace(/^triggers:\s*/, "").trim();
			const collected: string[] = inline ? [inline] : [];
			// Consume continuation lines (list items / nested keys) until the
			// next top-level scalar key or end of block.
			while (i + 1 < lines.length && !scalarRe.test(lines[i + 1]) && !/^triggers:/.test(lines[i + 1])) {
				collected.push(lines[i + 1]);
				i++;
			}
			meta.triggers = collected.join("\n");
		}
	}
	return { meta, body };
}

export interface MemoryDoc {
	scope: MemoryScope;
	name: string;
	description: string;
	body: string;
	filePath: string;
	triggers: Trigger[];
	triggerFrequency?: MemoryTriggerFrequency;
}

function listScopeDocs(scope: MemoryScope, cwd: string): MemoryDoc[] {
	const dir = scopeDir(scope, cwd);
	if (!fs.existsSync(dir)) return [];
	const docs: MemoryDoc[] = [];
	for (const file of fs.readdirSync(dir)) {
		if (!file.endsWith(".md") || file === "MEMORY.md") continue;
		const filePath = path.join(dir, file);
		try {
			const raw = fs.readFileSync(filePath, "utf-8");
			const { meta, body } = parseFrontmatter(raw);
			const triggers = parseTriggers(meta.triggers);
			if (!triggers) continue; // no triggers ⇒ never auto-injected
			docs.push({
				scope,
				name: path.basename(file, ".md"),
				description: meta.description ?? "",
				body,
				filePath,
				triggers,
				triggerFrequency: (meta.trigger_frequency as MemoryTriggerFrequency | undefined) ?? "once",
			});
		} catch {
			// Unreadable file — skip.
		}
	}
	return docs;
}

/**
 * Load every memory (system + project) that declares at least one trigger.
 * Memories without triggers are excluded entirely — they are only reachable via
 * explicit `memory_read` / `memory_suggest`, never auto-injected.
 */
export function loadTriggeredMemories(cwd: string): MemoryDoc[] {
	return [...listScopeDocs("system", cwd), ...listScopeDocs("project", cwd)];
}
