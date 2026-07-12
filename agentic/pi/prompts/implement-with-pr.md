---
description:
  Full implementation flow with branch switch, iterative review cycles, and PR creation.
---

1. **Load `gh` skill.** Call `skill` with `name: "gh"` to load the GitHub CLI skill.
2. **Switch branch.** Come up with a suitable branch name. Call `bash` to create and
   checkout that branch: `git checkout -b <branch-name>`. Confirm the branch switch
   succeeded before proceeding.
3. **Plan.** Call the `subagent` tool in `single` mode with `agent: "planner"` and
   `task: "$@"`. If `$@` is empty (no argument provided), STOP and ask the user to
   call this prompt again with an argument.
4. **Build.** Group the plan items by independence. For each group that can run in
   parallel, call `subagent` in `parallel` mode with `tasks: [...]`, one entry per item
   with `agent: "builder"` and `task` quoting the plan item verbatim. Include an
   instruction to commit before finishing. For sequential dependencies, run groups one
   after another.
5. **Review.** Call `subagent` in `single` mode with `agent: "reviewer"` and
   `task: "Audit the implementation of ABC in commits XYZ and return a verdict (Pass /
   Needs changes / Block) with findings."`. Here `ABC` is the name of the implemented
   task and `XYZ` is a list of commit hashes.
6. **Fix (if needed).** If the verdict is "Needs changes" or "Block", treat the findings
   like a plan. Group issues by independence and call `subagent` in `parallel` mode with
   `tasks: [...]`, one per issue with `agent: "builder"` and `task` quoting the issue
   verbatim. Include an instruction to commit before finishing.
7. **Repeat.** Call the reviewer again (fresh audit). Repeat steps 5–6 until the
   reviewer passes or the user stops.
8. **Push and PR.** Once the reviewer passes:
   - Push: `git push -u origin <branch-name>`
   - Generate PR title from commit subject (first commit or latest)
   - Generate PR body from commit messages, following the gh skill's PR description
     style: **What** (one paragraph on core change), **Key features** (bullet list),
     **Examples** (CLI examples if applicable), **Why it helps** (optional motivation).
   - Create PR: `gh pr create --base <base-branch> --title "<title>" --body "<body>"`
     (or use `--fill` to auto-fill from commit messages)
   - Return PR URL to the user.
9. **Save to memory.** Call `memory_save` for anything worth remembering: tool errors,
   user preferences, project gotchas, repeated requests, or feedback.

Use only the `subagent`, `question`, `bash`, and `memory_save` tools.
