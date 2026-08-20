# pi

Personal pi-coding-agent configuration: settings, prompts, subagents, and a suite of
custom extensions that shape how the agent reads code, searches the repo, browses the
web, and delegates work to subagents.

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

Each subdirectory under `extensions/` is a self-contained pi extension. They fall into
three categories:

- **Tools the agent calls** — `read`, `skill`, `search`, `code-tree`, `web-browse`,
  `subagent`. (Web search is no longer a local extension — it's the `tavily_search` MCP
  tool; see below.)
- **Behavioural guardrails** (no tools registered) — `no-repeat`, `caffeinate`.
- **Shared internal library** — `_outliner` (consumed by `read` and `search`).

### `read`

Index-backed reader with no pagination. Reads source files, documents, and web pages.
Three modes:

1. Small file, no symbol → returned verbatim.
2. Large file, no symbol → outline (module doc + one line per symbol with signature and
   doc-first-line).
3. `symbol` set → body of that symbol via `line_start..line_end` from the shared index.
   Supports `Class.method`.

Outline + symbol ranges come from the SQLite index in `~/.pi/index/<repo-id>/index.db`
(shared with `search`). The target file is incrementally refreshed on every call so
edits are picked up without a full rebuild. Includes a per-session dedupe cache and a
MIME sniff that surfaces images as image content rather than raw bytes.

**Documents and URLs.** When `read` is passed a document (PDF, DOCX, XLSX, PPTX) or an
http(s) URL, it converts it to Markdown via the `docling` CLI and then renders it
through the same outline/symbol pipeline — so a large PDF shows an outline, and
`symbol="<heading>"` returns just that section. Conversions are cached on disk (keyed by
file content / URL), so re-reading the same document or page skips docling entirely and
reuses the previously parsed Markdown. This subsumes the old `web-fetch` tool: to read a
web page, just `read` its URL. For interactive or JS-heavy pages, use `web-browse`
instead.

See [`extensions/read/EXAMPLES.md`](extensions/read/EXAMPLES.md) for sample outputs
across all supported file types — Python, TypeScript, Lua, Rust, Go, Shell, SQL, CSS,
HTML, Markdown, JSON, JSONL, CSV, YAML, TOML — plus documents and URLs.

### `skill`

Loads a named skill's full `SKILL.md` in one shot. Takes a single `name` argument (the
skill's frontmatter `name`, e.g. `commit`, `fastapi`) and returns the file verbatim — no
outlining, no truncation. Skill discovery goes through `loadSkills` from
`pi-coding-agent`, so the surface matches exactly what pi advertises in its system
prompt.

Why not just use `read`? The local `read` extension returns an outline for any file over
100 lines, which silently truncates real skills. Splitting `skill` from `read` also lets
the orchestrator load its own playbooks without being granted general filesystem read
access.

### `search`

Per-repo indexed search tool. Builds a SQLite index with a file manifest plus
tree-sitter symbol extraction, then merges definition-first results from SQLite with
ripgrep full-text references. Exact symbol matches are promoted to the top. The index
refreshes incrementally on every call.

`gc.ts` handles index garbage collection; `index-store.ts` is the storage layer reused
by `read`.

### `code-tree`

Directory tree of the repo (or a subdirectory). Token-efficient defaults: directories
only, depth-limited (default 2, max 6), with recursive file counts per directory. The
agent probes deeper by passing `path` and/or `depth` explicitly. Uses `git ls-files` as
the source of truth so `.gitignore` is honoured automatically; falls back to a
filesystem walk outside a git repo.

### Web search (`tavily_search`, MCP)

