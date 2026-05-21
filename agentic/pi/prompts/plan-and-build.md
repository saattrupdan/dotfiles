---
description: Planner produces a plan, then builders implement it in parallel. No reviewer pass.
---
Execute this composite flow for the request: "$@"

1. Call `subagent` in `single` mode with `agent: "planner"` and `task: "$@"`.
2. Read the plan. For each parallel group the planner identified, make ONE `subagent` call in `parallel` mode with `tasks: [...]` where every entry is `{ agent: "builder", task: "<quoted step>" }`. Always tell each builder to commit before finishing. Run sequential groups one after another.
3. Summarise what was built (commit subjects per builder).

Use only the `subagent` and `question` tools.
