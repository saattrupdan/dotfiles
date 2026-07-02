/**
 * `memory` tools — persistent markdown notes the agent can write to and recall
 * across conversations.
 *
 * Memories are stored as plain markdown files under `~/.pi/agent/memories/`:
 *
 *   ~/.pi/agent/memories/
 *   ├── system/                    # system-wide, available to every agent run
 *   │   ├── MEMORY.md              # one-line index, always loaded by `memory_index`
 *   │   └── <slug>.md
 *   └── projects/
 *       └── <project-id>/          # scoped to a git repo (or cwd fallback)
 *           ├── MEMORY.md
 *           └── <slug>.md
 *
 * The project id is derived from `git rev-parse --show-toplevel` so memories
 * persist across subdirectories of the same repo. If the cwd is not inside a
 * git repo we fall back to the absolute cwd. The id is `<basename>-<sha1[:10]>`
 * for readability while staying unique.
 *
 * Everything is local — designed for a local LLM where storing secret/private
 * notes is fine. The directory lives outside any repo by design; see the
 * project README for the gitignore safety net.
 *
 * Five tools are registered:
 *   • memory_index  — list all memories (system + project) with descriptions.
 *   • memory_read   — fetch the body of one memory.
 *   • memory_save   — create or overwrite a memory.
 *   • memory_delete — remove a memory.
 *   • memory_suggest — fuzzy keyword search across all memories, returns top-k by relevance.
 *
 * Memory files use this frontmatter so the index can summarise them cheaply:
 *
 *   ---
 *   name: short-kebab-case-slug
 *   description: one-line summary used by memory_index
 *   created_at: 2025-01-01T00:00:00.000Z
 *   accessed_at: 2025-01-01T00:00:00.000Z
 *   ---
 *
 *   <markdown body>
 *
 * `accessed_at` is bumped on every `memory_read`; `memory_save` runs an LRU
 * sweep so a scope never exceeds `MAX_ENTRIES_PER_SCOPE` files or
 * `MAX_BYTES_PER_SCOPE` total bytes — least-recently-accessed entries are
 * dropped first.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import { invalidateTriggerCache } from "../_memory/triggers.ts";
import * as os from "node:os";
import * as path from "node:path";
import { execSync } from "node:child_process";

import type { AgentToolResult, ExtensionAPI, Theme, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { type Component, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import {
	type Trigger,
	evaluateTrigger,
	parseFrontmatter,
	parseTriggers,
} from "../_memory/triggers.ts";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const MEMORY_ROOT = path.join(os.homedir(), ".pi", "agent", "memories");

const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

// LRU caps applied per scope after each save. Tuned for fast indexing on a
// local LLM: ~50 small markdown files fit in a single prompt without bloat.
const MAX_ENTRIES_PER_SCOPE = 50;
const MAX_BYTES_PER_SCOPE = 256 * 1024;

// A description is an index line, not the memory itself — it must stay a single
// short sentence so future-you can scan the index cheaply. The full detail lives
// in the body (fetched via `memory_read`). ~50 chars ≈ one short sentence.
const MAX_DESCRIPTION_CHARS = 50;

function systemDir(): string {
	return path.join(MEMORY_ROOT, "system");
}

function projectId(cwd: string): string {
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

function projectDir(cwd: string): string {
	return path.join(MEMORY_ROOT, "projects", projectId(cwd));
}

function scopeDir(scope: "system" | "project", cwd: string): string {
	return scope === "system" ? systemDir() : projectDir(cwd);
}

function ensureDir(dir: string): void {
	fs.mkdirSync(dir, { recursive: true });
}

function memoryPath(scope: "system" | "project", name: string, cwd: string): string {
	return path.join(scopeDir(scope, cwd), `${name}.md`);
}

// ---------------------------------------------------------------------------
// Frontmatter helpers — `parseFrontmatter` is shared with `memory-audit` (see
// ../_memory/triggers.ts) so trigger parsing can't drift between read & inject.
// ---------------------------------------------------------------------------

function escapeYaml(value: string): string {
	const needsQuoting = /[:#\n"']/.test(value);
	if (!needsQuoting) return value;
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ")}"`;
}

function renderFrontmatter(
	name: string,
	description: string,
	createdAt: string,
	accessedAt: string,
	body: string,
	triggers?: Trigger[],
	triggerFrequency?: "once" | "always",
): string {
	const trimmedBody = body.replace(/^\n+/, "");
	let fm = (
		"---\n" +
		`name: ${escapeYaml(name)}\n` +
		`description: ${escapeYaml(description)}\n` +
		`created_at: ${createdAt}\n` +
		`accessed_at: ${accessedAt}\n`
	);
	if (triggerFrequency && triggerFrequency !== "once") {
		fm += `trigger_frequency: ${triggerFrequency}\n`;
	}
	if (triggers && triggers.length > 0) {
		fm += "triggers:\n";
		for (const t of triggers) {
			fm += `- event: ${t.event}`;
			if (t.tool) fm += `\n  tool: ${t.tool}`;
			if (t.pattern) fm += `\n  pattern: ${t.pattern}`;
			fm += "\n";
		}
	}
	fm += "---\n\n" + trimmedBody;
	return fm;
}

/**
 * Rewrite an existing memory file with a new accessed_at timestamp, keeping
 * description/created_at/body intact. Tolerant of legacy files that pre-date
 * the timestamp fields.
 */
