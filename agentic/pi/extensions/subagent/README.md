# subagent extension

Delegate tasks to specialised subagents with isolated context. Modes: **single**,
**parallel** (`tasks: [...]`), **chain** (`chain: [...]` with `{previous}`
placeholder).

Agents are discovered from `~/.pi/agent/agents/*.md` (user scope) and, when
`agentScope` is `project` or `both`, from `<repo>/.pi/agents/*.md`.

## Agent frontmatter

```yaml
---
name: builder
description: One-line description shown to the orchestrator.
tools: read, write, edit, bash           # optional, comma-separated allow-list
model: anthropic/claude-sonnet-4-5       # optional
worktree: true                            # optional; run in a fresh git worktree
skills: [commit, python, fastapi]         # optional; see "Skill scoping" below
refuse:                                   # optional; see "Refusal patterns" below
  - pattern: "full file contents?"
    message: "Ask me for paths and line ranges instead of file contents."
---

Body becomes the agent's appended system prompt.
```

## Skill scoping

The `skills:` frontmatter field is an **allow-list of skill names**. Names are
resolved against `~/.pi/agent/skills/<name>/SKILL.md`. When set, the child pi
process is launched with `--no-skills` plus a `--skill <dir>` flag per allowed
skill, so the child's `<available_skills>` block contains **only** those skills.

Semantics:

| Frontmatter                | Child's `<available_skills>`                                  |
|----------------------------|----------------------------------------------------------------|
| _(field omitted)_          | All skills discovered by the child (backwards compatible).     |
| `skills: []`               | Empty — no skills available to the child.                      |
| `skills: [a, b]`           | Exactly skills `a` and `b` (if they exist on disk).            |

Skills referenced in frontmatter but missing on disk are warned to stderr and
skipped (the child still launches).

### Per-call additive skills

The `subagent` tool accepts an optional `skills: ["x", "y"]` array at three
levels, all of which are **union-merged** with the agent's frontmatter
allow-list before launching the child:

- top-level `params.skills` (single mode),
- `tasks[i].skills` (parallel mode),
- `chain[i].skills` (chain mode).

Passing extra skills via the task does **not** widen the allow-list to "all
skills"; it only adds the named ones to the (possibly empty) frontmatter list.

## Refusal patterns

`refuse:` is a list of `{ pattern, message, flags? }` entries. Before the child
process is spawned, the incoming task text is tested against each pattern in
order; the first match short-circuits the call and returns `message` to the
caller as the agent's error (`stopReason: "refused"`).

```yaml
refuse:
  - pattern: "(full|entire|complete) file contents?"
    message: "Refer to files by path and (optionally) symbol or line range — don't ask me to paste contents."
  - pattern: "implement|write|edit|fix"
    message: "I only locate and summarise. Hand implementation tasks to `builder`."
    flags: "i"                # optional; default is "i" (case-insensitive)
```

This is a cheap, deterministic guardrail — it runs in the orchestrator's
process, costs no model tokens, and triggers whether or not the child would
have respected an instruction in its system prompt. Use it for hard contracts
(e.g. "don't return file contents", "don't implement"); use prompt text for
softer guidance.

Invalid patterns are warned to stderr at load time and skipped. A missing
`pattern` or `message` field also causes the entry to be skipped.

## Worktree mode

When `worktree: true` is set, the subagent is spawned in a dedicated git
worktree on a temporary branch. On exit, the branch is merged back into the
parent worktree's HEAD and the temporary worktree is cleaned up.
