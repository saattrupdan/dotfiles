---
description:
  Strict implementation flow with mandatory tests and multiple review cycles.
---

1. **Switch branch.** Ask the user for a branch name. Run
   `git checkout -b <branch-name>` via `bash`. Confirm success.
2. **Plan.** Call `subagent` with `agent: "planner"` and `task: "$@"`. Require the
   planner to include test tasks.
3. **Build.** Group plan items by independence. Call `subagent` in `parallel` mode
   with `tasks: [...]`, each with `agent: "builder"` and the plan item verbatim.
   Include "commit before finishing" in each task.
4. **Test.** Ask the user what test command to run (default: `make test` or
   `uv run pytest`). Run via `bash`. If tests fail, loop back to step 3.
5. **Review.** Call `subagent` with `agent: "reviewer"` and task to audit
   implementation and tests.
6. **Fix.** If verdict is "Needs changes" or "Block", group issues and call
   `subagent` in `parallel` with `agent: "builder"` per issue. Commit each fix.
7. **Re-test and re-review.** Run tests again, then call reviewer again. Repeat
   until both pass.
8. **Push and PR.**
   - `git push -u origin <branch-name>`
   - Ask for base branch (default: `main`)
   - `gh pr create --title "<title>" --body "<body>" --base <base>`
   - Return PR URL.

Use only `subagent`, `question`, and `bash` tools.
