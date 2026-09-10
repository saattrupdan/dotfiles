---
description: Reviewer audits commits; builders fix only substantive defects.
---

1. **Review.** Call the `subagent` tool with `agent: "reviewer"`, a 1–5-word
   `taskName` summarising the review, and `task: "$@"`. If `$@` is empty (no argument
   provided), use this default task: "Audit the
   implementation of ABC in commits XYZ and return a verdict (LGTM / LGTM with nits /
   Needs changes / Block) with findings." Here ABC is the implemented task and XYZ is a
   list of commit hashes. Pass the argument to the reviewer to scope the audit.
2. **Block.** If the reviewer returns "Block", surface the verdict and findings and ask
   the user how to proceed; do not send blocked findings to builders automatically.
3. **Build (if needed).** If the verdict is "Needs changes", treat its substantive
   findings like a plan. Do not send nits to builders. Group serious issues by
   dependency. For each group of independent issues, issue multiple separate `subagent`
   tool calls together, one per issue, each with `agent: "builder"`, a 1–5-word
   `taskName` summarising the fix, and a `task` that quotes the reviewer's issue
   verbatim and instructs the builder to fix it. Include an instruction to commit before
   finishing. Wait for one group to finish before starting a group with dependent
   issues.
4. **Verify serious fixes.** After fixing substantive findings, call the reviewer once
   to verify them. Start another fix/review cycle only if this review reports another
   "Needs changes" verdict backed by substantive defects. "LGTM" and "LGTM with nits"
   both end the loop; report nits without fixing or re-reviewing them. Ask the user only
   when a fix requires a material user-level decision or permission under the
   questions-and-autonomy policy.
5. **Report.** Summarise the final verdict and findings. If changes were made, include
   the builder's commit subject.

**Key principle:** Don't plan or build before reviewing — the whole point of `/review`
is to **audit what exists** before deciding whether changes are needed. Only spawn
`builder`(s) after a "Needs changes" verdict.

Use only the `subagent` and `question` tools.
