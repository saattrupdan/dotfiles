# subagent extension

Delegate one task to one specialised subagent per tool call with isolated context. Pi
provides the orchestration: issue multiple independent subagent tool calls in the same
turn for concurrent work, or make successive calls when later work depends on an earlier
result. There is no batch payload or automatic result placeholder.

Agents are discovered from `~/.pi/agent/agents/*.md` (user scope) and, when
`agentScope` is `project` or `both`, from `<repo>/.pi/agents/*.md`. Only profiles
with `subagent: true` can be delegated to; project definitions cannot override
a private user profile such as `main`.

## Tool calls

Each call requires `agent`, a 1–5-word `taskName`, and `task`. The other fields
are optional:

```json
{
  "agent": "builder",
  "taskName": "Fix parser",
  "task": "Implement the parser fix described in issue 123.",
  "cwd": "/path/to/repository",
  "model": "anthropic/claude-sonnet-4-5",
  "skills": ["commit", "python"],
  "agentScope": "both",
  "confirmProjectAgents": false
}
```

- `taskName` is the concrete task label used in the child session, parent UI, and
  worktree merge commit.
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
subagent: true                          # only true profiles can be delegated to
tools:                                  # optional explicit allow-list
  - read
  - write
  - edit
  - bash
model:                                  # optional model fallback list
  - anthropic/claude-sonnet-4-5
  - claude-sonnet-4-5
worktree: true                          # optional; fresh git worktree
skills:                                 # optional; see "Skill scoping" below
  - commit
  - python
  - fastapi
extensions:                             # optional; explicit extension allow-list
  - read
  - edit
  - question
refuse:                                 # optional; see "Refusal patterns" below
  - pattern: "full file contents?"
    message: "Ask me for paths and line ranges instead of file contents."
---

The body becomes the child's system prompt. `subagent:` defaults to `true` for
existing project definitions; top-level-only profiles set it to `false`.
```

`model:` may also be a single string for backwards compatibility:

```yaml
model: anthropic/claude-sonnet-4-5
```

String values are normalised to a one-item list. YAML lists preserve order.
Invalid frontmatter fails visibly rather than silently widening access.

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
skipped (the child still launches). `extensions:` follows the same allow-list
pattern: omitted means ordinary discovery, `[]` loads none, and a list loads
only those extensions via `--no-extensions` and explicit `--extension` paths.
An explicit `tools: []` disables all tools; omitted `tools:` retains Pi's default.

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

Invalid patterns or missing `pattern`/`message` fields fail profile loading.

## Worktree mode

When `worktree: true` is set, the subagent is spawned in a dedicated git
worktree on a temporary branch. On successful child exit, the branch is merged
back into the parent worktree's HEAD with `Merge <agent>: <taskName>` as the
merge commit subject, and the temporary worktree is cleaned up. Failed model
retry attempts are discarded without merging or applying changes.

## Session naming

The parent names the child; the child does not name itself. Each spawn gets an
ordinal per agent name, counted for the lifetime of the parent process, and the
call's `taskName` becomes the concrete label passed to the child:

```
PI_SUBAGENT_SESSION_NAME=builder2: Fix parser
```

`extensions/conversation-name` applies that value as the child's session name and
returns before its model naming call, so a child never spawns a nested `pi -p`
just to title itself. Ordinary sessions never see this variable.

The same label is shown in the subagent tool's own rows, so parallel builders are
tellable apart in the parent's UI.
