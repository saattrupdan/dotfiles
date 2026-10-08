---
name: tmux
description: >-
  Use when creating, running, attaching to, inspecting, or cleaning up local tmux
  sessions for agent-run commands and long-running jobs.
last-updated: 2026-10-08
---

# Local tmux sessions

Use an ordinary interactive shell in a named session, just as `tmux new -s NAME` would.
A detached session is fine when the agent starts it for the user to attach later;
detached does **not** mean the pane should run a non-interactive shell.

## Start a job

1. Check `command -v tmux`, `tmux list-sessions`, the intended working directory, and
   whether the same job is already running. Pick a unique, descriptive session name; do
   not launch a duplicate process against the same output files.
2. Create the session with the skill's helper, which starts an interactive shell
   in the given directory and marks the session with tmux's `@pi_agent=1` option:

   ```bash
   ~/.pi/agent/skills/tmux/tmux-agent start my-job /absolute/path/to/project
   ```

   If creating a session by hand (including one the user will attach to), mark it
   immediately after creation with `tmux set-option -t my-job @pi_agent 1`.
   Never mark an existing user-created session. Never pass the job as a positional
   command to `tmux new-session`:
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

Close agent-created sessions once their commands have finished, rather than leaving
idle shells indefinitely. After a job finishes or is canceled, capture any results
needed for the user, then run the cleanup command. Also run it at the end of agent
work that used tmux, and when asked to clear completed agent sessions:

```bash
~/.pi/agent/skills/tmux/tmux-agent cleanup
```

Cleanup scans **only sessions marked `@pi_agent=1`**. It closes a session only when
it is detached and every pane has a verifiably idle shell (the shell owns the
terminal foreground process group and has no child process). Running foreground or
background commands, attached sessions, user-created sessions, and sessions whose
state cannot be verified are left alone. If the user needs to inspect a finished
session, keep it attached until they are done; once detached, cleanup can close it.
Names alone do not prove ownership, so old unmarked agent sessions are not included.
Never use `tmux kill-server` for cleanup: it also kills unrelated sessions.
