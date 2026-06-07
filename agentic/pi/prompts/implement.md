# implement — plan, build, review, fix (loop until accepted)

**Full implementation flow with iterative review cycles.**

## Flow

```
planner → parallel builders → reviewer → [if needed: parallel builders → reviewer] × N → done
```

1. **Planner** — break the request into an ordered, parallel-friendly plan
2. **Builders (parallel)** — implement the plan in disjoint scopes
3. **Reviewer** — audit the implementation, produce a verdict:
   - **Pass** → done, surface summary
   - **Needs changes** or **Block** → continue to step 4
4. **Builders (parallel)** — fix the issues identified
5. **Reviewer** — audit again (fresh review, not just checking previous bugs)
6. Repeat steps 4–5 until reviewer passes (or user stops)

## Key principles

- **Same reviewer prompt every cycle.** Each review is a fresh audit — the new reviewer
  might find different bugs than the previous one. Don't narrow the scope to only
  previously-identified issues.
- **Parallel builders.** Group fixes into disjoint scopes so multiple builders can run
  in parallel (up to 8 tasks, 4 concurrent).
- **Surface verdict prominently.** If the reviewer returns "Needs changes" or "Block",
  show that clearly and ask the user how to proceed before starting another cycle.
- **Commit after each builder cycle.** Builders must commit their changes before
  finishing (worktree mode merges back on exit).

## When to use

- New features, bug fixes, refactors, tests — any implementation work
- When you want iterative review/fix cycles baked into the flow
- When the user hasn't explicitly requested `/review` (which is reviewer-first for
  auditing existing work)

## Contrast with `/review`

| Prompt       | Flow                                                         |
| ------------ | ------------------------------------------------------------ |
| `/implement` | planner → builders → reviewer → (builder → reviewer) × N     |
| `/review`    | reviewer → (optional builder) — audit existing changes first |
