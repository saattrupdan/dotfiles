# Git worktree isolation

This extension relaunches each top-level Pi process started in a clean Git checkout inside a unique detached linked worktree. It creates no branch automatically. Worktrees receive memorable adjective-animal names such as `flamboyant-hamster`, shown in the footer as `🌳 flamboyant-hamster`.

## Finalization policy

After every settled agent run:

- Dirty work triggers a hidden follow-up turn requiring the same agent to commit it.
- A named branch explicitly selected or created by the agent is left untouched.
- Commits on detached `HEAD` are published to the branch that was checked out when Pi started.
- Publication is serialized across Pi processes.
- If the launch branch advanced, the session is rebased automatically.
- A real rebase conflict triggers a hidden follow-up turn requiring the same agent to resolve it.

The checkout holding the launch branch must remain safe to update. Publication blocks before overwriting tracked, untracked, or ignored files. A pending checkout synchronization is written to the manifest before the branch ref moves, so a later run can resume safely after a crash.

## Safety and recovery

Managed worktrees are locked and retained under:

```text
$PI_CODING_AGENT_DIR/worktrees/<repository-id>/<session-id>
```

Their manifests live in the repository's common Git directory under `pi-worktree-sessions/`. A crash, forced exit, failed repair, or blocked publication therefore leaves the commit and worktree recoverable.

The launch checkout must initially be clean and on a named branch. The extension refuses to start otherwise because a detached worktree cannot safely inherit uncommitted changes or infer a publication target.

Saved sessions created before this extension cannot be relocated safely because Pi records an immutable cwd in each session header. Managed sessions can be resumed by selecting them from Pi's all-sessions view or by explicit session path/ID. `/new` reuses the current process's isolated worktree after the preceding run has finalized. In-process `/fork` is blocked; start a top-level `pi --fork ...` invocation when the fork needs its own worktree.

Top-level subagents are excluded with `PI_SUBAGENT_CHILD=1`; the subagent extension already owns their worktree policy. Metadata commands such as `pi --help`, `pi --version`, package management, and export are also excluded. The dotfiles repository that deploys this extension is automatically exempt because its setup process must never run from a disposable worktree.

## Escape hatches

For recovery or administration only:

```bash
pi --no-worktree-isolation
PI_WORKTREE_ISOLATION_DISABLE=1 pi
```

`--no-extensions` necessarily bypasses this extension as well. Automatic repair turns are queued from Pi's `agent_end` lifecycle hook, so TUI, print, JSON, and RPC runs do not settle until repository finalization has completed or reached its bounded retry limit.
