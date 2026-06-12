---
description:
  Interactive implementation flow - user confirms each step before proceeding.
---

1. **Switch branch.**
   - Ask: "What branch should I create?" (suggest: `feat/<short-description>`)
   - Run `git checkout -b <branch-name>` via `bash`
   - Confirm: "Switched to branch `<branch-name>`"
   - Ask: "Proceed with planning?"

2. **Plan.**
   - Call `subagent` with `agent: "planner"` and `task: "$@"`
   - Show the plan to the user
   - Ask: "Proceed with this plan, or should I adjust anything?"

3. **Build (iterative).**
   - For each plan item (or parallel group):
     - Show what will be built
     - Ask: "Build this now?"
     - If yes: Call `subagent` with `agent: "builder"` and the task
     - Show result
     - Ask: "Continue to next item?"

4. **Review.**
   - Ask: "Ready for review?"
   - Call `subagent` with `agent: "reviewer"` and audit task
   - Show verdict and findings
   - If "Needs changes" or "Block": Ask "Shall I fix these issues?"

5. **Fix (if approved).**
   - Group issues, call `subagent` in `parallel` with `agent: "builder"` per issue
   - Show fixes
   - Ask: "Run another review?"

6. **Push and PR.**
   - Ask: "Ready to push and create PR?"
   - `git push -u origin <branch-name>`
   - Ask: "What's the base branch?" (default: `main`)
   - Ask: "Use auto-generated PR title/body?" (show preview)
   - `gh pr create --title "<title>" --body "<body>" --base <base>`
   - Return: "PR created: <URL>"

Use only `subagent`, `question`, and `bash` tools.
