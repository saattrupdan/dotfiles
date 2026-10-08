# Git worktree isolation

This extension relaunches every top-level Pi process started in a Git checkout inside
its own unique detached linked worktree. No process receives special ownership of the
normal checkout, and no branch is created automatically. Worktrees receive memorable
adjective-animal names such as `flamboyant-hamster`, shown in the footer as
`🌳 flamboyant-hamster`.

## Finalization policy

After every settled agent run:

- Dirty work triggers a hidden follow-up turn requiring the same agent to commit it.
- A named branch explicitly selected or created by the agent becomes the session's
  remembered publication branch. A launch from detached HEAD creates a dedicated
  `pi/<worktree-name>` branch instead of guessing which existing branch to update;
  that branch remains after the worktree is removed.
- Commits on detached `HEAD` are published to the remembered branch.
- Publication is serialized across Pi processes.
- If the launch branch advanced, the session is rebased automatically.
- If the launch branch was deleted after the session commit landed on another local
  or remote-tracking branch, the session is treated as finalized.
- A real rebase conflict triggers a hidden follow-up turn requiring the same agent to
  resolve it.

When a process launches from a dirty checkout, both the working-tree state and the real
Git index are captured automatically as separate durable checkpoint commits. This
preserves partially staged files as well as tracked and non-ignored untracked content.
Ignored files, symlinks, and fully ignored directories (including nested paths) are
linked back to the launch checkout, never checkpointed or published, except ignored
`.coverage` files: these are generated locally in the worktree and discarded on
release. Edits through other links affect the original checkout immediately,
including changes made inside linked directories; concurrent sessions share that
state. Non-ignored untracked files remain real files in the launch snapshot so
they can be committed. Git's worktree
configuration is enabled for the repository, and each managed worktree gets a private
exclude file so directory-only ignore rules also exclude their symlinks. The existing
`core.excludesFile` patterns (or Git's default global ignore file) are carried into
that file.  Links are refreshed on managed session start and removed on clean
  release. Ignored files created inside the worktree, including replaced links,
  are moved into the main checkout first. When a destination exists, the moved
  name gets `-<worktree-name>` (and a numeric suffix if necessary), never
  overwriting existing content. A path-specific rule is added to the repository's
  local Git exclude file if the main checkout would otherwise see the moved
  output as untracked. Symlinked ancestors and Git operations that make a move
  unsafe still prevent release. Disposable `.coverage` files are removed.
If the launch checkout remains unchanged, publication updates its index under Git's
lock protocol and atomically applies the agent's tree-to-tree patch. Concurrent
working-file or index changes block synchronization without being overwritten. A
pending checkout synchronization is written to the manifest before the branch ref
moves, so a later run can resume safely after a crash.

## Release and resume

Active managed worktrees are locked under:

```text
$PI_CODING_AGENT_DIR/worktrees/<repository-id>/<session-id>
```

On a clean, finalized shutdown the extension protects the session commit with a
`refs/pi-worktree-sessions/<session-id>` ref, writes a resume record beside the
session JSONL file, rewrites the transcript cwd to an existing lightweight
placeholder under `$PI_CODING_AGENT_DIR/released-sessions/`, and removes the
worktree, active manifest, copied env files, and launch snapshot refs.

Resuming that transcript creates a new detached worktree at the remembered
branch's current tip, rewrites the transcript cwd to the new location, and
removes the temporary resume record and protected ref. The remembered commit
must still be contained in the branch; a rewritten branch is not followed
silently. If the branch was deleted, Pi recreates the worktree at the protected
commit but finalization remains blocked until the work is placed on a named
branch.

`/new` checkpoints the outgoing transcript independently but reuses the active
worktree for the new session. This lets every transcript resume later without
keeping the shared checkout alive. Selecting a released session with `/resume`
recreates its worktree before relaunching Pi. In-process `/fork` remains blocked;
start a top-level `pi --fork ...` invocation when the fork needs its own
worktree.

## Safety and recovery

Active manifests live in the repository's common Git directory under
`pi-worktree-sessions/`. Dirty work, a Git operation in progress, pending checkout synchronization,
failed repair, or blocked publication prevents release and leaves the locked
worktree and manifest recoverable. Links created by the extension (and copied
`.env` files in older sessions) are treated as known ephemeral state. Ignored
session output is relocated into the main checkout before release. After an
abrupt child exit, the surviving Pi launcher reclaims a safely finalized
worktree; if the whole process is killed, the next Pi launch in that repository
reclaims dormant worktrees. A live owner or active transcript is never reaped.
Worktrees with uncommitted work remain locked so it is not lost; resume and
commit that work to enable removal.

A launch from a named branch publishes back to that branch. A detached launch
gets a dedicated branch; uncommitted launch-checkout changes do not require
terminal interaction and are snapshotted before relaunch.

All managed worktrees for a repository share the main checkout's Pi session
directory, so the default `/resume` view includes active and released sessions
from every isolated worktree. Transcript leases prevent concurrent writers,
and resume-record claims serialize worktree recreation. Existing managed
manifests remain compatible; every transcript still pointing at such a
worktree is checkpointed before its next clean shutdown releases it. Sessions
created before this extension have no recovery metadata and cannot be
relocated safely.

Top-level subagents are excluded with `PI_SUBAGENT_CHILD=1`; the subagent extension
already owns their worktree policy. Metadata commands such as `pi --help`,
`pi --version`, package management, and export are also excluded. The dotfiles
repository that deploys this extension is automatically exempt because its setup
process must never run from a disposable worktree.

## Escape hatches

For recovery or administration only:

```bash
pi --no-worktree-isolation
PI_WORKTREE_ISOLATION_DISABLE=1 pi
```

`--no-extensions` necessarily bypasses this extension as well. Automatic repair turns
are queued from Pi's `agent_end` lifecycle hook, so TUI, print, JSON, and RPC runs do
not settle until repository finalization has completed or reached its bounded retry
limit.
