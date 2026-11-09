---
name: grilling
description: Grill the user relentlessly about a plan, decision, or idea. Use when the user wants to stress-test their thinking, or uses any 'grill' trigger phrases.
---

Interview the user relentlessly until you reach a shared understanding. Map this as a
**design tree**: every decision branches into the decisions that hang off it.

The **frontier** is every decision whose prerequisites are already settled: the
questions you can ask _now_ without guessing at answers you haven't heard yet. Pick
one decision from the frontier at a time, prioritising the one that most affects the
user's goals or unblocks the most downstream decisions.

## Ask one question at a time

- Use the `question` tool for every question, not a question written in chat.
- Each call must ask about exactly one decision. Do not bundle multiple questions
  into the prompt, queue several calls, or call the tool in parallel.
- Wait for the user's answer before choosing and asking the next question.
- Make the prompt self-contained: explain the decision and its practical consequences.
- Include multiple choices with `options` whenever there are meaningful alternatives.
  Prefer 2–4 concise, distinct choices. Put your recommendation first and label it
  `(Recommended)`; briefly explain why in the prompt.
- Do not add an "Other" option yourself: the tool already lets the user give a custom
  answer. Omit `options` when the decision genuinely needs a free-text answer.
- Use `multiSelect: true` only when several choices can apply to this one decision.

For example, call `question` with:

```json
{
  "question": "Who should release one serve? Internal users keep feedback focused.",
  "options": [
    "Internal users only (Recommended)",
    "Invited external users",
    "Anyone who signs up"
  ]
}
```

Each answer reshapes the tree: settled decisions push the frontier outward and
unblock questions that depended on them. Recompute the frontier after every answer.
A question whose answer depends on an unsettled decision must wait.

Finding _facts_ is your job, never the user's. Look up facts from the environment
(filesystem, tools, etc.) yourself; use a sub-agent when substantial exploration
would help. A running exploration is an unsettled prerequisite: questions downstream
of it must wait, but you can ask one independent frontier question meanwhile. Ask
only decisions that genuinely depend on the user's intent, goals, or constraints;
resolve routine implementation choices yourself.

The session is done when the frontier is empty: every relevant branch of the design
tree is settled, with assumptions made explicit. Summarise the shared understanding
and use `question` to ask for confirmation before acting on it.