function touchAccessed(filePath: string, name: string): void {
	try {
		const raw = fs.readFileSync(filePath, "utf-8");
		const { meta, body } = parseFrontmatter(raw);
		const now = new Date().toISOString();
		const created = meta.created_at ?? now;
		const description = meta.description ?? "";
		const rendered = renderFrontmatter(
			meta.name ?? name,
			description,
			created,
			now,
			body,
			parseTriggers(meta.triggers) ?? undefined,
			(meta.trigger_frequency as "once" | "always" | undefined),
		);
		fs.writeFileSync(filePath, rendered, "utf-8");
	} catch {
		// Best-effort: a touch failure must not break a read.
	}
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

interface MemoryEntry {
	scope: "system" | "project";
	name: string;
	description: string;
	filePath: string;
	accessedAt: number;
	bytes: number;
}

function listScope(scope: "system" | "project", cwd: string): MemoryEntry[] {
	const dir = scopeDir(scope, cwd);
	if (!fs.existsSync(dir)) return [];
	const entries: MemoryEntry[] = [];
	for (const file of fs.readdirSync(dir)) {
		if (!file.endsWith(".md")) continue;
		if (file === "MEMORY.md") continue;
		const filePath = path.join(dir, file);
		let description = "(no description)";
		let accessedAt = 0;
		let bytes = 0;
		try {
			const stat = fs.statSync(filePath);
			bytes = stat.size;
			const { meta } = parseFrontmatter(fs.readFileSync(filePath, "utf-8"));
			if (meta.description) description = meta.description;
			if (meta.accessed_at) {
				const t = Date.parse(meta.accessed_at);
				if (!Number.isNaN(t)) accessedAt = t;
			}
			// Fall back to mtime for legacy files without accessed_at.
			if (accessedAt === 0) accessedAt = stat.mtimeMs;
		} catch {
			// fall through with default description
		}
		entries.push({
			scope,
			name: path.basename(file, ".md"),
			description,
			filePath,
			accessedAt,
			bytes,
		});
	}
	entries.sort((a, b) => a.name.localeCompare(b.name));
	return entries;
}

/**
 * Drop least-recently-accessed entries from a scope until both the count and
 * total byte caps are satisfied. Runs after every save so the working set
 * stays small and indexing stays fast.
 */
function enforceLruCaps(scope: "system" | "project", cwd: string): void {
	const dir = scopeDir(scope, cwd);
	if (!fs.existsSync(dir)) return;
	const list = listScope(scope, cwd);
	const byOldestFirst = [...list].sort((a, b) => a.accessedAt - b.accessedAt);

	let count = list.length;
	let bytes = list.reduce((sum, e) => sum + e.bytes, 0);

	for (const e of byOldestFirst) {
		if (count <= MAX_ENTRIES_PER_SCOPE && bytes <= MAX_BYTES_PER_SCOPE) break;
		try {
			fs.unlinkSync(e.filePath);
			count -= 1;
			bytes -= e.bytes;
		} catch {
			// best effort
		}
	}

	// Invalidate trigger cache if any files were deleted
	if (list.length > count) {
		invalidateTriggerCache();
	}
}

function stripQuotes(value: string): string {
	return value.replace(/^['"]|['"]$/g, "");
}

function validateName(name: string): string | null {
	const cleaned = stripQuotes(name);
	if (!SLUG_RE.test(cleaned)) {
		return `Invalid memory name "${name}". Use lowercase kebab/underscore slug (a-z, 0-9, -, _), max 64 chars, starting alphanumeric.`;
	}
	return null;
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const ScopeType = Type.Union([Type.Literal("system"), Type.Literal("project")], {
	description:
		"`system` = available to every agent run on this machine. `project` = scoped to the current git repo (or cwd if not in a repo).",
});

const IndexParams = Type.Object({
	scope: Type.Optional(
		Type.Union(
			[Type.Literal("system"), Type.Literal("project"), Type.Literal("all")],
			{ description: "Which scope(s) to list. Defaults to `all`." },
		),
	),
});

const ReadParams = Type.Object({
	scope: ScopeType,
	name: Type.String({ description: "Memory slug (without `.md`)." }),
});

const TriggerParam = Type.Object({
	event: Type.Union(
		[Type.Literal("startup"), Type.Literal("tool"), Type.Literal("pattern")],
		{ description: "Trigger type: 'startup' (every session), 'tool' (specific tool call), 'pattern' (regex match)." },
	),
	tool: Type.Optional(Type.String({ description: "Tool name to match (required when event is 'tool')." })),
	pattern: Type.Optional(
		Type.String({
			description:
				"Regex (required when event is 'pattern'). Matched against the user message, a tool's arguments *before* it runs (the serialized JSON, e.g. {\"command\":\"npm install foo\"}), and a tool's output after it runs. A pre-run match blocks that call once with the memory as the reason, nudging the agent to reconsider — so this is the trigger for 'before you do X, remember Y' rules (e.g. pattern '(npm|pip) install' for a package-permission rule). Note: match the substring; don't anchor with ^ since the JSON prefix precedes the argument value.",
		}),
	),
});

const SaveParams = Type.Object({
	scope: ScopeType,
	name: Type.String({
		description: "Memory slug (kebab/underscore, a-z 0-9). Used as the filename.",
	}),
	description: Type.String({
		description:
			"One short sentence (max 50 chars, hard limit) shown by `memory_index` and on auto-injection so future-you can decide whether to read the full body. It's only an index line — the full detail belongs in `content`, not here.",
	}),
	content: Type.String({
		description:
			"Markdown body of the memory. Pure markdown content — frontmatter (name, description, triggers, timestamps) is generated from the separate arguments.",
	}),
	triggers: Type.Optional(
		Type.Array(TriggerParam, {
			description: "When this memory should be auto-injected. On a new memory, empty or omitted = never auto-injected (manual retrieval only). On an update, omitting this keeps the existing triggers; pass an empty array to clear them.",
		}),
	),
	triggerFrequency: Type.Optional(
		Type.Union([Type.Literal("once"), Type.Literal("always")], {
			description: "How often triggered memories are auto-injected: 'once' (default, injected at most once per session) or 'always' (injected every time the trigger fires).",
		}),
	),
});

const DeleteParams = Type.Object({
	scope: ScopeType,
	name: Type.String({ description: "Memory slug to delete." }),
});

const SuggestContext = Type.Optional(
	Type.Object({
		tool_calls: Type.Optional(
			Type.Array(Type.String(), {
				description: "Tool names called in the current turn (e.g. ['edit', 'write']). Memories with matching `tool` triggers fire.",
			}),
		),
		message: Type.Optional(
			Type.String({
				description: "The user's message. Memories with `pattern` triggers are evaluated against this.",
			}),
		),
		tool_results: Type.Optional(
			Type.Array(Type.String(), {
				description: "Tool output text from the current turn. Pattern triggers also evaluate against this combined text.",
			}),
		),
	}),
);

const SuggestParams = Type.Object({
	query: Type.String({
		description: "The query text to search for relevant memories.",
	}),
	top_k: Type.Optional(
		Type.Number({ minimum: 1, maximum: 20, description: "Max results to return. Defaults to 5." }),
	),
	context: SuggestContext,
});

// ---------------------------------------------------------------------------
// Fuzzy keyword search helpers
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set([
	"a","an","the","and","or","but","in","on","at","to","for",
	"of","with","by","from","is","it","this","that","these","those",
	"was","were","been","be","have","has","had","do","does","did",
	"will","would","could","should","may","might","can","shall",
	"not","no","nor","if","then","than","too","very","just",
	"about","above","after","again","all","am","any","are",
	"as","because","before","between","both","during","each",
	"few","further","got","here","how","i","into","its","let",
	"more","most","much","my","new","now","off","once","only",
	"our","out","over","own","same","she","so","some","still",
	"such","take","them","there","they","through","under",
	"up","us","use","used","using","what","when","where",
	"which","who","whom","why","you","your",
]);

function tokenize(text: string): string[] {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9\-_]/g, " ")
		.split(/\s+/)
		.filter((w) => w.length > 1 && !STOP_WORDS.has(w));
}

function levenshtein(a: string, b: string): number {
	const m = a.length;
	const n = b.length;
	if (m === 0) return n;
	if (n === 0) return m;
	const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
		Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
	);
	for (let i = 1; i <= m; i++) {
		for (let j = 1; j <= n; j++) {
			dp[i][j] = Math.min(
				dp[i - 1][j] + 1,
				dp[i][j - 1] + 1,
				dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
			);
		}
	}
	return dp[m][n];
}

function fuzzyScore(queryTokens: string[], memoryTokens: string[]): number {
	if (queryTokens.length === 0) return 0;

	let score = 0;
	let exactMatches = 0;

	for (const qt of queryTokens) {
		let bestExact = 0;
		let bestFuzzy = 0;
		for (const mt of memoryTokens) {
			if (qt === mt) {
				bestExact = Math.max(bestExact, 1);
			} else {
				const dist = levenshtein(qt, mt);
				const maxLen = Math.max(qt.length, mt.length);
				const sim = maxLen === 0 ? 0 : 1 - dist / maxLen;
				if (sim > 0.7) {
					bestFuzzy = Math.max(bestFuzzy, sim * 0.5);
				}
			}
		}
		if (bestExact > 0) {
			exactMatches++;
			score += bestExact;
		} else if (bestFuzzy > 0) {
			score += bestFuzzy;
		}
	}

	// Bonus: ratio of exact matches
	if (exactMatches > 0) {
		score *= (1 + exactMatches * 0.3);
	}

	return score;
}

interface Suggestion {
	scope: "system" | "project";
	name: string;
	description: string;
	score: number;
	body?: string;
	triggers?: Trigger[];
	triggerFrequency?: "once" | "always";
}

interface MemoryRenderDetails {
	collapsed?: string;
}

function renderMemoryResult(
	result: AgentToolResult<unknown>,
	{ expanded }: ToolRenderResultOptions,
	theme: Theme,
): Component {
	const text = textContent(result.content);
	if (expanded) return new Text(text, 0, 0);

	const details = result.details as MemoryRenderDetails | undefined;
	if (details?.collapsed) return new Text(theme.fg("success", details.collapsed), 0, 0);

	return new Text(firstLine(text), 0, 0);
}

function textContent(content: Array<{ type: string; text?: string }>): string {
	return content
		.filter((item) => item.type === "text" && item.text)
		.map((item) => item.text)
		.join("\n");
}

function firstLine(text: string): string {
	return text.split("\n")[0] || "(no output)";
}

export default function (pi: ExtensionAPI) {
	// -----------------------------------------------------------------------
	// memory_index
	// -----------------------------------------------------------------------
	pi.registerTool({
		name: "memory_index",
		label: "memory_index",
		description:
			"List stored memories (system-wide and/or project-scoped) with their one-line descriptions. " +
			"Call this first to see what's already remembered before answering, then `memory_read` any that look relevant.",
		parameters: IndexParams,

		async execute(_id, { scope }, _signal, _onUpdate, ctx): Promise<AgentToolResult<MemoryRenderDetails>> {
			const which = scope ?? "all";
			const sections: string[] = [];

			if (which === "system" || which === "all") {
				const list = listScope("system", ctx.cwd);
				sections.push(formatSection("system", list));
			}
			if (which === "project" || which === "all") {
				const list = listScope("project", ctx.cwd);
				const header = `project (${projectId(ctx.cwd)})`;
				sections.push(formatSection(header, list));
			}

			return {
				content: [{ type: "text", text: sections.join("\n\n") }],
				details: { collapsed: "✓ memory index listed" },
			};
		},

		renderCall(args, theme) {
			const scope = args?.scope ? stripQuotes(String(args.scope)) : "all";
			return new Text(
				`${theme.fg("toolTitle", theme.bold("memory_index"))} ${theme.fg("accent", scope)}`,
				0,
				0,
			);
		},

		renderResult: renderMemoryResult,
	});

	// -----------------------------------------------------------------------
	// memory_read
	// -----------------------------------------------------------------------
	pi.registerTool({
		name: "memory_read",
		label: "memory_read",
		description:
			"Read the full body of a stored memory by `scope` + `name`. Use `memory_index` first to discover available memories.",
		parameters: ReadParams,

		async execute(_id, { scope, name }, _signal, _onUpdate, ctx): Promise<AgentToolResult<MemoryRenderDetails>> {
			const cleanedScope = stripQuotes(scope) as "system" | "project";
			const cleanedName = stripQuotes(name);
			const nameErr = validateName(cleanedName);
			if (nameErr) return errorResult(nameErr);

			const filePath = memoryPath(cleanedScope, cleanedName, ctx.cwd);
			if (!fs.existsSync(filePath)) {
				return errorResult(`No memory "${cleanedName}" in scope "${cleanedScope}". Try \`memory_index\`.`);
			}
			const content = fs.readFileSync(filePath, "utf-8");
			touchAccessed(filePath, cleanedName);
			const header = `# memory: ${cleanedScope}/${cleanedName}  (${filePath})`;
			return {
				content: [{ type: "text", text: `${header}\n${content}` }],
				details: { collapsed: `✓ memory read` },
			};
		},

		renderCall(args, theme) {
			const scope = args?.scope ? stripQuotes(String(args.scope)) : "?";
			const name = args?.name ? stripQuotes(String(args.name)) : "...";
			return new Text(
				`${theme.fg("toolTitle", theme.bold("memory_read"))} ${theme.fg("accent", `${scope}/${name}`)}`,
				0,
				0,
			);
		},

		renderResult: renderMemoryResult,
	});

	// -----------------------------------------------------------------------
	// memory_save
	// -----------------------------------------------------------------------
	pi.registerTool({
		name: "memory_save",
		label: "memory_save",
		description:
			"Create or overwrite a memory. `scope=system` is global; `scope=project` is scoped to the current repo. " +
			"Frontmatter (name, description, triggers, timestamps) is generated from separate arguments. " +
			"Save things that will be useful in *future* conversations — user preferences, project context, references, feedback — not transient task state.",
		parameters: SaveParams,

		async execute(_id, { scope, name, description, content, triggers, triggerFrequency }, _signal, _onUpdate, ctx): Promise<AgentToolResult<MemoryRenderDetails>> {
			const cleanedScope = stripQuotes(scope) as "system" | "project";
			const cleanedName = stripQuotes(name);
			const nameErr = validateName(cleanedName);
			if (nameErr) return errorResult(nameErr);
			const desc = description.trim();
			if (!desc) {
				return errorResult("`description` must be non-empty — it's what `memory_index` shows.");
			}
			if (desc.length > MAX_DESCRIPTION_CHARS) {
				return errorResult(
					`\`description\` is ${desc.length} chars; keep it to one short sentence ` +
						`(max ${MAX_DESCRIPTION_CHARS}). It's only an index line — put the detail in \`content\`.`,
				);
			}

			const dir = scopeDir(cleanedScope, ctx.cwd);
			ensureDir(dir);

			const filePath = memoryPath(cleanedScope, cleanedName, ctx.cwd);
			const existed = fs.existsSync(filePath);
			const now = new Date().toISOString();
			let createdAt = now;
			// Updates are a full overwrite, but `triggers`/`triggerFrequency` are
			// optional args — so when they're omitted on an update we carry over
			// the existing file's values rather than silently dropping the
			// `triggers:` block. Pass an explicit empty array to clear triggers.
			let effectiveTriggers = triggers;
			let effectiveFrequency = triggerFrequency;
			if (existed) {
				try {
					const { meta } = parseFrontmatter(fs.readFileSync(filePath, "utf-8"));
					if (meta.created_at) createdAt = meta.created_at;
					if (effectiveTriggers === undefined) {
						effectiveTriggers = parseTriggers(meta.triggers) ?? undefined;
					}
					if (effectiveFrequency === undefined) {
						effectiveFrequency = meta.trigger_frequency as "once" | "always" | undefined;
					}
				} catch {
					// keep `now` and the provided args
				}
			}
			const rendered = renderFrontmatter(cleanedName, description, createdAt, now, content, effectiveTriggers, effectiveFrequency);
			fs.writeFileSync(filePath, rendered, "utf-8");

			// Invalidate caches so changes are picked up immediately
			cachedMemories.length = 0;
			invalidateTriggerCache();
			enforceLruCaps(cleanedScope, ctx.cwd);
			updateIndex(cleanedScope, ctx.cwd);

			const verb = existed ? "updated" : "saved";
			return {
				content: [
					{
						type: "text",
						text: `${verb} memory \`${scope}/${cleanedName}\` → ${filePath}`,
					},
				],
				details: { collapsed: "✓ memory saved" },
			};
		},

		renderCall(args, theme) {
			const scope = args?.scope ? stripQuotes(String(args.scope)) : "?";
			const name = args?.name ? stripQuotes(String(args.name)) : "...";
			return new Text(
				`${theme.fg("toolTitle", theme.bold("memory_save"))} ${theme.fg("accent", `${scope}/${name}`)}`,
				0,
				0,
			);
		},

		renderResult: renderMemoryResult,
	});

	// -----------------------------------------------------------------------
	// memory_suggest
	// -----------------------------------------------------------------------
	const cachedMemories: Suggestion[] = [];

	function collectMemories(cwd: string): Suggestion[] {
		if (cachedMemories.length > 0) return cachedMemories;
		for (const scope of ["system", "project"] as const) {
			for (const entry of listScope(scope, cwd)) {
				try {
					const raw = fs.readFileSync(entry.filePath, "utf-8");
					const { meta, body } = parseFrontmatter(raw);
					cachedMemories.push({
						scope,
						name: entry.name,
						description: meta.description ?? "",
						score: 0,
						body,
						triggers: parseTriggers(meta.triggers) ?? undefined,
						triggerFrequency: (meta.trigger_frequency as "once" | "always" | undefined) ?? "once",
					});
				} catch {
					cachedMemories.push({
						scope,
						name: entry.name,
						description: "",
						score: 0,
					});
				}
			}
		}
		return cachedMemories;
	}

	pi.registerTool({
		name: "memory_suggest",
		label: "memory_suggest",
		description:
		"Find relevant memories using fuzzy keyword search. " +
		"Returns memories sorted by relevance score. " +
		"Use this to discover memories related to a topic or query. " +
		"When called without a query, evaluates trigger-based auto-injection rules." +
		"The orchestrator should pass tool_calls and message in context for trigger evaluation.",
		parameters: SuggestParams,

		async execute(_id, { query, top_k = 5, context }, _signal, _onUpdate, ctx): Promise<AgentToolResult<MemoryRenderDetails>> {
			const memories = collectMemories(ctx.cwd);

			// No query = auto-injection mode: only trigger-based, no fuzzy search
			if (!query || query.trim().length === 0) {
				const triggerResults: Map<string, Suggestion> = new Map();
				if (context) {
					for (const m of memories) {
						if (!m.triggers) continue;
						for (const trigger of m.triggers) {
							if (evaluateTrigger(trigger, context)) {
								if (!triggerResults.has(m.name)) {
									triggerResults.set(m.name, { ...m, score: 10 });
									break; // each memory fires at most once
								}
							}
						}
					}
				}

				const top = Array.from(triggerResults.values()).sort((a, b) => b.score - a.score);
				if (top.length === 0) {
					return {
						content: [{ type: "text", text: "No relevant memories found." }],
						details: { collapsed: "✓ memory suggestions checked" },
					};
				}

				const results = top.map(
					(m) =>
						`- \`${m.scope}/${m.name}\` (${m.description})`,
				);

				return {
					content: [
						{
							type: "text",
							text: `Relevant memories:\n\n${results.join("\n")}\n\nThe agent should remember these memories when formulating an answer to the query below.`,
						},
					],
					details: { collapsed: `✓ found ${top.length} relevant memories` },
				};
			}

			// Query present = manual retrieval: fuzzy search only, no triggers
			const queryTokens = tokenize(query);
			if (queryTokens.length === 0) {
				return {
					content: [{ type: "text", text: "No meaningful tokens in query." }],
					details: { collapsed: "✓ memory suggestions checked" },
				};
			}

			const scored = memories.map((m) => {
				const nameTokens = tokenize(m.name);
				const descTokens = tokenize(m.description);
				const bodyTokens = m.body ? tokenize(m.body) : [];

				// Weighted scoring: name > description > body
				const nameScore = fuzzyScore(queryTokens, nameTokens) * 3;
				const descScore = fuzzyScore(queryTokens, descTokens) * 1.5;
				const bodyScore = fuzzyScore(queryTokens, bodyTokens);

				return { ...m, score: nameScore + descScore + bodyScore };
			});

			const top = scored
				.filter((m) => m.score > 0)
				.sort((a, b) => b.score - a.score)
				.slice(0, top_k);

			if (top.length === 0) {
				return {
					content: [{ type: "text", text: "No relevant memories found." }],
					details: { collapsed: "✓ memory suggestions checked" },
				};
			}

			const results = top.map(
				(m) =>
					`- \`${m.scope}/${m.name}\` (${m.description})`,
			);

			return {
				content: [
					{
						type: "text",
						text: `Relevant memories for "${query}":\n\n${results.join("\n")}\n\nThe agent should remember these memories when formulating an answer to the query below.`,
					},
				],
				details: { collapsed: `✓ found ${top.length} relevant memories` },
			};
		},

		renderCall(args, theme) {
			const query = args?.query ? String(args.query) : "...";
			const topK = args?.top_k ? String(args.top_k) : "5";
			return new Text(
				`${theme.fg("toolTitle", theme.bold("memory_suggest"))} "${theme.fg("accent", query)}" top_k=${topK}`,
				0,
				0,
			);
		},

		renderResult: renderMemoryResult,
	});

	// -----------------------------------------------------------------------
	// memory_delete
	// -----------------------------------------------------------------------
	pi.registerTool({
		name: "memory_delete",
		label: "memory_delete",
		description: "Delete a stored memory by `scope` + `name`. Use when a memory is wrong, outdated, or no longer useful.",
		parameters: DeleteParams,

		async execute(_id, { scope, name }, _signal, _onUpdate, ctx): Promise<AgentToolResult<MemoryRenderDetails>> {
			const cleanedScope = stripQuotes(scope) as "system" | "project";
			const cleanedName = stripQuotes(name);
			const nameErr = validateName(cleanedName);
			if (nameErr) return errorResult(nameErr);

			const filePath = memoryPath(cleanedScope, cleanedName, ctx.cwd);
			if (!fs.existsSync(filePath)) {
				return errorResult(`No memory "${name}" in scope "${cleanedScope}".`);
			}
			fs.unlinkSync(filePath);
			// Invalidate caches so deletion is picked up immediate
			cachedMemories.length = 0;
			invalidateTriggerCache();
			updateIndex(cleanedScope, ctx.cwd);

			return {
				content: [{ type: "text", text: `deleted memory \`${scope}/${cleanedName}\`` }],
				details: { collapsed: "✓ memory deleted" },
			};
		},

		renderCall(args, theme) {
			const scope = args?.scope ? stripQuotes(String(args.scope)) : "?";
			const name = args?.name ? stripQuotes(String(args.name)) : "...";
			return new Text(
				`${theme.fg("toolTitle", theme.bold("memory_delete"))} ${theme.fg("accent", `${scope}/${name}`)}`,
				0,
				0,
			);
		},

		renderResult: renderMemoryResult,
	});
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function errorResult(message: string): AgentToolResult<MemoryRenderDetails> {
	return { content: [{ type: "text", text: message }], details: {} };
}

function formatSection(header: string, list: MemoryEntry[]): string {
	if (list.length === 0) {
		return `## ${header}\n(no memories)`;
	}
	const lines = list.map((e) => `- \`${e.name}\` — ${e.description}`);
	return `## ${header}\n${lines.join("\n")}`;
}

/**
 * Rewrite the MEMORY.md index for a scope. The index is a single markdown file
 * with one-line pointers; it's regenerated from the actual files on disk after
 * every save/delete so it can't drift.
 */
function updateIndex(scope: "system" | "project", cwd: string): void {
	const dir = scopeDir(scope, cwd);
	if (!fs.existsSync(dir)) return;
	const list = listScope(scope, cwd);
	const indexPath = path.join(dir, "MEMORY.md");
	const lines = [`# ${scope === "system" ? "System" : "Project"} memories`, ""];
	if (list.length === 0) {
		lines.push("(none yet)");
	} else {
		for (const e of list) {
			lines.push(`- [${e.name}](${e.name}.md)`);
		}
	}
	fs.writeFileSync(indexPath, lines.join("\n") + "\n", "utf-8");
}
