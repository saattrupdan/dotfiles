# pi

Personal pi-coding-agent configuration: settings, prompts, subagents, and a
suite of custom extensions that shape how the agent reads code, searches the
repo, browses the web, and delegates work to subagents.

This directory mirrors the layout expected by pi:

```
agentic/pi/
├── bin/pi             version-controlled CLI launcher
├── profile/           profile validation and startup configuration
├── settings.json      pi settings (model, extensions, tool wiring)
├── prompts/           reusable user prompts
├── agents/            top-level and subagent profiles (markdown + frontmatter)
└── extensions/        custom tool/behavior extensions (this README)
```

## Agent profiles

Plain `pi` uses `agents/main.md` as its system prompt. `pi --agent <name>` starts
another top-level profile; only profiles with `subagent: false` can be selected.
The four specialist profiles have `subagent: true` and can only be delegated to.
Every top-level profile explicitly lists tools, skills, and extensions. Non-main
profiles have separate session storage, so `--resume`
and `--continue` stay within the selected profile. Existing sessions stay with
main. The launcher is symlinked at `~/.pi/agent/bin/pi`; the global `SYSTEM.md`
is no longer used. On another machine with an older launcher, switch it over from
this repository's root (the old launcher remains available for rollback):

```sh
mv ~/.pi/agent/bin/pi ~/.pi/agent/bin/pi-before-profiles
ln -s "$PWD/agentic/pi/bin/pi" ~/.pi/agent/bin/pi
rm ~/.pi/agent/SYSTEM.md  # remove the old symlink
pi --version
```

The `agents/`, `extensions/`, and `skills/` links must already be in place.

## Native memory bundle

Use `~/memory` as the canonical OKF bundle root, independent of Pi's config.
On this machine it is registered for continuous Jottacloud Backup as `memory`.
On another machine, create and register it with:

```sh
mkdir -m 700 "$HOME/memory"
jotta-cli add "$HOME/memory" --name memory
```

The private `pi --agent librarian` profile loads five concept tools and the
tool-free `rate-limit-retry` extension. Main exposes only `store_memory` and
`recall_memory`. `store_memory` durably queues a write under
`~/memory/requests/` and immediately returns a job ID, not a storage
confirmation. A detached worker starts isolated librarian sessions; failed and
interrupted requests retain their input and error for inspection. `recall_memory`
waits for a read-only librarian session, which registers only the search tool.
The startup snapshot gives main a bounded overview of local concepts and points
it to `recall_memory` for details.

OKF Markdown and the atomically published `~/memory/embeddings.sqlite` are
backed up together. That SQLite
file holds one 1,024-dimensional float vector per concept, keyed by its bundle
path and content hash. SQLite FTS5 BM25 and HNSW indexes build in memory from
concept Markdown and `embeddings.sqlite` when the librarian starts. No
`search.sqlite` or second vector store is kept on disk. Hybrid results use
reciprocal rank fusion. The old Understory bundle and its `understory-bundle`
backup remain as inactive rollback copies; its 92 historical failed requests
were not replayed or imported. The migrated bundle passed a Jottacloud restore
check with 649 matching Markdown/SQLite files and 603 valid embeddings.
Install the memory extension's local SQLite, HNSW, and YAML dependencies on
each device before starting the librarian:

```sh
npm ci --prefix agentic/pi/extensions/memory
```

The embedding endpoint is the llama.cpp server at `127.0.0.1:8080`, using
`jina-embeddings-v5-omni-small-retrieval`.

Inspect or retry queued writes with the local CLI:

```sh
node agentic/pi/extensions/memory-handoff/queue-cli.mjs status
node agentic/pi/extensions/memory-handoff/queue-cli.mjs list failed
node agentic/pi/extensions/memory-handoff/queue-cli.mjs show JOB_ID
node agentic/pi/extensions/memory-handoff/queue-cli.mjs retry JOB_ID
```

Interrupted or partially applied writes require checking the concept first;
then use `retry JOB_ID --confirmed`. The CLI also supports `pause` and `resume`.
The queue and `~/memory/requests/worker.log` are part of the memory backup.

### Hourly cleaning

On macOS, install the hourly launchd job after restoring the native bundle:

```sh
node agentic/pi/extensions/memory/install-cleaning.mjs
launchctl print "gui/$(id -u)/com.saattrupdan.pi-memory-cleaning"
```

It runs on load and at minute zero every hour. A sleeping laptop runs one
missed calendar invocation after waking. Temporary network failures retry in
the librarian; a session still failing after 20 minutes logs the failure and
the next invocation starts a fresh lint instead of resuming a stale model turn.
A lock prevents overlapping sessions. Scheduled sessions can search, update,
and lint, but cannot create or delete concepts. They make at most five safe
repairs per run; ambiguous links, duplicates, and orphans remain for review.
Each run logs its issue counts and result in `~/memory/cleaning.log`, with its
latest status in `~/memory/.cleaning-state.json`.

## Extensions

Each subdirectory under `extensions/` is a self-contained pi extension. They
fall into three categories:

- **Tools the agent calls** — `read`, `skill`, `search`, `code-tree`,
  `web-browse`, `web-search`, `subagent`. `web_search` uses the private local
  SearXNG service described below.
- **Behavioural guardrails** (no tools registered) — `caffeinate`.
- **Shared internal library** — `_outliner` (consumed by `read` and `search`).

### `read`

Index-backed reader with no pagination. Reads source files, documents, and
web pages. Three modes:

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

