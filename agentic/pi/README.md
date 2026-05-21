# Pi Extensions

This directory contains extensions that extend pi's behavior. Extensions are TypeScript modules that can register custom tools, commands, keyboard shortcuts, event handlers, and UI components.

## subagent

Delegate tasks to specialized subagents with isolated context windows.

**Features:**
- Spawns a separate `pi` process for each subagent invocation
- Supports single, parallel, and chain execution modes
- Git worktree support: agents can run in isolated worktrees with automatic merge-back
- Streaming output: see tool calls and progress as they happen

### Agent Configuration

Agents are loaded from `~/.pi/agent/agent-configs/*.md`. Each file has YAML frontmatter with configuration and a body with the system prompt.

### Frontmatter fields
- `name` (string) - Agent name
- `description` (string) - What the agent does
- `mode` ("primary" | "subagent") - Agent mode
- `model` (string) - Optional model override
- `worktree` (boolean) - Whether to spawn in a separate git worktree
- `worktreeBranch` (string) - Branch name for the worktree
- `worktreePath` (string) - Custom worktree path
- `permission` (object) - Tool permissions (read: allow/deny, edit: allow/deny, etc.)

### Example agent file

```markdown
---
name: build
description: Edit files in the codebase
mode: subagent
permission:
  read: allow
  edit: allow
  grep: allow
  bash: allow
  skill: allow
---

You are a senior software developer who writes precise code.
```

### Execution Modes

The subagent tool supports three execution modes:

### Git Worktree Support

Agents can be configured to run in isolated git worktrees. When `worktree: true` is set in an agent's frontmatter, the agent runs in a separate git worktree branch. Any changes made by the agent are automatically staged, committed, and merged back into the main branch after completion.

- `worktree: true` - Enable worktree mode
- `worktreeBranch` (optional) - Custom branch name for the worktree (default: auto-generated)
- `worktreePath` (optional) - Custom worktree path (default: auto-generated in /tmp)

This is useful for agents that modify code, as changes are cleanly isolated and merged without affecting the main branch until the agent completes.

- **Single** - Run one agent with one task:
  ```
  Use build to refactor the auth module
  ```

- **Parallel** - Run multiple agents concurrently:
  ```
  Run build agents in parallel to implement the plan
  ```

- **Chain** - Run agents sequentially, passing output between them:
  ```
  First have plan create a spec, then use build to implement it
  ```

See [subagent/README.md](extensions/subagent/README.md) for full documentation.

## Installing Extensions

Extensions are auto-discovered from this directory. To install a new extension:

1. Create a new directory here: `mkdir ~/.pi/agent/extensions/my-extension`
2. Add an `index.ts` file that exports the extension factory
3. Reload pi with `/reload` or restart

## Development

Extensions run with full system permissions. Only install extensions from trusted sources.

Extensions can be tested with:
```bash
pi -e ~/.pi/agent/extensions/my-extension/index.ts
```

## Sharing Extensions

To share extensions via npm or git as [pi packages](https://www.npmjs.com/search?q=keywords%3Api-package):

```bash
pi install npm:@foo/pi-tools
pi install git:github.com/user/repo
```
