---
description:
  Minimal implementation - skip planning, build directly from task, push and PR.
---

1. **Switch branch.**
   - Generate branch name: `feat/$(date +%Y%m%d)-$(echo "$@" | slugify)`
   - `git checkout -b <branch-name>`

2. **Build.**
   - `subagent` with `agent: "builder"` and `task: "$@"`
   - Builder commits before finishing

3. **Push and PR.**
   - `git push -u origin <branch-name>`
   - Base branch: `main` (no question)
   - Auto-generate title from commit subject
   - Auto-generate body from commit message
   - `gh pr create --title "<title>" --body "<body>" --base main`
   - Output: PR URL

Use only `subagent`, `question`, and `bash` tools.
