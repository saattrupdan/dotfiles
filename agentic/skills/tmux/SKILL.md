---
name: tmux
description: >-
  Use when creating, running, attaching to, inspecting, or cleaning up local tmux
  sessions for agent-run commands and long-running jobs.
last-updated: 2026-10-03
---

# Local tmux sessions

Use an ordinary interactive shell in a named session, just as `tmux new -s NAME` would.
A detached session is fine when the agent starts it for the user to attach later;
detached does **not** mean the pane should run a non-interactive shell.

## Start a job

1. Check `command -v tmux`, `tmux list-sessions`, the intended working directory, and
   whether the same job is already running. Pick a unique, descriptive session name; do
   not launch a duplicate process against the same output files.
2. Create the session **without a command argument**. `-c` sets the pane's working
   directory while tmux starts its normal interactive default shell:

   ```bash
   tmux new-session -d -s my-job -c /absolute/path/to/project
   ```

   If the user will start it themselves in a terminal, `tmux new -s my-job` is
   equivalent. Never use `tmux new-session ... 'bash -lc ...'`, `exec bash`, or a
   launcher script that replaces the pane's shell merely to keep it open.

3. Type the **actual runnable command** into that shell, then press Enter. This leaves
   it in the pane's command history: after the job exits, Up retrieves it for editing
   and rerunning.

   ```bash
   tmux send-keys -t my-job:0.0 -l 'uv run src/scripts/job.py --option value'
   tmux send-keys -t my-job:0.0 Enter
   ```

   Prefer a direct command to an opaque wrapper. If a compatibility wrapper is genuinely
   needed, type its complete invocation directly into the normal shell. Keep credentials
   out of command history; use an existing secure environment or credential store rather
   than typing secrets into the pane.

4. Verify the actual process and output, not just `tmux has-session`. A tmux session can
   exist with an idle shell after its job has failed:

   ```bash
   tmux display-message -pt my-job:0.0 \
     'shell=#{pane_current_command} cwd=#{pane_current_path}'
   tmux capture-pane -pt my-job:0.0 -S -30
   pgrep -fl 'src/scripts/job.py'
   ```

   Give the user `tmux attach -t my-job`. Do not attach the agent's own tool process to
   the session. A `tee` log is optional; when piping through `tee`, enable `pipefail` in
   the pane if exit status matters.

## Clean up agent-created sessions

Track the names of sessions you create. After a job reaches a terminal state, check its
process and pane. If the session is only an idle shell and is no longer needed for
inspection or a requested rerun, remove **that session**:

```bash
tmux list-sessions -F '#{session_name} #{session_attached}'
tmux kill-session -t my-job
```

- Do not confuse a running job with a dead session; leave active sessions alone.
- Do not kill a session that the user created or is currently attached to. If the user
  is attached to an idle agent-created session, let them detach first.
- When replacing an old agent-created session, remove the old idle, unattached session
  after the replacement is verified. Do not accumulate dead sessions.
- Never use `tmux kill-server` for cleanup: it also kills unrelated sessions.
