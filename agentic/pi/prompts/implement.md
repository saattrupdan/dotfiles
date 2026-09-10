---
description: Full implementation flow with iterative review cycles.
---

1. **Plan.** Call the `subagent` tool with `agent: "planner"`, a 1–5-word `taskName`
   summarising `$@`, and `task: "$@"`. If `$@` is empty (no argument provided), STOP and
   ask the user to call this prompt again with an argument.
2. **Build.** Group the plan items by dependency. For each group of independent items,
   issue multiple separate `subagent` tool calls together, one per item, each with
   `agent: "builder"`, a 1–5-word `taskName` summarising the item, and `task` quoting the
   plan item verbatim. Include an instruction to commit before finishing. Wait for one
   group to finish before starting a group with dependent items.
3. **Review.** Call the `subagent` tool with `agent: "reviewer"` and a 1–5-word
   `taskName` summarising the review. Set `task` to:
   "Audit the implementation of ABC in commits XYZ and return a verdict (LGTM / LGTM
   with nits / Needs changes / Block) with findings." Here `ABC` is the implemented task
   and `XYZ` is a list of commit hashes.
4. **Fix (if needed).** If the verdict is "Needs changes", treat the findings like a
   plan. Group issues by dependency and, for each group of independent issues, issue
   multiple separate `subagent` tool calls together, one per issue, each with
   `agent: "builder"`, a 1–5-word `taskName` summarising the fix, and `task` quoting the
   issue verbatim. Include an instruction to commit before finishing. Wait for one group
   to finish before starting a group with dependent issues.
5. **Repeat.** After fixes, call the reviewer again for a fresh audit. For each new
   "Needs changes" verdict, repeat step 4. Continue automatically until the reviewer
   returns "LGTM" or "LGTM with nits". Both end the loop; report any nits without
   automatically fixing them. If a fix requires a material user-level decision or
   permission, ask the user under the questions-and-autonomy policy.
6. **Block.** If the reviewer returns "Block", surface the verdict and findings and ask
   the user how to proceed; do not send blocked findings to builders automatically.

Use only the `subagent` and `question` tools.
