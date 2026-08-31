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
- **Always push after committing** (`git push origin main`, direct to `main`). This repo
  exists to sync config between devices, so an unpushed commit is invisible to the other
  machines; re-run `git pull --rebase origin main` first if it was updated elsewhere.

## Quality checks

The only compiled code is the TypeScript under `agentic/pi/extensions/`. After
creating or editing files there, run both checks **from that directory** (they
use the project-local `tsc`/`eslint`):

```sh
cd agentic/pi/extensions

# Typecheck — the trailing filter drops errors from third-party TypeScript
# sources (pi-mcp-adapter ships .ts, which mcp-collapse imports).
./node_modules/.bin/tsc -p tsconfig.json --noEmit 2>&1 | grep "error TS" | grep -v node_modules

# Lint — eslint.config.mjs already ignores **/node_modules/**.
./node_modules/.bin/eslint .
```

A clean typecheck prints nothing and a clean lint reports 0 errors (the ~26
`no-explicit-any` warnings are pre-existing style noise, not failures).

**How `@earendil-works/*` resolves for the typecheck.** `tsconfig.json` maps
those specifiers and `typebox` onto `extensions/node_modules`, and `setup.sh`
(section 5b) fills that directory with symlinks to the packages of the pi build
that actually runs — located from the pinned launcher, with `npm root -g` as
fallback. That indirection is load-bearing: each extension's own
`dependencies: {"@earendil-works/pi-coding-agent": "*"}` installs a *published*
copy, and mixing it with the live build makes the same interface two unrelated
types (`TS2719` on every `registerTool`). Consequences:

- `TS2307: Cannot find module '@earendil-works/...'` for every extension means
  the links are missing or stale (pi was upgraded/removed, or a fresh clone).
  Re-run `./agentic/pi/setup.sh`; it also installs the root `@types/node`.
- Run `npm install` inside `extensions/` last, or re-run `setup.sh` after it —
  npm prunes the foreign symlinks.
- Never add absolute paths (a Node version directory, an nvm root) to
  `tsconfig.json`; they break on another machine. `skipLibCheck` stays on so
  dependency `.d.ts` files, including pi's own, are trusted.

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
