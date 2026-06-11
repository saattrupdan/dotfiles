---
name: agents-md
description: Conventions for writing a good AGENTS.md file — a top-level orientation document that helps coding agents work effectively in a repo. Use when creating, updating, or reviewing AGENTS.md.
tagline: Write an AGENTS.md that helps agents land changes correctly on the first try
last-updated: 2026-05-23
autoload:
  tools:
    - read
    - write
    - edit
  files:
    - AGENTS.md
    - CLAUDE.md
---

## What AGENTS.md is for

AGENTS.md is a top-level Markdown file (sibling to `README.md`) that orients a
coding agent — a fresh assistant with no prior context — to a repository. It is
**not** user documentation, not a tutorial, and not a marketing page. Its only
audience is an agent about to make changes.

A good AGENTS.md answers, in order:

1. **What is this repo?** One or two sentences.
2. **What stack / runtime?** So the agent picks the right tools.
3. **How is it laid out?** So the agent can find things.
4. **How do I run / test / build it?** Exact commands.
5. **What conventions matter?** Style, commit format, branching.
6. **What are the gotchas?** Non-obvious traps, sharp edges, generated files.

If a fact is *obvious from reading the code*, leave it out. AGENTS.md earns its
place by holding the things the code does **not** say.

## Structure

Use this skeleton as a starting point. Drop sections that don't apply, add
sections only when the repo genuinely needs them.

```markdown
# <Repo name>

<One paragraph: what this is, who uses it, what problem it solves.>

## Stack

<Languages, frameworks, runtime versions, package manager. Be specific:
"Python 3.12 + FastAPI + SQLModel + Postgres 16, managed with uv" beats
"Python web app".>

## Layout

<Tree or table of top-level directories with one-line purpose each. Only
include dirs that aren't self-explanatory.>

## Running it

<Exact commands. Assume nothing is installed yet.>

## Testing

<How tests are run. Which framework. Where they live. Any test that's slow,
flaky, or requires services.>

## Conventions

<Commit format, branch naming, code style tool, anything enforced by CI.>

## Gotchas

<Bulleted list of non-obvious things. See the gotchas guide below.>
```

## What to put in "Gotchas"

This is the highest-leverage section. Include items that would cause an
otherwise-correct change to break:

- **Generated files** ("`src/api/client.ts` is generated from `openapi.yaml` —
  don't hand-edit").
- **Symlinks** ("`config/` is symlinked to a dotfiles repo — edits land there").
- **Secrets** ("`auth.json` contains live tokens; never commit or paste").
- **Naming traps** (leading underscore meaning "do not load", reserved
  filenames, case-sensitive routing).
- **Required ordering** ("run migrations before seeding").
- **Locked-down components** ("the orchestrator deliberately has no `bash`
  tool — don't try to add one").
- **Cross-cutting state** (worktrees, shared caches, background daemons).
- **Race / parallelism rules** ("builders running in parallel must stay within
  scope to keep merges clean").
- **Deprecated paths** that look current but aren't.

## Writing style

- **Concrete over abstract.** "Run `uv run pytest tests/unit -x`" beats
  "run the unit tests".
- **Imperative for actions** ("Run", "Edit", "Don't commit"), not
  "you may want to consider…".
- **Short sections.** If a section is over 20 lines, ask whether half of it
  belongs in code comments or a dedicated doc.
- **Link to authoritative docs** rather than restating them. If `CONTRIBUTING.md`
  already covers commit format, point to it; don't duplicate.
- **Date or version anything time-sensitive.** A model name, a Python version,
  a "current sprint goal" — note when it was true.
- **No marketing.** Skip "blazing-fast", "modern", "elegant".
- **No emojis** unless the repo's existing docs use them.

## What NOT to include

- Long architectural rationales — those belong in design docs or ADRs.
- API reference material — that's for `README.md` or generated docs.
- Personal preferences disguised as rules.
- Anything that changes weekly (sprint goals, current TODOs).
- Tutorials. AGENTS.md is reference, not pedagogy.
- Restating what the file tree already shows ("`src/` contains source code").

## Maintenance

- Treat AGENTS.md like code: update it in the same PR as the change it
  describes. Stale guidance is worse than no guidance.
- When an agent gets something wrong because AGENTS.md didn't warn it, that's
  a signal to add a gotcha.
- When a gotcha stops being true (the generated file becomes hand-written,
  the symlink goes away), delete the line. Don't leave fossils.

## Quick checklist

Before committing an AGENTS.md, scan it against this list:

- [ ] A new contributor agent could clone, run, and test the repo using only
      this file plus the commands it cites.
- [ ] Every gotcha is something the code itself does not make obvious.
- [ ] No section is duplicating `README.md` or `CONTRIBUTING.md`.
- [ ] No emojis, no marketing language, no "we" / "our".
- [ ] Commands are copy-pasteable and current.
- [ ] Symlinks, generated files, and secrets are all called out.
