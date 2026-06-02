# create-a-skill

Template and conventions for creating new skills in the Pi agent system.

This is a **reference skill** — it documents the standard framework for creating
new skills, including SKILL.md structure, CLI patterns, test harness setup, and
common gotchas.

Use it as a checklist and template when adding new capabilities to the Pi agent
system.

## Quick start

1. **Copy the template files** from this directory to your new skill:

```bash
cd skills
cp -r create-a-skill your-new-skill
cd your-new-skill
```

2. **Replace placeholders** — the template uses:
   - `your-skill-name` → your skill (e.g., `bolig-dk`)
   - `your_skill` → Python package (e.g., `bolig_dk`)
   - `your-cmd` → CLI command (e.g., `bolig`)

3. **Follow the checklist** in `SKILL.md` to build:
   - SKILL.md — procedural instructions, API reference, gotchas
   - README.md — requirements, quickstart, commands table
   - `<skill_name>/` — CLI package (standard library only)
   - `pyproject.toml` — package metadata
   - `tests/test.ts` — automated test harness (22 prompts, 3-run consensus)

4. **Test your skill** — run `bun run tests/test.ts` and achieve 3 clean runs

## Files

- **SKILL.md** — Full template + conventions (this is the main reference)
- **README.md** — This file (quickstart guide)

See existing skills (`bolig-dk`, `transport-dk`, `lex-dk`, `dmi-dk`) for working
examples.
