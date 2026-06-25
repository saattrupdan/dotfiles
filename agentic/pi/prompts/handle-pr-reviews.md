---
description: Handle PR review comments — Copilot vs human reviewers.
---

1. **Load `gh` skill.** Call `skill` with `name: "gh"`.

2. **Follow the "Handling reviews: Copilot vs humans" section in the skill.** It covers:
   - Identifying Copilot vs human reviewers
   - Copilot workflow: address comments, post summary tagged `@copilot`, resolve threads
   - Human workflow: reply to threads, re-request review, no summary

3. **Iterate** until all substantive feedback is addressed.

Use only the `subagent`, `question`, `bash`, and `skill` tools.
