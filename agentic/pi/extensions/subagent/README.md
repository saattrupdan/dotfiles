# subagent extension

Delegate one task to one specialised subagent per tool call with isolated context. Pi
provides the orchestration: issue multiple independent subagent tool calls in the same
turn for concurrent work, or make successive calls when later work depends on an earlier
result. There is no batch payload or automatic result placeholder.

Agents are discovered from `~/.pi/agent/agents/*.md` (user scope) and, when
`agentScope` is `project` or `both`, from `<repo>/.pi/agents/*.md`.

## Tool calls

Each call requires `agent` and `task`. The other fields are optional:

```json
{
  "agent": "builder",
  "task": "Implement the parser fix described in issue 123.",
  "cwd": "/path/to/repository",
  "model": "anthropic/claude-sonnet-4-5",
  "skills": ["commit", "python"],
  "agentScope": "both",
  "confirmProjectAgents": false
}
```

- `cwd` selects the child process's working directory.
- `model` selects the preferred model for this call.
- `skills` adds named skills to the agent's frontmatter allow-list.
- `agentScope` is `user` (the default), `project`, or `both`, and controls agent
  discovery. Project agents are read from the repository's `.pi/agents` directory.
- `confirmProjectAgents` controls whether Pi asks before running project-local agents;
  it defaults to `true`.

For independent tasks, make one tool call per agent/task and issue those calls
concurrently. For dependent tasks, make another call after the first completes and
include the relevant result in the next task yourself.

## Agent frontmatter

```yaml
---
name: builder
description: One-line description shown to the orchestrator.
tools: read, write, edit, bash           # optional, comma-separated allow-list
model:                                  # optional model fallback list
  - anthropic/claude-sonnet-4-5
  - claude-sonnet-4-5
worktree: true                          # optional; fresh git worktree
skills: [commit, python, fastapi]       # optional; see "Skill scoping" below
refuse:                                 # optional; see "Refusal patterns" below
  - pattern: "full file contents?"
    message: "Ask me for paths and line ranges instead of file contents."
---

Body becomes the agent's appended system prompt.
```

`model:` may also be a single string for backwards compatibility:

```yaml
model: anthropic/claude-sonnet-4-5
```

String values are normalised to a one-item list. YAML lists preserve order;
non-string or empty entries are warned to stderr and skipped.

## Model selection

By default, subagents inherit the parent session's current model. Agent
frontmatter can declare `model:` as either a string or ordered YAML list. Each
entry is passed unchanged to the child `pi --model` flag, so both
`provider/model` and unique bare `model` names are resolved by the Pi CLI.

A tool call may also request a model. The ordered fallback list is:

1. requested per-call model, if provided,
2. the agent frontmatter model list, if present,
3. the inherited current session model, if available.

Duplicates are removed while preserving the first occurrence.

If a child Pi launch fails because the child process fails to spawn, exits
non-zero, or emits an assistant `stopReason: "error"`, the subagent tool retries
with the next fallback model. Refusal pattern short-circuits, parent aborts, and
parameter validation errors are not retried. Failed worktree attempts are
discarded; only a successful attempt is merged back into the parent worktree. If
every model fails, the structured tool result is marked as an error and names
every attempted model.

## Skill scoping

The `skills:` frontmatter field is an **allow-list of skill names**. Names are
resolved against `~/.pi/agent/skills/<name>/SKILL.md`. When set, the child pi
process is launched with `--no-skills` plus a `--skill <dir>` flag per allowed
skill, so the child's `<available_skills>` block contains **only** those skills.

Semantics:

| Frontmatter       | Child's `<available_skills>`                              |
|-------------------|-----------------------------------------------------------|
| _(field omitted)_ | All skills discovered by the child.                       |
| `skills: []`      | Empty — no skills available to the child.                 |
| `skills: [a, b]`  | Exactly skills `a` and `b` if they exist on disk.         |

Skills referenced in frontmatter but missing on disk are warned to stderr and
skipped (the child still launches).

### Per-call additive skills

The `subagent` tool accepts an optional `skills: ["x", "y"]` array. When the
agent declares a frontmatter allow-list, the call-level names are union-merged
into it before launching the child. This also adds names to an explicit empty
list.

When the frontmatter field is omitted, skill discovery remains unrestricted;
call-level names do not narrow the child to only those skills. Passing extra
skills also never widens an explicit allow-list to "all skills".

## Refusal patterns

`refuse:` is a list of `{ pattern, message, flags? }` entries. Before the child
process is spawned, the incoming task text is tested against each pattern in
order; the first match short-circuits the call and returns `message` to the
caller as the agent's error (`stopReason: "refused"`).

```yaml
refuse:
  - pattern: "(full|entire|complete) file contents?"
    message: "Refer to files by path and range — don't ask me to paste contents."
  - pattern: "implement|write|edit|fix"
    message: "I only locate and summarise. Hand implementation tasks to builder."
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
worktree on a temporary branch. On successful child exit, the branch is merged
back into the parent worktree's HEAD and the temporary worktree is cleaned up.
Failed model retry attempts are discarded without merging or applying changes.
