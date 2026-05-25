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
 * Four tools are registered:
 *   • memory_index  — list all memories (system + project) with descriptions.
 *   • memory_read   — fetch the body of one memory.
 *   • memory_save   — create or overwrite a memory.
 *   • memory_delete — remove a memory.
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
import * as os from "node:os";
import * as path from "node:path";
import { execSync } from "node:child_process";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const MEMORY_ROOT = path.join(os.homedir(), ".pi", "agent", "memories");

const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

// LRU caps applied per scope after each save. Tuned for fast indexing on a
// local LLM: ~50 small markdown files fit in a single prompt without bloat.
const MAX_ENTRIES_PER_SCOPE = 50;
const MAX_BYTES_PER_SCOPE = 256 * 1024;

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
// Frontmatter helpers (tiny YAML-ish parser — name + description only)
// ---------------------------------------------------------------------------

interface Frontmatter {
	name?: string;
	description?: string;
	created_at?: string;
	accessed_at?: string;
}

function parseFrontmatter(content: string): { meta: Frontmatter; body: string } {
	if (!content.startsWith("---\n")) {
		return { meta: {}, body: content };
	}
	const end = content.indexOf("\n---\n", 4);
	if (end === -1) {
		return { meta: {}, body: content };
	}
	const block = content.slice(4, end);
	const body = content.slice(end + 5);
	const meta: Frontmatter = {};
	for (const line of block.split("\n")) {
		const m = line.match(/^(name|description|created_at|accessed_at):\s*(.*)$/);
		if (m) {
			let value = m[2].trim();
			if (
				(value.startsWith('"') && value.endsWith('"')) ||
				(value.startsWith("'") && value.endsWith("'"))
			) {
				value = value.slice(1, -1);
			}
			(meta as Record<string, string>)[m[1]] = value;
		}
	}
	return { meta, body };
}

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
): string {
	const trimmedBody = body.replace(/^\n+/, "");
	return (
		"---\n" +
		`name: ${escapeYaml(name)}\n` +
		`description: ${escapeYaml(description)}\n` +
		`created_at: ${createdAt}\n` +
		`accessed_at: ${accessedAt}\n` +
		"---\n\n" +
		trimmedBody
	);
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
}

function validateName(name: string): string | null {
	if (!SLUG_RE.test(name)) {
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

const SaveParams = Type.Object({
	scope: ScopeType,
	name: Type.String({
		description: "Memory slug (kebab/underscore, a-z 0-9). Used as the filename.",
	}),
	description: Type.String({
		description:
			"Brief summary (a short phrase, ideally under ~80 chars) shown by `memory_index` so future-you can decide whether to read the full body. Keep it tight — the full detail belongs in `content`.",
	}),
	content: Type.String({
		description:
			"Markdown body of the memory. Don't include frontmatter — it's generated from `name` and `description`.",
	}),
});

const DeleteParams = Type.Object({
	scope: ScopeType,
	name: Type.String({ description: "Memory slug to delete." }),
});

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

		async execute(_id, { scope }, _signal, _onUpdate, ctx) {
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
			};
		},

		renderCall(args, theme) {
			const scope = args?.scope ? String(args.scope) : "all";
			return new Text(
				`${theme.fg("toolTitle", theme.bold("memory_index"))} ${theme.fg("accent", scope)}`,
				0,
				0,
			);
		},
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

		async execute(_id, { scope, name }, _signal, _onUpdate, ctx) {
			const nameErr = validateName(name);
			if (nameErr) return errorResult(nameErr);

			const filePath = memoryPath(scope, name, ctx.cwd);
			if (!fs.existsSync(filePath)) {
				return errorResult(`No memory "${name}" in scope "${scope}". Try \`memory_index\`.`);
			}
			const content = fs.readFileSync(filePath, "utf-8");
			touchAccessed(filePath, name);
			const header = `# memory: ${scope}/${name}  (${filePath})`;
			return { content: [{ type: "text", text: `${header}\n${content}` }] };
		},

		renderCall(args, theme) {
			const scope = args?.scope ? String(args.scope) : "?";
			const name = args?.name ? String(args.name) : "...";
			return new Text(
				`${theme.fg("toolTitle", theme.bold("memory_read"))} ${theme.fg("accent", `${scope}/${name}`)}`,
				0,
				0,
			);
		},
	});

	// -----------------------------------------------------------------------
	// memory_save
	// -----------------------------------------------------------------------
	pi.registerTool({
		name: "memory_save",
		label: "memory_save",
		description:
			"Create or overwrite a memory. `scope=system` is global; `scope=project` is scoped to the current repo. " +
			"Body is markdown; frontmatter (name + description) is added for you. " +
			"Save things that will be useful in *future* conversations — user preferences, project context, references, feedback — not transient task state.",
		parameters: SaveParams,

		async execute(_id, { scope, name, description, content }, _signal, _onUpdate, ctx) {
			const nameErr = validateName(name);
			if (nameErr) return errorResult(nameErr);
			if (!description.trim()) {
				return errorResult("`description` must be non-empty — it's what `memory_index` shows.");
			}

			const dir = scopeDir(scope, ctx.cwd);
			ensureDir(dir);

			const filePath = memoryPath(scope, name, ctx.cwd);
			const existed = fs.existsSync(filePath);
			const now = new Date().toISOString();
			let createdAt = now;
			if (existed) {
				try {
					const { meta } = parseFrontmatter(fs.readFileSync(filePath, "utf-8"));
					if (meta.created_at) createdAt = meta.created_at;
				} catch {
					// keep `now`
				}
			}
			const rendered = renderFrontmatter(name, description, createdAt, now, content);
			fs.writeFileSync(filePath, rendered, "utf-8");

			enforceLruCaps(scope, ctx.cwd);
			updateIndex(scope, ctx.cwd);

			const verb = existed ? "updated" : "saved";
			return {
				content: [
					{
						type: "text",
						text: `${verb} memory \`${scope}/${name}\` → ${filePath}`,
					},
				],
			};
		},

		renderCall(args, theme) {
			const scope = args?.scope ? String(args.scope) : "?";
			const name = args?.name ? String(args.name) : "...";
			return new Text(
				`${theme.fg("toolTitle", theme.bold("memory_save"))} ${theme.fg("accent", `${scope}/${name}`)}`,
				0,
				0,
			);
		},
	});

	// -----------------------------------------------------------------------
	// memory_delete
	// -----------------------------------------------------------------------
	pi.registerTool({
		name: "memory_delete",
		label: "memory_delete",
		description: "Delete a stored memory by `scope` + `name`. Use when a memory is wrong, outdated, or no longer useful.",
		parameters: DeleteParams,

		async execute(_id, { scope, name }, _signal, _onUpdate, ctx) {
			const nameErr = validateName(name);
			if (nameErr) return errorResult(nameErr);

			const filePath = memoryPath(scope, name, ctx.cwd);
			if (!fs.existsSync(filePath)) {
				return errorResult(`No memory "${name}" in scope "${scope}".`);
			}
			fs.unlinkSync(filePath);
			updateIndex(scope, ctx.cwd);

			return {
				content: [{ type: "text", text: `deleted memory \`${scope}/${name}\`` }],
			};
		},

		renderCall(args, theme) {
			const scope = args?.scope ? String(args.scope) : "?";
			const name = args?.name ? String(args.name) : "...";
			return new Text(
				`${theme.fg("toolTitle", theme.bold("memory_delete"))} ${theme.fg("accent", `${scope}/${name}`)}`,
				0,
				0,
			);
		},
	});
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function errorResult(message: string) {
	return { content: [{ type: "text", text: message }], isError: true };
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
