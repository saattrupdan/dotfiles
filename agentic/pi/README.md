# pi

Personal pi-coding-agent configuration: settings, prompts, subagents, and a
suite of custom extensions that shape how the agent reads code, searches the
repo, browses the web, and delegates work to subagents.

This directory mirrors the layout expected by pi:

```
agentic/pi/
├── settings.json      pi settings (model, extensions, tool wiring)
├── SYSTEM.md          system prompt prepended to every session
├── prompts/           reusable user prompts
├── agents/            subagent definitions (markdown + frontmatter)
└── extensions/        custom tool/behavior extensions (this README)
```

## Extensions

Each subdirectory under `extensions/` is a self-contained pi extension. They
fall into three categories:

- **Tools the agent calls** — `read`, `skill`, `search`, `code-tree`,
  `web-fetch`, `web-search`, `web-browse`, `subagent`, `memory_index`,
  `memory_read`, `memory_save`, `memory_delete`, `memory_suggest`.
- **Behavioural guardrails** (no tools registered) — `no-repeat`, `memory-audit`.
- **Shared internal library** — `_outliner` (consumed by `read` and `search`).

### `read`

Index-backed file reader with no pagination. Three modes:

1. Small file, no symbol → returned verbatim.
2. Large file, no symbol → outline (module doc + one line per symbol with
   signature and doc-first-line).
3. `symbol` set → body of that symbol via `line_start..line_end` from the
   shared index. Supports `Class.method`.

Outline + symbol ranges come from the SQLite index in
`~/.pi/index/<repo-id>/index.db` (shared with `search`). The target file is
incrementally refreshed on every call so edits are picked up without a full
rebuild. Includes a per-session dedupe cache and a MIME sniff that surfaces
images as image content rather than raw bytes.

See [`extensions/read/EXAMPLES.md`](extensions/read/EXAMPLES.md) for sample
outputs across all supported file types — Python, TypeScript, Lua, Rust, Go,
Shell, SQL, CSS, HTML, Markdown, JSON, JSONL, CSV, YAML, and TOML.

### `skill`

