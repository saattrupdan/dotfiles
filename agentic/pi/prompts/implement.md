---
description: Full implementation flow with iterative review cycles.
---
Execute this flow for the request: "${@:-Implement the requested change.}"

1. **Plan.** Call the `subagent` tool in `single` mode with `agent: "planner"` and
   `task: "$@"`.
2. **Build.** Group the plan items by independence. For each group that can run in
   parallel, call `subagent` in `parallel` mode with `tasks: [...]`, one entry per item
   with `agent: "builder"` and `task` quoting the plan item verbatim. Include an
   instruction to commit before finishing. For sequential dependencies, run groups one
   after another.
3. **Review.** Call `subagent` in `single` mode with `agent: "reviewer"` and `task:
   "Audit the implementation and return a verdict (Pass / Needs changes / Block) with
   findings."`
4. **Fix (if needed).** If the verdict is "Needs changes" or "Block", treat the findings
   like a plan. Group issues by independence and call `subagent` in `parallel` mode with
   `tasks: [...]`, one per issue with `agent: "builder"` and `task` quoting the issue
   verbatim. Include an instruction to commit before finishing.
5. **Repeat.** Call the reviewer again (fresh audit). Repeat steps 4–5 until the
   reviewer passes or the user stops.

Use only the `subagent` and `question` tools.
