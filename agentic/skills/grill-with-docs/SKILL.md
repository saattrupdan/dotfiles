---
name: grill-with-docs
description:
  Stress-test a plan or design through a relentless interview, challenge it against the
  project's domain model, and capture agreed terminology and architectural decisions.
  Use when the user asks to be grilled with docs or to sharpen a plan while documenting
  decisions.
disable-model-invocation: true
---

# Grill with Docs

Adapted for Pi from Matt Pocock's `grill-with-docs` and `grilling` skills in
[mattpocock/skills](https://github.com/mattpocock/skills), revision
`4ae2317ddb22b046e26455e4f9c9b3aaaf62212d`. See `LICENSE` for the MIT license.

Load `domain-modeling` with the `skill` tool before starting. Apply it throughout this
interview to challenge terminology, probe concrete scenarios, cross-reference claims
with code, and capture agreed glossary entries and architectural decisions.

## Interview the design tree

Interview the user until you reach a shared understanding. Map the plan as a **design
tree**: every decision branches into the decisions that depend on it.

Work the tree in **rounds**. The **frontier** is every decision whose prerequisites are
already settled: questions you can ask now without guessing at answers you haven't heard
yet. For each frontier question, provide your recommended answer and explain the
practical consequences. Phrase questions so accepting the recommendation is
straightforward.

Use Pi's `question` tool for each material user-level decision, one at a time, waiting
for the answer before continuing. Each question must be self-contained. Resolve routine
implementation choices yourself; focus the interview on the user's goals, visible
behavior, constraints, and meaningful trade-offs.

Each answer reshapes the tree. Settled decisions push the frontier outward and unblock
questions that depended on them. Recompute the frontier after each answer. A question
whose answer depends on an open decision belongs after that decision, not before it.

Finding **facts** is your job, never the user's. Inspect the codebase, existing
glossary, documented decisions, and environment rather than asking the user for anything
you can look up. Use an `explorer` for substantial independent research; use direct
tools for focused lookups. A running exploration is an unsettled prerequisite: only
questions downstream of it must wait.

## Capture decisions as they settle

Follow `domain-modeling` for `GLOSSARY.md`, `GLOSSARY-MAP.md`, and ADR formats.
Challenge conflicting terms immediately and test fuzzy relationships with concrete edge
cases. Record resolved terms and qualifying architectural decisions as they crystallise
rather than batching them at the end.

Only create Markdown files or edit Markdown under `docs/` when the user explicitly
requests those documentation changes. If that permission is absent, present the proposed
entries in the conversation instead. Loading this skill alone does not authorize
documentation edits.

The session is done when the frontier is empty: every material branch has been visited,
with no unresolved user-level assumptions. Summarize the agreed plan and remaining
risks. Do not begin implementation until the user confirms the shared understanding.
