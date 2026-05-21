# Pi Extensions — Orchestrator + Subagents

This directory configures pi as a **pure orchestrator** that delegates all work to
specialised **subagents**, each running in its own `pi` subprocess with an isolated
context window.

## Components

### `subagent/`

Customised fork of pi's bundled `subagent` example. Adds one new frontmatter field:

```yaml
worktree: true
```

When `true`, the subagent is spawned in a **fresh git worktree on a temporary
branch**. On exit (success, failure, or abort) the branch is merged back into the
parent worktree's `HEAD`, then the worktree and branch are removed. Merges into the
same parent repo are serialised in-process so parallel worktree subagents don't race
on the git index.

Source files:

- `index.ts` — registers the `subagent` tool (single / parallel / chain modes).
- `agents.ts` — discovers agent definitions, parses the new `worktree` flag.
- `worktree.ts` — git worktree create / merge / cleanup helpers.

Agents are loaded from `~/.pi/agent/agents/*.md`.

### `web-search/`

Registers a `web_search` tool that queries DuckDuckGo's HTML endpoint and
returns the top results (title, URL, snippet) as Markdown. Stateless, no API
key required.

Access is gated by pi's per-agent `--tools` allowlist: only the
`web-explorer` agent lists `web_search` in its frontmatter, so no other
agent (and not the orchestrator) can call it. The orchestrator is also
blocked by `orchestrator-lockdown`.

### `orchestrator-lockdown/`

Blocks every tool call from the top-level (orchestrator) pi instance except
`subagent` and `question`. The orchestrator therefore has **no read/write/edit/bash
capability of its own** — it must delegate.

Subagent child processes are exempted via the `PI_SUBAGENT_CHILD=1` env var, which
the `subagent` extension sets when spawning them.

## Agents (in `~/.pi/agent/agents/`)

| File              | `worktree` | Tools                  | Role                                      |
|-------------------|------------|------------------------|-------------------------------------------|
| `planner.md`      | no         | read, bash, subagent   | Plans changes; may call code/web-explorer |
| `builder.md`      | **yes**    | read, write, edit, bash| Implements one scoped change              |
| `code-explorer.md`| no         | read, bash             | Reads + summarises the codebase           |
| `web-explorer.md` | no         | read, bash, web_search | Fetches + summarises web content          |
| `reviewer.md`     | no         | read, bash             | Audits commits, produces a verdict        |

The planner is the only non-orchestrator agent permitted to call `subagent` (so it
can fan out fact-finding to code-explorer / web-explorer while planning).

## Composite workflows (in `~/.pi/agent/prompts/`)

| Slash command           | Flow                                              |
|-------------------------|---------------------------------------------------|
| `/plan-build-review`    | planner → parallel builders → reviewer            |
| `/plan-and-build`       | planner → parallel builders                       |

The orchestrator system prompt (`~/.pi/agent/SYSTEM.md`) describes the available
agents, the composite flows, and how to pick one.

## Usage

```bash
pi
> Rename every Chunk to NewChunk
```

The orchestrator will:

1. Spawn `code-explorer` (single) to locate `Chunk` usages.
2. Spawn several `builder` subagents in **parallel** (one per package/directory),
   each in its own worktree, each committing before exit.
3. Spawn `reviewer` to audit the merged result.

You can also trigger the canonical flow directly:

```
/plan-build-review add Redis caching to the session store
```
