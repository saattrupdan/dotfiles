---
description:
  Full implementation flow with branch switch, optional review, and PR creation.
---

1. **Load `gh` skill.** Call `skill` with `name: "gh"` to load the GitHub CLI skill.
2. **Switch branch.** Come up with a suitable branch name. Call `bash` to create and
   checkout that branch: `git checkout -b <branch-name>`. Confirm the branch switch
   succeeded before proceeding.
3. **Plan.** Call the `subagent` tool with `agent: "planner"`, a 1–5-word `taskName`
   summarising `$@`, and `task: "$@"`. If `$@` is empty (no argument provided), STOP and
   ask the user to call this prompt again with an argument.
4. **Build.** Group the plan items by dependency. For each group of independent items,
   issue multiple separate `subagent` tool calls together, one per item, each with
   `agent: "builder"`, a 1–5-word `taskName` summarising the item, and `task` quoting the
   plan item verbatim. Include an instruction to commit before finishing. Wait for one
   group to finish before starting a group with dependent items.
5. **Review only when warranted.** Skip review for simple or low-risk changes. Call one
   `reviewer` only when the implementation has meaningful risk or complexity, or when
   the user explicitly requested review. Multiple workstreams alone do not require one.
   Set `task` to: "Audit the implementation of ABC in commits XYZ and return a verdict
   (LGTM / LGTM with nits / Needs changes / Block) with findings." Here `ABC` is the
   implemented task and `XYZ` is a list of commit hashes.
6. **Fix serious issues (if needed).** If the verdict is "Needs changes", treat its
   substantive findings like a plan. Do not send nits to builders. Group serious issues
   by dependency and, for each group of independent issues, issue multiple separate
   `subagent` tool calls together, one per issue, each with `agent: "builder"`, a
   1–5-word `taskName` summarising the fix, and `task` quoting the issue verbatim.
   Include an instruction to commit before finishing. Wait for one group to finish
   before starting a group with dependent issues. Do not call another reviewer after
   the fixes; the user can request a separate review if wanted. If a fix requires a
   material user-level decision or permission, ask the user under the
   questions-and-autonomy policy.
7. **Block.** If the reviewer returns "Block", surface the verdict and findings and ask
   the user how to proceed; do not send blocked findings to builders automatically.
8. **Push and PR.** Once implementation and any warranted review or fixes are complete:
   - Push: `git push -u origin <branch-name>`
   - Generate PR title from commit subject (first commit or latest)
   - Generate PR body from commit messages, following the gh skill's PR description
     style: **What** (one paragraph on core change), **Key features** (bullet list),
     **Examples** (CLI examples if applicable), **Why it helps** (optional motivation).
   - Create PR: `gh pr create --base <base-branch> --title "<title>" --body "<body>"`
     (or use `--fill` to auto-fill from commit messages)
   - Return PR URL to the user.

Use only the `subagent`, `question`, and `bash` tools.
