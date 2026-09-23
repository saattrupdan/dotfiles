# Git worktree isolation

This extension relaunches every top-level Pi process started in a Git checkout inside its own unique detached linked worktree. No process receives special ownership of the normal checkout, and no branch is created automatically. Worktrees receive memorable adjective-animal names such as `flamboyant-hamster`, shown in the footer as `🌳 flamboyant-hamster`.

## Finalization policy

After every settled agent run:

- Dirty work triggers a hidden follow-up turn requiring the same agent to commit it.
- A named branch explicitly selected or created by the agent is left untouched.
- Commits on detached `HEAD` are published to the branch that was checked out when Pi started.
- Publication is serialized across Pi processes.
- If the launch branch advanced, the session is rebased automatically.
- If the launch branch was deleted after the session commit landed on another local
  or remote-tracking branch, the session is treated as finalized.
- A real rebase conflict triggers a hidden follow-up turn requiring the same agent to resolve it.

When a process launches from a dirty checkout, both the working-tree state and the real
Git index are captured automatically as separate durable checkpoint commits. This
preserves partially staged files as well as tracked and non-ignored untracked content.
Ignored regular files named `.env` or `.env.*` are copied into the same relative
location in the isolated worktree so local configuration remains available, but they are
never checkpointed or published. Symlinked env files are not copied. Copies are
refreshed
when a managed session starts and removed on normal session shutdown; edits to them are
therefore ephemeral. If the launch checkout remains unchanged, publication updates its
index under Git's lock protocol and atomically applies the agent's tree-to-tree patch.
Concurrent working-file or index changes block synchronization without being
overwritten. Other ignored files are never checkpointed or overwritten. A pending
checkout synchronization is written to the manifest before the branch ref moves, so a
later run can resume safely after a crash.

## Safety and recovery

Managed worktrees are locked and retained under:

```text
$PI_CODING_AGENT_DIR/worktrees/<repository-id>/<session-id>
```

Their manifests live in the repository's common Git directory under `pi-worktree-sessions/`. A crash, forced exit, failed repair, or blocked publication therefore leaves the commit and worktree recoverable.

A launch must start from a named branch so the extension has a publication target. Uncommitted changes do not require terminal interaction: they are snapshotted before relaunch.

All managed worktrees for a repository share the main checkout's Pi session directory. Consequently the default `/resume` view includes sessions created in every isolated worktree. Selecting a session in another managed worktree finalizes the current one and relaunches Pi in the selected worktree. `/new` reuses the current process's isolated worktree after the preceding run has finalized. Saved sessions created before this extension cannot be relocated safely because Pi records an immutable cwd in each session header. In-process `/fork` is blocked; start a top-level `pi --fork ...` invocation when the fork needs its own worktree.

Top-level subagents are excluded with `PI_SUBAGENT_CHILD=1`; the subagent extension already owns their worktree policy. Metadata commands such as `pi --help`, `pi --version`, package management, and export are also excluded. The dotfiles repository that deploys this extension is automatically exempt because its setup process must never run from a disposable worktree.

## Escape hatches

For recovery or administration only:

```bash
pi --no-worktree-isolation
PI_WORKTREE_ISOLATION_DISABLE=1 pi
```

`--no-extensions` necessarily bypasses this extension as well. Automatic repair turns are queued from Pi's `agent_end` lifecycle hook, so TUI, print, JSON, and RPC runs do not settle until repository finalization has completed or reached its bounded retry limit.
