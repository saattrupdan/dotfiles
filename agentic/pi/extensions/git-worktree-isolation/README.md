# Git worktree isolation

Ordinary top-level Pi sessions stay in their original checkout. Running scripts or
experiments does not create a worktree, even when those scripts write ignored or
untracked files. Subagents retain their own separate worktree policy.

## Create a feature branch

The `isolated_new_branch` tool takes a `name`, such as `feat/search`. It requires a
saved Pi session in a clean Git checkout and creates that branch in a new managed
worktree at the current `HEAD`. Existing local branches, invalid names, and tracked
or non-ignored untracked changes are rejected. Commit or remove such changes first.
The tool stops the current agent run and relaunches the same saved session in the
new worktree with a continuation prompt. The original checkout stays on its branch.
Pi's own dotfiles repository is exempt because its deployed configuration must not
point into a disposable worktree. `PI_SUBAGENT_CHILD=1` is also exempt.

The worktree uses the same session directory as the original checkout. Ignored
configuration files and fully ignored directories from the original checkout are
symlinked into the new worktree; generated dependency and cache directories are not
linked. Edits through symlinks affect the original checkout immediately. Git's
worktree configuration and a private exclude file keep linked ignored paths
ignored, including patterns from `core.excludesFile` or the default global ignore
file. The footer shows a memorable adjective-animal worktree ID.

## Finalization and release

Managed sessions require tracked and non-ignored untracked changes to be committed
before the run ends. An automatic follow-up turn asks the agent to finish that work.
The new branch remains after the worktree is released; it is never merged into the
original branch automatically. A branch explicitly switched to by the agent is
also retained. Older detached managed sessions still publish their commits to their
remembered branch, with the existing locking, rebase, and conflict safeguards.

Ignored outputs created inside a managed worktree are **not moved** to the original
checkout. If such outputs remain (or a linked ignored path was replaced), cleanup
refuses to remove the worktree and leaves the files recoverable there. Remove or
save them explicitly before releasing it. Ignored `.coverage` files generated in
the worktree are the one disposable exception. Known linked paths are removed
without deleting their targets in the original checkout.

On clean shutdown, the extension saves a resume record beside the session JSONL,
protects its commit with `refs/pi-worktree-sessions/<id>`, rewrites the transcript
cwd to a placeholder, and removes the worktree and manifest. Resuming the transcript
recreates a worktree from the remembered branch; an absent or rewritten branch is
never silently followed. `/new` checkpoints the outgoing transcript and reuses the
active worktree. In-process `/fork` in a managed session is blocked; fork from a new
Pi invocation instead. Ordinary sessions can use Pi's normal `/new`, `/resume`, and
`/fork` behavior.

Active manifests live under `pi-worktree-sessions/` in the common Git directory;
worktrees live under `$PI_CODING_AGENT_DIR/worktrees/<repository-id>/<session-id>`.
Crash recovery reclaims only clean, inactive worktrees. Dirty work, ignored outputs,
ongoing Git operations, or active transcripts leave the worktree in place. Set
`PI_WORKTREE_DEBUG=1` for recovery diagnostics. Existing managed session manifests
and resume records remain supported.

For recovery or administration, `pi --no-worktree-isolation` or
`PI_WORKTREE_ISOLATION_DISABLE=1 pi` bypasses this extension. `--no-extensions`
bypasses it as well.