Loads a named skill's full `SKILL.md` in one shot. Takes a single `name`
argument (the skill's frontmatter `name`, e.g. `commit`, `fastapi`) and
returns the file verbatim — no outlining, no truncation. Skill discovery
goes through `loadSkills` from `pi-coding-agent`, so the surface matches
exactly what pi advertises in its system prompt.

Why not just use `read`? The local `read` extension returns an outline for
any file over 100 lines, which silently truncates real skills. Splitting
`skill` from `read` also lets the orchestrator load its own playbooks
without being granted general filesystem read access.

### `search`

Per-repo indexed search tool. Builds a SQLite index with a file manifest plus
tree-sitter symbol extraction, then merges definition-first results from
SQLite with ripgrep full-text references. Exact symbol matches are promoted
to the top. The index refreshes incrementally on every call.

`gc.ts` handles index garbage collection; `index-store.ts` is the storage
layer reused by `read`.

### `code-tree`

Directory tree of the repo (or a subdirectory). Token-efficient defaults:
directories only, depth-limited (default 2, max 6), with recursive file
counts per directory. The agent probes deeper by passing `path` and/or
`depth` explicitly. Uses `git ls-files` as the source of truth so
`.gitignore` is honoured automatically; falls back to a filesystem walk
outside a git repo.

### `web-fetch`

Fetches an HTTP(S) URL and collapses it into the smallest useful text form.
HTML is stripped to readable text (scripts, styles, nav boilerplate, SVG,
head, comments removed), entities decoded, whitespace collapsed. Non-HTML
responses (JSON, plain text) are returned as-is. Hard cap on output size;
`max_chars` overrides up to 100k. A `raw: true` flag returns the
unprocessed body.

### `web-search`

DuckDuckGo HTML-endpoint search. Returns the top results (title, URL,
snippet) as a compact Markdown list. Access-controlled: only agents whose
frontmatter lists `web_search` in `tools:` see it (in this config, the
`explorer` subagent).

### `web-browse`

Thin wrapper around the `agent-browser` CLI. Takes a single command string
(e.g. `open https://example.com`, `click @ref-2`, `type input.search hello`)
and returns its stdout/stderr. Session state is preserved across calls by
`agent-browser` itself, so multi-step exploration works as a sequence of
`web_browse` calls.

### `subagent`

Delegates tasks to specialised subagents with isolated context. Modes:

- **single** — one task to one agent.
- **parallel** — `tasks: [...]` runs multiple subagents concurrently.
- **chain** — `chain: [...]` with `{previous}` placeholder threads output
  between steps.

Agents are discovered from `~/.pi/agent/agents/*.md` (user scope) and, when
`agentScope` is `project` or `both`, from `<repo>/.pi/agents/*.md`. Agent
frontmatter declares `tools`, `model`, optional `worktree: true` (run in a
fresh git worktree, merged back on exit), and an optional `skills:`
allow-list which scopes the child's `<available_skills>` block. Per-call
`skills: [...]` arrays at the top level, per task, or per chain step
union-merge with the agent's frontmatter list.

See `extensions/subagent/README.md` for the full frontmatter and
skill-scoping semantics.

### `no-repeat`

Blocks consecutive duplicate tool calls. If the agent calls the same tool
with the same arguments twice in a row, the second call is blocked with a
short nudge telling it to do something different. Catches the common "loop
forever on the same failing call" failure mode and saves tokens. Runs in
both the orchestrator and each subagent process (per-process state).
"Consecutive" means: not separated by any other tool call.

### `memory`

Persistent markdown notes the agent can write to and recall across
conversations. Memories are stored as plain markdown files under
`~/.pi/agent/memories/`:

```
~/.pi/agent/memories/
├── system/                    # system-wide, available to every agent run
│   └── <slug>.md
└── projects/
    └── <project-id>/          # scoped to a git repo
        └── <slug>.md
```

Five tools:

- **`memory_index`** — list all memories (system + project) with one-line
  descriptions. Call this first to discover what's available.
- **`memory_read`** — fetch the full body of one memory by scope + name.
- **`memory_save`** — create or overwrite a memory. Body is markdown; frontmatter
  (name + description) is added automatically.
- **`memory_delete`** — remove a memory.
- **`memory_suggest`** — fuzzy keyword search across all memories. Returns
  top-k results sorted by relevance score. Scores name (×3) > description (×1.5)
  > body (×1), with a bonus for near-matches via Levenshtein distance.

Memory files use frontmatter with `name`, `description`, `created_at`, and
`accessed_at` fields. `accessed_at` is bumped on every `memory_read`; `memory_save`
runs an LRU sweep so a scope never exceeds ~50 files or 256 KB.

### `memory-audit`

Dual-purpose extension:

1. **Background audit** (fires on `turn_end`): spawns a background process that
   scans new conversation lines since the last audit and saves anything worth
   remembering as a memory. Cooldown: 5 minutes between runs.

2. **Auto-injection** (fires on `input`): on each user message, performs fuzzy
   keyword search across all memories and prepends the top-5 results to the user
   message. This injects memories into the conversation context without modifying
   the system prompt (preserving prefix caching).

Both use the same fuzzy keyword search logic: tokenize query and memory text
(lowercase, strip stop words, split on non-alphanumeric), score by token overlap
with Levenshtein bonus for near-matches.

### `_outliner` (library, not a tool)

Shared tree-sitter outliner consumed by `read` and `search`. Registers no
tools. Given a file path and contents, `outline()` returns a list of
structural entries (classes, functions, methods, headings, blocks);
`collapsedView()` renders them as an indented listing that fits a
caller-specified line budget, collapsing the largest classes first when
over budget.

Supported languages: Python, TypeScript (`.ts`/`.tsx`), JavaScript
(`.js`/`.jsx`/`.mjs`/`.cjs`), Vue single-file components, Markdown
headings. Unknown extensions fall back to a heuristic blank-line splitter.
Docstrings (Python triple-quoted, JS/TS `/** */`) are extracted as the
first non-empty line, capped at 80 chars.

See `extensions/_outliner/README.md` for the public API, language table,
and collapsed-view format.
