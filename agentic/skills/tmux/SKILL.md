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
   equivalent. Never pass the job as a positional command to `tmux new-session`:
   tmux would run it *instead of* a shell, so Ctrl-C or job exit closes the pane.
   Never use `exec`, `bash -lc`, or a launcher that replaces the pane's shell.
   Before sending the job, check that the pane's process is the expected shell:

   ```bash
   ps -p "$(tmux display-message -pt my-job:0.0 '#{pane_pid}')" -o args=
   ```

   `pane_current_command` alone is not a shell check: it shows a foreground job
   such as `uv` even when an interactive shell remains underneath.

3. Type the **actual runnable command** into that shell, then press Enter. This leaves
   it in the pane's command history: after the job exits, Up retrieves it for editing
   and rerunning.

   ```bash
   tmux send-keys -t my-job:0.0 -l 'uv run src/scripts/job.py --option value'
   tmux send-keys -t my-job:0.0 Enter
   ```

   Prefer a direct command to an opaque wrapper. If a compatibility wrapper is genuinely
   needed, type its complete invocation directly into the normal shell. An agent may
   send commands into a pane the user is attached to; first check that the shell is idle
   and do not overwrite a partially typed command or interrupt an editor. Keep
   credentials out of command history; use an existing secure environment or credential
   store rather than typing secrets into the pane.

4. Verify the actual process and output, not just `tmux has-session`. A tmux session can
   exist with an idle shell after its job has failed. If a canceled job closes the pane,
   check whether the pane ran the job directly or an agent killed the session:

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

Track the names of sessions you create. **Leave them open after a job finishes or is
canceled**, with the shell ready for the user to inspect, edit, or rerun the command.
Do not treat an idle shell as a dead session or automatically kill it. When the user
asks to clean up an agent-created session, first check that it is idle and unattached;
then remove **that session**:

```bash
tmux list-sessions -F '#{session_name} #{session_attached}'
tmux kill-session -t my-job
```

- Do not confuse a running job with a dead session; leave active sessions alone.
- Do not kill a session that the user created or is currently attached to. If the user
  is attached to an idle agent-created session, let them detach first.
- When replacing a session, leave the old one for inspection unless the user asked
  to remove it. Do not silently replace a shell the user may still need.
- Never use `tmux kill-server` for cleanup: it also kills unrelated sessions.
