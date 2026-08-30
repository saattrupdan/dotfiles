# Pi Agent Runtime Config

This directory is the **runtime config + state root** for **Pi**, a local agentic CLI
harness. Equivalent of `~/.claude/` — Pi reads it on startup to discover models, agents,
extensions, skills, prompts, and a system prompt, plus writes session state here.

## Directory layout

```
agentic/pi/
├── SYSTEM.md          # Orchestrator system prompt
├── settings.json      # Provider/model/thinking defaults
├── models.json        # Provider + model registry
├── auth.json          # OAuth tokens (secret — do not commit/share)
├── agents/            # Subagent definitions (*.md, YAML frontmatter)
│   ├── planner.md     # Plan tasks → ordered parallel-friendly plan
│   ├── builder.md     # Implement scoped changes (runs in git worktree)
│   ├── explorer.md    # Read-only codebase + web navigation
│   └── reviewer.md    # Audit recent commits, verdict Pass/Needs changes/Block
├── extensions/        # Tool plugins (TypeScript)
│   ├── read/          # Index-backed reader (files, docs, URLs; outline + symbol modes)
│   ├── search/        # Repo-wide search + outline index
│   ├── code-tree/     # Structural project tree navigation
│   ├── subagent/      # One agent/task delegation per call
│   ├── skill/         # Load named skill SKILL.md verbatim
│   ├── web-browse/    # Headless browser interaction
│   ├── no-repeat/     # Prevent duplicate tool calls
│   ├── copy-paste/    # Clipboard operations
│   ├── notify/        # Desktop notifications
│   ├── question/      # User question proxy
│   ├── splash/        # Splash screen
│   ├── non-interactive/ # Disable interactive features
│   ├── _outliner/     # Library: tree-sitter structural outliner
│   └── _question_protocol/ # Library
├── prompts/           # Slash-command flow definitions
├── themes/            # TUI themes
└── setup.sh           # Bootstrap: symlinks (skills via agentic/skills/sync.sh), models.json, node + npm deps
```

## Key agents

| Agent      | Role                                                             | Worktree | Tools                                                                              |
| ---------- | ---------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------- |
| `planner`  | Turns requests into ordered, parallel-friendly plans. Read-only. | No       | `read`, `memory_query`, `question`                                     |
| `builder`  | Implements one scoped code change. Commits before exiting.       | **Yes**  | `search`, `read`, `write`, `edit`, `bash`, `memory_query`, `question`  |
| `explorer` | Read-only navigation of local codebase and the web.              | No       | `code_tree`, `search`, `read`, `web_browse`, `tavily_search`, `memory_query`, `question` |
| `reviewer` | Audits recent commits, produces verdict.                         | No       | `read`, `search`, `bash`, `memory_query`, `question`                   |

Only the **orchestrator** (you) may call `subagent`. Subagents may not delegate further.
Subagents can **query** memory (`memory_query`) but cannot write it — only the
orchestrator has `memory_add` / `_update`.

## Extensions (tools)

Each subdirectory in `extensions/` is a TypeScript plugin registering tools. The
orchestrator uses `subagent` for one agent/task per call. A call requires `agent` and `task`
and may also set `cwd`, `model`, `skills`, `agentScope`, or `confirmProjectAgents`.

For independent tasks, issue multiple native Pi subagent tool calls in the same turn so
Pi can run them concurrently. For dependent tasks, make successive calls and carry the
relevant result into the next task. Keep planning parallel-friendly and give each
worktree builder a disjoint scope.

**Critical extensions:**

- **`read`** — Custom reader backed by SQLite outline index. Three modes: verbatim (≤100
  lines), outline (>100 lines, no pagination), or `symbol=` for a single symbol's body.
  Also reads documents (PDF, DOCX, XLSX, PPTX) and http(s) URLs by converting them to
  Markdown via the `docling` CLI (cached on disk), then rendering them like any Markdown
  file. `SYSTEM.md` is intercepted and returned as a 300-char preview. Images pass
  through to the image reader.
- **`skill`** — Loads a named skill's `SKILL.md` verbatim (no outlining, no truncation).
  Use this for skill content; `read` will truncate.
- **`subagent`** — Delegates one agent/task per call. Optional call controls are `cwd`,
  `model`, `skills`, `agentScope`, and `confirmProjectAgents`. Use multiple native calls
  for concurrency and successive calls for sequencing.
- **`_outliner`** — Shared library (underscore prefix = not loaded as extension).
  Tree-sitter-based structural outliner for Python, TS/JS/Vue/Markdown.

## Skills

Skill **definitions** live in the dotfiles repo at `dotfiles/agentic/skills/` (one folder
per skill, each with a `SKILL.md`); that folder is the ground truth. Pi discovers skills
through `~/.pi/agent/skills/`, which holds one symlink per skill — created by
`agentic/skills/sync.sh`. Add/rename/delete a skill, then re-run that script (`--check`
reports drift). A few skills are installed outside the repo (`~/.agents/skills/`,
`gitsky/internal-agentic-coding/skills/`) and are linked in separately.

Each agent declares which skills it may use in its frontmatter (`skills:` allow-list).
Omitted = all discoverable; empty array = none.

## Important notes

- You **cannot** edit `node_modules/` files directly (including the Pi agent framework
  itself), you have to make an extension instead.
- **`auth.json`** contains OAuth tokens. Never commit, paste, or screenshot it.
- **Most files are symlinks** into `~/gitsky/dotfiles/agentic/`. Edit via the symlink —
  the dotfiles repo is the source of truth. Commit changes there.
- **`SYSTEM.md` is intercepted** by the `read` extension — don't expect verbatim
  content.
- **Builders run in isolated git worktrees.** They must commit before exiting. Parallel
  builders are safe as long as scopes are disjoint.
- **No pagination on `read`.** Use `symbol=` or `search` to locate content in large files.

### User questions

The `question` tool is for material user-level decisions only: unresolved user
intent, user-visible scope or behavior, meaningful constraints or risk, or permission
for consequential actions. Agents must resolve routine implementation choices and
uncertainty from tool or subagent output themselves. Any question must be
self-contained and phrased around the user's goals and practical consequences, not
internal implementation details.

## Flow

Slash commands (`prompts/`) define canonical flows:

- `/implement` — planner → parallel builder calls → reviewer → (builder → reviewer) × N
  until accepted
- `/review` — reviewer-first audit of existing changes (optional builder if issues
  found)
- `/plan` — just call planner, no implementation

These flows describe orchestration at the Pi level. Each arrow is a successive tool
call, and independent builder work can be issued concurrently when scopes are disjoint.
