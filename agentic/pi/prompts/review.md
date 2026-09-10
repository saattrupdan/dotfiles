---
description: Reviewer audits recent commits, then builder implements fixes if needed.
---

1. **Review.** Call the `subagent` tool with `agent: "reviewer"`, a 1–5-word
   `taskName` summarising the review, and `task: "$@"`. If `$@` is empty (no argument
   provided), use this default task: "Audit the
   implementation of ABC in commits XYZ and return a verdict (LGTM / LGTM with nits /
   Needs changes / Block) with findings." Here ABC is the implemented task and XYZ is a
   list of commit hashes. Pass the argument to the reviewer to scope the audit.
2. **Block.** If the reviewer returns "Block", surface the verdict and findings and ask
   the user how to proceed; do not send blocked findings to builders automatically.
3. **Build (if needed).** If the verdict is "Needs changes", treat the findings like a
   plan. Group the issues by dependency. For each group of independent issues, issue
   multiple separate `subagent` tool calls together, one per issue, each with
   `agent: "builder"`, a 1–5-word `taskName` summarising the fix, and a `task` that
   quotes the reviewer's issue verbatim and instructs the builder to fix it. Include an
   instruction to commit before finishing. Wait for one group to finish before starting
   a group with dependent issues.
4. **Repeat.** After fixes, call the reviewer again. For each new "Needs changes"
   verdict, repeat step 3. Continue automatically until the reviewer returns "LGTM" or
   "LGTM with nits". Both end the loop; report any nits without automatically fixing
   them. Ask the user only when a fix requires a material user-level decision or
   permission under the questions-and-autonomy policy.
5. **Report.** Summarise the final verdict and findings. If changes were made, include
   the builder's commit subject.

**Key principle:** Don't plan or build before reviewing — the whole point of `/review`
is to **audit what exists** before deciding whether changes are needed. Only spawn
`builder`(s) after a "Needs changes" verdict.

Use only the `subagent` and `question` tools.
