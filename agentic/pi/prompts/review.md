---
description: Reviewer audits recent changes, then builder implements fixes if needed.
---
Execute this flow for the request: "${@:-Review your changes.}"

1. **Review.** Call the `subagent` tool in `single` mode with `agent: "reviewer"` and
   `task: "$@"`. The reviewer will audit the recent commits/changes and return a verdict
   (Pass / Needs changes / Block) with findings.
2. **Build (if needed).** If the reviewer's verdict is "Needs changes" or "Block", treat
   the reviewer's findings like a plan. Group the issues by independence (like the
   planner does). For each group that can run in parallel, make ONE call to `subagent`
   in `parallel` mode with `tasks: [...]`, one entry per issue, each with `agent:
   "builder"` and a `task` that quotes the reviewer's issue verbatim and instructs the
   builder to fix it. For sequential dependencies, run groups one after another. Always
   include in each builder task an instruction to commit before finishing.
3. **Report.** Summarise the reviewer's verdict and findings. If changes were made,
   include the builder's commit subject. If the verdict was "Needs changes" or "Block"
   and no changes were made, surface that prominently and ask the user how to proceed.

Use only the `subagent` and `question` tools.
