---
description: Reviewer audits recent commits, then builder implements fixes if needed.
---

1. **Review.** Call the `subagent` tool with `agent: "reviewer"` and `task: "$@"`. If
   `$@` is empty (no argument provided), use this default task: "Audit the
   implementation of ABC in commits XYZ and return a verdict (Pass / Needs changes /
   Block) with findings." Here ABC is the name of the implemented task and XYZ is a list
   of commit hashes. Pass the argument to the reviewer to scope the audit.
2. **Build (if needed).** If the reviewer's verdict is "Needs changes" or "Block", treat
   the reviewer's findings like a plan. Group the issues by dependency. For each group
   of independent issues, issue multiple separate `subagent` tool calls together, one
   per issue, each with `agent: "builder"` and a `task` that quotes the reviewer's issue
   verbatim and instructs the builder to fix it. Include an instruction to commit before
   finishing. Wait for one group to finish before starting a group with dependent
   issues.
3. **Report.** Summarise the reviewer's verdict and findings. If changes were made,
   include the builder's commit subject. If the verdict was "Needs changes" or "Block"
   and no changes were made, surface that prominently and ask the user how to proceed.

**Key principle:** Don't plan or build before reviewing — the whole point of `/review`
is to **audit what exists** before deciding whether changes are needed. Only spawn
`builder`(s) if the reviewer finds issues ("Needs changes" or "Block" verdict).

Use only the `subagent` and `question` tools.
