---
description: Reviewer audits recent commits, then builder implements fixes if needed.
---

1. **Review.** Call the `subagent` tool in `single` mode with `agent: "reviewer"` and
   `task: "$@"`. If `$@` is empty (no argument provided), use this default task: `"Audit
   recent changes and return a verdict (Pass / Needs changes / Block) with findings. If
   you're on a separate branch then 'recent changes' are all changes done on the branch.
   If you're on the main branch, then it's recent commits. Always check uncommitted
   changes as well."` When an argument is provided, the caller is specifying the scope:
   a branch name (`review main`), commit range (`review HEAD~3`), specific files
   (`review src/`), or focus area (`review for type errors`). Pass the argument to the
   reviewer to scope the audit.
2. **Build (if needed).** If the reviewer's verdict is "Needs changes" or "Block", treat
   the reviewer's findings like a plan. Group the issues by independence (like the
   planner does). For each group that can run in parallel, make ONE call to `subagent`
   in `parallel` mode with `tasks: [...]`, one entry per issue, each with
   `agent: "builder"` and a `task` that quotes the reviewer's issue verbatim and
   instructs the builder to fix it. For sequential dependencies, run groups one after
   another. Always include in each builder task an instruction to commit before
   finishing.
3. **Report.** Summarise the reviewer's verdict and findings. If changes were made,
   include the builder's commit subject. If the verdict was "Needs changes" or "Block"
   and no changes were made, surface that prominently and ask the user how to proceed.

**Key principle:** Don't plan or build before reviewing — the whole point of `/review`
is to **audit what exists** before deciding whether changes are needed. Only spawn
`builder`(s) if the reviewer finds issues ("Needs changes" or "Block" verdict).

Use only the `subagent` and `question` tools.
