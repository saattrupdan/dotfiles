# Dotfiles

Personal dotfiles, synced across the author's devices. Each top-level folder is
the config for one tool and is symlinked into place from here (edits to the
deployed config land back in this repo).

## Layout

| Path | Purpose |
|------|---------|
| `nvim/` | Neovim config, built on LazyVim. `init.lua` bootstraps `lua/config/` (options, keymaps, autocmds, lazy.nvim setup) and `lua/plugins/` (one file per plugin). |
| `agentic/` | Configs for AI coding tools and LLM runtimes. |
| `agentic/pi/` | The `pi` agent harness — see its own `agentic/pi/AGENTS.md`. Holds `agents/` (subagent prompts), `extensions/` (TypeScript extensions), `prompts/`, `bin/`, and JSON/Markdown settings. |
| `agentic/skills/` | Skill definitions, one folder per skill (web-service helpers, language conventions, tools). This folder is the ground truth; `sync.sh` symlinks every skill into `~/.pi/agent/skills/`. |
| `agentic/llamacpp/` | llama.cpp settings (`makefile`, `preset.ini`). |

## Conventions

- Commit messages follow Conventional Commits (see recent history: `chore:`,
  `fix:`, `feat:`). Most dotfile syncs land as `chore: Update dot files`.

## Quality checks

The only compiled code is the TypeScript under `agentic/pi/extensions/`. After
creating or editing files there, run both checks **from that directory** (they
use the project-local `tsc`/`eslint`):

```sh
cd agentic/pi/extensions

# Typecheck — the trailing filter drops third-party errors inside dependency
# .d.ts files (the project itself excludes node_modules; skipLibCheck is off).
./node_modules/.bin/tsc -p tsconfig.json --noEmit 2>&1 | grep "error TS" | grep -v node_modules

# Lint — eslint.config.mjs already ignores **/node_modules/**.
./node_modules/.bin/eslint .
```

A clean typecheck prints nothing. The 9 remaining `node_modules` errors are
upstream dependency declaration bugs, so the filter is expected — never "fix"
them by editing files under `node_modules/`.

## Gotchas

- **These files are symlinked into their real locations** (e.g. `~/.config/nvim`).
  Editing here edits the live config, and vice versa.
- **Skills are discovered through symlinks in `~/.pi/agent/skills/`**, not from this
  repo directly. Adding, renaming, or deleting a folder under `agentic/skills/` has no
  effect on the running agent until you re-run `./agentic/skills/sync.sh` (from the repo
  root; `--check` reports drift and exits 1, `--dry-run` previews, `--adopt` also
  repoints links that currently point at another repo). Skills installed elsewhere
  (`~/.agents/skills/`, `gitsky/internal-agentic-coding/skills/`) are linked outside
  this repo's scope and are left alone unless `--adopt` is passed.
- `nvim/lua/plugins/*.lua.disabled` are intentionally disabled — lazy.nvim only
  loads `.lua` files, so the suffix turns a plugin off. Don't rename them to
  re-enable without reason.
- `agentic/pi/extensions/` is a real TypeScript project (`package.json`,
  `tsconfig.json`, `node_modules/`, ESLint). Run its lint/typecheck from that
  directory, not the repo root.
- `agentic/pi/` has its own `AGENTS.md` — read it before touching anything under
  that tree.
