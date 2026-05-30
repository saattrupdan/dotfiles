# Pi Agent Runtime Config

This directory is the **runtime config + state root** for **Pi**, a local agentic CLI harness. Equivalent of `~/.claude/` — Pi reads it on startup to discover models, agents, extensions, skills, prompts, and a system prompt, plus writes session state here.

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
│   ├── subagent/      # Delegation: single / parallel / chain modes
│   ├── skill/         # Load named skill SKILL.md verbatim
│   ├── web-browse/    # Headless browser interaction
│   ├── web-search/    # Web search (DuckDuckGo)
│   ├── memory/        # Memory CRUD (index, read, save, delete, suggest)
│   ├── no-repeat/     # Prevent duplicate tool calls
│   ├── copy-paste/    # Clipboard operations
│   ├── notify/        # Desktop notifications
│   ├── question/      # User question proxy
│   ├── splash/        # Splash screen
│   ├── non-interactive/ # Disable interactive features
│   ├── _outliner/     # Library: tree-sitter structural outliner
│   └── _question_protocol/ # Library
├── prompts/           # Slash-command flow definitions
├── skills/            # Symlinked to ~/.pi/agent/skills/ (shared skill library)
└── bin/               # Local binaries (e.g. memory-audit helper)
```

## Key agents

| Agent      | Role | Worktree | Tools |
|------------|------|----------|-------|
| `planner`  | Turns requests into ordered, parallel-friendly plans. Read-only. | No | `read`, `memory_*`, `question` |
| `builder`  | Implements one scoped code change. Commits before exiting. | **Yes** | `search`, `read`, `write`, `edit`, `bash`, `memory_*`, `question` |
| `explorer` | Read-only navigation of local codebase and the web. | No | `code_tree`, `search`, `read`, `web_browse`, `web_search`, `memory_*`, `question` |
| `reviewer` | Audits recent commits, produces verdict. | No | `read`, `search`, `bash`, `memory_*`, `question` |

Only the **orchestrator** (you) may call `subagent`. Subagents may not delegate further.

## Extensions (tools)

Each subdirectory in `extensions/` is a TypeScript plugin registering tools. The orchestrator uses `subagent` to invoke them.

**Critical extensions:**
- **`read`** — Custom reader backed by SQLite outline index. Three modes: verbatim (≤100 lines), outline (>100 lines, no pagination), or `symbol=` for a single symbol's body. Also reads documents (PDF, DOCX, XLSX, PPTX) and http(s) URLs by converting them to Markdown via the `docling` CLI (cached on disk), then rendering them like any Markdown file. `SYSTEM.md` is intercepted and returned as a 300-char preview. Images pass through to the image reader.
- **`skill`** — Loads a named skill's `SKILL.md` verbatim (no outlining, no truncation). Use this for skill content; `read` will truncate.
- **`subagent`** — Delegation tool. Three call modes: `single`, `parallel` (up to 8 tasks, 4 concurrent), `chain` (sequential with `{previous}` substitution). No CLI flags — JSON params only.
- **`_outliner`** — Shared library (underscore prefix = not loaded as extension). Tree-sitter-based structural outliner for Python, TS/JS/Vue/Markdown.

## Skills

Skills are in `skills/` (symlinked from `dotfiles/agentic/skills`). Each agent declares which skills it may use in its frontmatter (`skills:` allow-list). Omitted = all discoverable; empty array = none.

## Important notes

- **`auth.json`** contains OAuth tokens. Never commit, paste, or screenshot it.
- **Most files are symlinks** into `~/gitsky/dotfiles/agentic/`. Edit via the symlink — the dotfiles repo is the source of truth. Commit changes there.
- **`SYSTEM.md` is intercepted** by the `read` extension — don't expect verbatim content.
- **Builders run in isolated git worktrees.** They must commit before exiting. Parallel builders are safe as long as scopes are disjoint.
- **No pagination on `read`.** Use `symbol=` or `search` to locate content in large files.
- **`memory-audit`** (in `bin/`) runs background audits. Watch for crashes when `CLEANUP_MEM_DIR` points to empty/nonexistent dirs.

## Flow

Slash commands (`prompts/`) define canonical flows:
- `/plan-build-review` — planner → parallel builders → reviewer → memory-audit
- `/plan-and-build` — same, minus review
