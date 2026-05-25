# agents-md

Reference for writing a good `AGENTS.md` — a top-level file that orients a
coding agent to a repo.

## When to use

- Creating an `AGENTS.md` in a repo that doesn't have one.
- Reviewing or updating an existing `AGENTS.md`.
- Deciding whether a piece of information belongs in `AGENTS.md`, `README.md`,
  inline comments, or a design doc.

## Quick start

1. Read the repo: top-level files, build config, CI config, any existing docs.
2. Run the project locally if you can — note every step that wasn't obvious.
3. Draft against the skeleton in `SKILL.md` (What / Stack / Layout / Running /
   Testing / Conventions / Gotchas).
4. Cut anything that's already obvious from the code.
5. Sanity-check against the checklist at the bottom of `SKILL.md`.

## The one rule

Every line in `AGENTS.md` must hold information the code itself does not make
obvious. If you can derive it by reading the repo for 30 seconds, leave it
out. The file earns its place by capturing **non-obvious** facts — symlinks,
generated files, locked-down components, ordering constraints, sharp edges.

## Common mistakes

- Restating the file tree.
- Including a long architectural narrative (belongs in a design doc).
- Marketing language ("blazing-fast", "modern stack").
- Stale commands that no longer work.
- Listing dependencies that `package.json` / `pyproject.toml` already lists.
- Forgetting to flag secrets, symlinks, and generated files.

See `SKILL.md` for the full structure, gotcha taxonomy, writing style, and
maintenance guidance.
