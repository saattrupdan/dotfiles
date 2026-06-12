---
description:
  Quick implementation flow - single builder pass, no review cycle, push and open PR.
---

1. **Switch branch.** Ask the user for a branch name (or suggest one based on the task).
   Run `git checkout -b <branch-name>` via `bash`. Confirm checkout succeeded.
2. **Build.** Call `subagent` in `single` mode with `agent: "builder"` and
   `task: "$@"`. Include instruction to commit before finishing.
3. **Push and PR.**
   - Push: `git push -u origin <branch-name>`
   - Ask for base branch (default: `main`)
   - Create PR: `gh pr create --title "<title>" --body "<body>" --base <base>`
   - Return PR URL to user.

Use only `subagent`, `question`, and `bash` tools.