**Documents and URLs.** When `path` is a document (PDF, DOCX, XLSX, PPTX) or
an http(s) URL, `read` converts it to Markdown via the `docling` CLI and then
renders it through the same outline/symbol pipeline — so a large PDF shows an
outline, and `symbol="<heading>"` returns just that section. Conversions are
cached on disk (keyed by file content / URL), so re-reading the same document
or page skips docling entirely and reuses the previously parsed Markdown. This
subsumes the old `web-fetch` tool: to read a web page, just `read` its URL.
For interactive or JS-heavy pages, use `web-browse` instead.

See [`extensions/read/EXAMPLES.md`](extensions/read/EXAMPLES.md) for sample
outputs across all supported file types — Python, TypeScript, Lua, Rust, Go,
Shell, SQL, CSS, HTML, Markdown, JSON, JSONL, CSV, YAML, TOML — plus documents
and URLs.

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

### Web search (`web_search`, SearXNG)

The native `web_search` extension calls the private SearXNG container at
`http://127.0.0.1:8888`. Start and smoke-test it with
`services/searxng/{setup,start,smoke}.sh`; its operation, immutable image pin,
loopback binding, privacy limits, validation results, and troubleshooting are
in [`services/searxng/README.md`](services/searxng/README.md). The extension
supports bounded result counts, SearXNG language/categories/time filters and
safe-search, and reports unavailable, malformed, empty, and partial responses
separately. Full pages are fetched separately with `read`, keeping search
results compact.

SearXNG replaced the former Tavily MCP integration on 9 September 2026. The
old Tavily key is not read by Pi; it may remain in the local secrets directory
only as temporary rollback material.

### `web-browse`

Drives native Firefox through Selenium/geckodriver using a dedicated persistent
profile outside the repository. It defaults to headless sessions and supports explicit
headed sessions, compact semantic snapshots with `@eN` refs, navigation, clicks, and
non-secret form entry. Headed sessions provide a human handoff for unlocking Bitwarden
and triggering autofill without sending the vault password through Pi.

Run `help` for the command list. The tool intentionally does not expose password
values, cookies, storage, arbitrary JavaScript, network bodies, or screenshots.
The default macOS profile is
`~/Library/Application Support/Pi/firefox-profile`; Selenium Manager resolves
geckodriver automatically, with `brew install geckodriver` as a fallback.

### `subagent`

Delegates one task to one specialised subagent per call. The required fields are
`agent`, a 1–5-word `taskName`, and `task`; optional controls are `cwd`, `model`,
`skills`, `agentScope`, and `confirmProjectAgents`.

For independent work, the orchestrator issues one call per agent/task and sends
multiple native Pi tool calls in the same turn. Pi can then run those calls
concurrently. For dependent work, the orchestrator makes successive calls and
carries relevant output from an earlier result into the next task. The tool does
not accept a batch request or automatically interpolate prior results.

Agents are discovered from `~/.pi/agent/agents/*.md` (user scope) and, when
`agentScope` is `project` or `both`, from `<repo>/.pi/agents/*.md`. Agent
frontmatter declares `subagent: true`, `tools`, `model`, `extensions`, optional
`worktree: true` (run in a fresh git worktree, merged back on exit), and an
optional `skills:` allow-list
which scopes the child's `<available_skills>` block. A call's `skills: [...]`
array adds names to an explicit frontmatter allow-list; when the field is
omitted, the child's normal unrestricted skill discovery remains unchanged.

See [`extensions/subagent/README.md`](extensions/subagent/README.md) for the
call fields, frontmatter, skill-scoping, refusal, and worktree semantics.

### `caffeinate`

Keeps the Mac awake **while an agent run or `/loop` is in progress** — even
with the lid closed. A loop stays awake between runs, during compaction, and
while checking its completion condition. After a loop ends with the lid shut,
the Mac stays awake until the lid reopens (or `/caffeinate off`/shutdown), so
finishing a loop does not trigger clamshell sleep. This consumes battery power.
For ordinary runs, normal sleep behaviour returns when the run ends.

- `agent_start` → spawns `caffeinate -dimsu` (no idle/display/disk/system sleep)
  and asks a session-lived watcher to set `pmset -a disablesleep 1` (the only
  switch that defeats lid-close sleep).
- `agent_end` → releases the watcher and `caffeinate` process unless a loop is
  active; a stopped loop waits for any current run to finish, then releases when
  the lid is open.

`pmset disablesleep` needs root. The extension **never prompts for a password** —
it only activates when passwordless access to `pmset` is already configured.
Grant it once by running this in a terminal (it'll ask for your password the one
time, then never again):

```sh
echo "$USER ALL=(ALL) NOPASSWD: /usr/bin/pmset" | sudo tee /etc/sudoers.d/pi-caffeinate >/dev/null && \
  sudo chmod 440 /etc/sudoers.d/pi-caffeinate && \
  sudo visudo -cf /etc/sudoers.d/pi-caffeinate
```

This writes a scoped drop-in (the grant covers `/usr/bin/pmset` and nothing
else), locks its permissions, and validates the syntax so a typo can't break
sudo. Remove it any time with `sudo rm /etc/sudoers.d/pi-caffeinate`. With it in
place, a session-lived watcher shells out with `sudo -n /usr/bin/pmset` (no
prompt, ever). Watchers coordinate through a shared lock and reconcile the
global `disablesleep` setting from all live Pi sessions. Ending one session
cannot release another's hold; when the last session ends or dies, normal sleep
returns. Each watcher also checks the actual setting every second, including
after a power-source change. The existing 35 °C battery cutoff still applies.

If the drop-in is missing, the extension stays completely inert and prints a
one-time hint on the first run — the same command above, with your username
already filled in — so it's a copy-paste. No prompts, no half-working state.

Manual control: `/caffeinate status` reports state, `/caffeinate off` disables
it for the session, `/caffeinate on` re-arms it. macOS-only and
orchestrator-only (subagents share the parent's machine, and the parent run
already brackets their work).

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