Web search is not a local extension. It's provided by the **Tavily MCP server**, wired
through `pi-mcp-adapter` and configured in `mcp.json`. Tavily is `eager` (always-on)
with `directTools: ["tavily_search"]`, so only the single `tavily_search` tool is
exposed as a first-class tool (Tavily's other MCP tools are hidden). Access-controlled
the same way as any tool: only agents whose frontmatter lists `tavily_search` in
`tools:` see it (in this config, the `explorer` subagent). The API key is read at
runtime from `~/.pi/agent/secrets/tavily-api-key` via the `!cat …` marker in `mcp.json`.

### `web-browse`

Thin wrapper around the `agent-browser` CLI. Takes a single command string (e.g.
`open https://example.com`, `click @ref-2`, `type input.search hello`) and returns its
stdout/stderr. Session state is preserved across calls by `agent-browser` itself, so
multi-step exploration works as a sequence of `web_browse` calls.

### `subagent`

Delegates one task to one specialised subagent per call. The required fields are `agent`
and `task`; optional controls are `cwd`, `model`, `skills`, `agentScope`, and
`confirmProjectAgents`.

For independent work, the orchestrator issues one call per agent/task and sends multiple
native Pi tool calls in the same turn. Pi can then run those calls concurrently. For
dependent work, the orchestrator makes successive calls and carries relevant output from
an earlier result into the next task. The tool does not accept a batch request or
automatically interpolate prior results.

Agents are discovered from `~/.pi/agent/agents/*.md` (user scope) and, when `agentScope`
is `project` or `both`, from `<repo>/.pi/agents/*.md`. Agent frontmatter declares
`tools`, `model`, optional `worktree: true` (run in a fresh git worktree, merged back on
exit), and an optional `skills:` allow-list which scopes the child's
`<available_skills>` block. A call's `skills: [...]` array adds named skills to that
allow-list.

See [`extensions/subagent/README.md`](extensions/subagent/README.md) for the call
fields, frontmatter, skill-scoping, refusal, and worktree semantics.

### `no-repeat`

Blocks consecutive duplicate tool calls. If the agent calls the same tool with the same
arguments twice in a row, the second call is blocked with a short nudge telling it to do
something different. Catches the common "loop forever on the same failing call" failure
mode and saves tokens. Runs in both the orchestrator and each subagent process
(per-process state). "Consecutive" means: not separated by any other tool call.

### `caffeinate`

Keeps the Mac awake **while an agent run is in progress** — even with the lid closed —
so you can kick off a long run, shut the laptop, and let it finish. When the run ends,
normal sleep behaviour is restored: if the lid is closed at that point the Mac sleeps
immediately; if it's open nothing changes.

- `agent_start` → spawns `caffeinate -dimsu` (no idle/display/disk/system sleep) and
  asks a session-lived watcher to set `pmset -a disablesleep 1` (the only switch that
  defeats lid-close sleep).
- `agent_end` → tells the watcher to set `pmset -a disablesleep 0` and kills the
  `caffeinate` process.

`pmset disablesleep` needs root. The extension **never prompts for a password** — it
only activates when passwordless access to `pmset` is already configured. Grant it once
by running this in a terminal (it'll ask for your password the one time, then never
again):

```sh
echo "$USER ALL=(ALL) NOPASSWD: /usr/bin/pmset" | sudo tee /etc/sudoers.d/pi-caffeinate >/dev/null && \
  sudo chmod 440 /etc/sudoers.d/pi-caffeinate && \
  sudo visudo -cf /etc/sudoers.d/pi-caffeinate
```

This writes a scoped drop-in (the grant covers `/usr/bin/pmset` and nothing else), locks
its permissions, and validates the syntax so a typo can't break sudo. Remove it any time
with `sudo rm /etc/sudoers.d/pi-caffeinate`. With it in place, a session-lived watcher
shells out with `sudo -n /usr/bin/pmset` (no prompt, ever) and toggles `disablesleep`
1/0 from a tiny state file pi writes at run start/end. The watcher also restores
`disablesleep 0` and exits if pi dies, so a crash never leaves the Mac unable to sleep.

If the drop-in is missing, the extension stays completely inert and prints a one-time
hint on the first run — the same command above, with your username already filled in —
so it's a copy-paste. No prompts, no half-working state.

Manual control: `/caffeinate status` reports state, `/caffeinate off` disables it for
the session, `/caffeinate on` re-arms it. macOS-only and orchestrator-only (subagents
share the parent's machine, and the parent run already brackets their work).

### `_outliner` (library, not a tool)

Shared tree-sitter outliner consumed by `read` and `search`. Registers no tools. Given a
file path and contents, `outline()` returns a list of structural entries (classes,
functions, methods, headings, blocks); `collapsedView()` renders them as an indented
listing that fits a caller-specified line budget, collapsing the largest classes first
when over budget.

Supported languages: Python, TypeScript (`.ts`/`.tsx`), JavaScript
(`.js`/`.jsx`/`.mjs`/`.cjs`), Vue single-file components, Markdown headings. Unknown
extensions fall back to a heuristic blank-line splitter. Docstrings (Python
triple-quoted, JS/TS `/** */`) are extracted as the first non-empty line, capped at 80
chars.

See `extensions/_outliner/README.md` for the public API, language table, and
collapsed-view format.
