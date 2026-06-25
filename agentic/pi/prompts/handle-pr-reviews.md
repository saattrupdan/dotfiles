---
description: Handle PR review comments — Copilot vs human reviewers.
---

1. **Load `gh` skill.** Call `skill` with `name: "gh"` and read:
   - "Review cycle" section
   - "Handling reviews: Copilot vs humans" section

2. **Follow the workflow in the skill.** The skill covers:
   - Fetching reviews and identifying Copilot vs human reviewers
   - Copilot workflow: address comments, post summary tagged `@copilot`, resolve threads via GraphQL
   - Human workflow: reply to each comment thread, re-request review, no summary comment

3. **Iterate.** Re-check for new reviews until all substantive feedback is addressed.

Use only the `subagent`, `question`, `bash`, and `skill` tools.
