---

# Pi token-reduction plan — Wave 4

## Goal

Wire skill scoping on the child side so `<available_skills>` only contains the agent's permitted skills.

## Wave 4 — Skill scoping: child-side wiring

### Approach: temp-dir-of-symlinks (no core changes)

1. **Extension creates temp skills dir** — before spawning child, create a temp directory containing symlinks to only the allow-listed SKILL.md files.
2. **Pass `PI_SKILL_PATHS`** — set env var to point to the temp dir. The child's existing `loadSkills` already supports this.
3. **Clean up** — remove temp dir on child exit (or let OS clean up; temp dirs are short-lived).

### Files to change
- `agentic/pi/extensions/subagent/index.ts` — add the temp-dir creation + `PI_SKILL_PATHS` logic in `runSingleAgent`.
- Verify the child's `loadSkills` actually respects `PI_SKILL_PATHS` (probe `$PI/dist/core/skills.js`).

### Files to probe
- `$PI/dist/core/skills.js` L258–279 — where `<available_skills>` is generated.
- Confirm `loadSkills` accepts a `skillPaths` param and filters discovery to that path.

### Acceptance
- Spawn child with empty skill list → `<available_skills>` is empty.
- Spawn builder → only the 9 allow-listed skills appear.
- Pass `skills: ["lex-dk"]` in task → that skill appears additively.

## Wave 5 — Reviewer

Reviewer over Wave 4 commits.

---