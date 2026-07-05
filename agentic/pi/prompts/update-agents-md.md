---
description:
  Audit and update AGENTS.md to ensure it captures all essential repo knowledge.
---

1. **Read AGENTS.md.** Call `read` on `@AGENTS.md` (or the repo's root AGENTS.md if
   elsewhere).

2. **Audit critically.** Ask yourself:
   - Is this document up to date with the current state of the repo?
   - Does it capture the essential knowledge an agent needs to work effectively here?
   - Would I trust another agent with AGENTS.md as the _only_ instruction to handle this
     repo?
   - What's missing? What's stale? What would confuse a fresh agent?

3. **Distill new knowledge.** If you've learned anything during this session that isn't
   captured in AGENTS.md — gotchas, conventions, build/test quirks, architectural
   decisions — distill it into the document. Focus on:
   - **Gotchas**: Non-obvious things that trip up agents (or humans)
   - **Conventions**: Style, structure, tooling choices
   - **Layout**: Directory purposes that aren't self-evident
   - **Running/Testing**: Exact commands, service dependencies, flaky tests

4. **Update.** Call `edit` (or `write` if restructuring heavily) to update AGENTS.md
   with your findings. Keep lines at or below 88 characters.

5. **Report.** Summarise what you changed and why. If the document was already
   comprehensive, say so — don't edit for the sake of editing.

Use `read`, `write`, `edit`, and `question` tools only.
