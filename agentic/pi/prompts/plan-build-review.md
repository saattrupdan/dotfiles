---
description: Composite flow — planner produces a plan, multiple builders execute it in parallel, reviewer audits the result.
---
Execute this composite flow for the request: "$@"

1. **Plan.** Call the `subagent` tool in `single` mode with `agent: "planner"` and `task: "$@"`. The planner will return a Markdown plan whose final section explicitly identifies steps that can run in parallel.

2. **Build (parallel).** Read the plan. For every group of steps the planner marked as "can run in parallel", make ONE call to the `subagent` tool in `parallel` mode with `tasks: [...]`, one entry per step, each with `agent: "builder"` and a `task` that quotes the step verbatim (title, files, acceptance criteria). For sequential dependencies, do a follow-up parallel (or single) call after the prior group has merged. Always include in each builder task an instruction to commit its work before finishing.

3. **Review.** Once all builder groups have completed and their worktrees merged, call the `subagent` tool in `single` mode with `agent: "reviewer"` and a `task` that points the reviewer at the commits just produced (e.g. "Review the most recent N commits implementing: $@").

4. **Report.** Summarise the planner's plan, what the builders did (by commit subject), and the reviewer's verdict. If the reviewer says "Needs changes" or "Block", surface that prominently and ask the user how to proceed.

Do not edit any files yourself. Do not call any tool other than `subagent` and the user-facing `question` tool.
