---
description:
  Maximum parallelism - all builders run concurrently, single review at the end.
---

1. **Switch branch.** Ask for branch name, run `git checkout -b <branch-name>`.

2. **Plan.** Call `subagent` with `agent: "planner"` and `task: "$@"`.

3. **Parallel build.**
   - Take ALL plan items and run in ONE `subagent` parallel call
   - `tasks: [{ agent: "builder", task: "<item1>" }, ...]`
   - Each builder commits independently
   - Wait for all to complete

4. **Review.** Call `subagent` with `agent: "reviewer"` to audit.

5. **Fix (if needed).**
   - If "Needs changes" or "Block": group issues by independence
   - ONE parallel `subagent` call with all fixes
   - Repeat review until pass

6. **Push and PR.**
   - `git push -u origin <branch-name>`
   - Ask base branch (default: `main`)
   - `gh pr create --title "<title>" --body "<body>" --base <base>`
   - Return PR URL

Use only `subagent`, `question`, and `bash` tools.
