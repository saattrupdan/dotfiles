---
description: Full implementation flow with iterative review cycles.
---

1. **Plan.** Call the `subagent` tool with `agent: "planner"` and `task: "$@"`. If `$@`
   is empty (no argument provided), STOP and ask the user to call this prompt again with
   an argument.
2. **Build.** Group the plan items by dependency. For each group of independent items,
   issue multiple separate `subagent` tool calls together, one per item, each with
   `agent: "builder"` and `task` quoting the plan item verbatim. Include an instruction
   to commit before finishing. Wait for one group to finish before starting a group with
   dependent items.
3. **Review.** Call the `subagent` tool with `agent: "reviewer"` and
   `task: "Audit the implementation of ABC in commits XYZ and return a verdict (Pass / Needs changes / Block) with findings."`.
   Here `ABC` is the name of the implemented task and `XYZ` is a list of commit hashes.
4. **Fix (if needed).** If the verdict is "Needs changes" or "Block", treat the findings
   like a plan. Group issues by dependency and, for each group of independent issues,
   issue multiple separate `subagent` tool calls together, one per issue, each with
   `agent: "builder"` and `task` quoting the issue verbatim. Include an instruction to
   commit before finishing. Wait for one group to finish before starting a group with
   dependent issues.
5. **Repeat.** Call the reviewer again (fresh audit). Repeat steps 4–5 until the
   reviewer passes or the user stops.

Use only the `subagent` and `question` tools.
