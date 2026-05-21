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

## Worktree mode

When `worktree: true` is set, the subagent is spawned in a dedicated git
worktree on a temporary branch. On exit, the branch is merged back into the
parent worktree's HEAD and the temporary worktree is cleaned up.
