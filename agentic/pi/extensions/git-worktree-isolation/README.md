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

## Finishing and cleanup

Managed sessions require tracked and non-ignored untracked changes to be committed
before the run ends. An automatic follow-up turn asks the agent to finish that work.
Branches created with `isolated_new_branch` and their worktrees remain in place on
quit, session switch, or crash recovery. They are never merged automatically.

`clean-up-isolated-branch` is a Pi tool and is also available as the interactive
`/clean-up-isolated-branch` command. Both use the same checks. They appear in
ordinary sessions too, but can run **only from the original managed feature
branch**. In other
sessions it explains why cleanup is unavailable. Restart Pi to load a newly added
extension tool. Call it when the branch's work has landed on `main`. The tool fetches `origin/main` if present and fast-forwards a
clean local `main` worktree when necessary. It verifies that the branch commit is
an ancestor of `main`, or that a virtual merge would add no changes to `main`
(supporting squash and cherry-pick merges). If inclusion cannot be proved, cleanup
stops without deleting anything. If there is a PR, the agent must ask the user
before merging it; without a PR, it must ask before merging the branch directly.
After an approved merge, call the cleanup tool again. It does not perform merges.

After verification, the tool moves saved sessions to the main checkout, removes
the worktree, deletes only the originally created local branch, and relaunches Pi
in `main`. Dirty feature work, unknown ignored outputs, active sessions, a missing
main worktree, or main that cannot safely fast-forward block cleanup. Older detached
managed sessions retain their existing publication and release behavior; branches
explicitly switched to by those agents are not deleted.

Ignored outputs created inside a managed worktree are **not moved** to the original
checkout. If such outputs remain (or a linked ignored path was replaced), cleanup
refuses to remove the worktree and leaves the files recoverable there. Remove or
save them explicitly before releasing it. Ignored `.coverage` files generated in
the worktree are the one disposable exception. Known linked paths are removed
without deleting their targets in the original checkout.

For older managed sessions, clean shutdown saves a resume record beside the
session JSONL, protects its commit with `refs/pi-worktree-sessions/<id>`, rewrites
the transcript cwd to a placeholder, and removes the worktree and manifest.
Resuming the transcript recreates a worktree from the remembered branch; an absent or rewritten branch is
never silently followed. `/new` checkpoints the outgoing transcript and reuses the
active worktree. In-process `/fork` in a managed session is blocked; fork from a new
Pi invocation instead. Ordinary sessions can use Pi's normal `/new`, `/resume`, and
`/fork` behavior.

Active manifests live under `pi-worktree-sessions/` in the common Git directory;
worktrees live under `$PI_CODING_AGENT_DIR/worktrees/<repository-id>/<session-id>`.
Crash recovery reclaims only clean, inactive legacy worktrees. Explicit feature
branches are kept until the cleanup tool succeeds. Dirty work, ignored outputs,
ongoing Git operations, or active transcripts leave worktrees in place. Set
`PI_WORKTREE_DEBUG=1` for recovery diagnostics. Existing managed session manifests
and resume records remain supported.

For recovery or administration, `pi --no-worktree-isolation` or
`PI_WORKTREE_ISOLATION_DISABLE=1 pi` bypasses this extension. `--no-extensions`
bypasses it as well.
