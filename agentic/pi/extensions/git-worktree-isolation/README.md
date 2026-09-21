# Git worktree isolation

This extension gives the first active top-level Pi process for a repository an atomic lease on the normal checkout. Concurrent Pi processes are relaunched inside unique detached linked worktrees; no branch is created automatically. Isolated worktrees receive memorable adjective-animal names such as `flamboyant-hamster`, shown in the footer as `🌳 flamboyant-hamster`. A crashed primary process leaves a stale lease that the next launch reclaims automatically.

## Finalization policy

After every settled agent run:

- The primary process works normally in the main checkout, but dirty work still triggers a hidden follow-up turn requiring the same agent to commit it.
- Concurrent processes run in isolated worktrees, where dirty work triggers the same automatic commit repair.
- A named branch explicitly selected or created by the agent is left untouched.
- Commits on detached `HEAD` are published to the branch that was checked out when Pi started.
- Publication is serialized across Pi processes.
- If the launch branch advanced, the session is rebased automatically.
- A real rebase conflict triggers a hidden follow-up turn requiring the same agent to resolve it.

When a concurrent process must isolate from a dirty primary checkout, both the working-tree state and the real Git index are captured automatically as separate durable checkpoint commits. This preserves partially staged files as well as tracked and non-ignored untracked content. If the primary checkout remains unchanged, publication updates its index under Git's lock protocol and atomically applies the agent's tree-to-tree patch. Concurrent working-file or index changes block synchronization without being overwritten. Ignored files are never checkpointed or overwritten. A pending checkout synchronization is written to the manifest before the branch ref moves, so a later run can resume safely after a crash.

## Safety and recovery

Managed worktrees are locked and retained under:

```text
$PI_CODING_AGENT_DIR/worktrees/<repository-id>/<session-id>
```

Their manifests live in the repository's common Git directory under `pi-worktree-sessions/`. A crash, forced exit, failed repair, or blocked publication therefore leaves the commit and worktree recoverable.

An isolated concurrent launch must start from a named branch so the extension has a publication target. Uncommitted changes do not require terminal interaction: they are snapshotted before relaunch. A lone primary process does not move out of the normal checkout.

All managed worktrees for a repository share the main checkout's Pi session directory. Consequently the default `/resume` view includes sessions created in every isolated worktree. Selecting a session in another managed worktree finalizes the current one and relaunches Pi in the selected worktree. `/new` reuses the current process's isolated worktree after the preceding run has finalized. Saved sessions created before this extension cannot be relocated safely because Pi records an immutable cwd in each session header. In-process `/fork` is blocked; start a top-level `pi --fork ...` invocation when the fork needs its own worktree.

Top-level subagents are excluded with `PI_SUBAGENT_CHILD=1`; the subagent extension already owns their worktree policy. Metadata commands such as `pi --help`, `pi --version`, package management, and export are also excluded. The dotfiles repository that deploys this extension is automatically exempt because its setup process must never run from a disposable worktree.

## Escape hatches

For recovery or administration only:

```bash
pi --no-worktree-isolation
PI_WORKTREE_ISOLATION_DISABLE=1 pi
```

`--no-extensions` necessarily bypasses this extension as well. Automatic repair turns are queued from Pi's `agent_end` lifecycle hook, so TUI, print, JSON, and RPC runs do not settle until repository finalization has completed or reached its bounded retry limit.
