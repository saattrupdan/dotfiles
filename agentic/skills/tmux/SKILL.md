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
2. Create the session with ordinary tmux and mark it immediately. Keep the returned
   session ID and a unique marker for the watcher in step 4; do not mark an existing
   user-created session:

   ```bash
   session=$(tmux new-session -d -P -F '#{session_id}' -s my-job \
     -c /absolute/path/to/project)
   marker="$$-$(date +%s)-$RANDOM"
   tmux set-option -t "$session" @pi_agent "$marker"
   ```

   Never pass the job as a positional command to `tmux new-session`:
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

4. Start the watcher below **immediately after sending the command**. It runs outside
   tmux, checks the marked session every five seconds, and closes it after at least
   60 continuous seconds with no attached client, foreground command, or shell child
   (including a background job). An attached session or unverifiable state resets the
   timer. Use the same shell in which `session` and `marker` were set in step 2:

   ```bash
   nohup bash -c '
     session=$1 marker=$2
     idle() {
       local marked attached panes pid shell status pgid foreground command result
       marked=$(tmux show-option -qv -t "$session" @pi_agent 2>/dev/null)
       [[ $marked == "$marker" ]] || return 1
       attached=$(tmux display-message -pt "$session" \
         "#{session_attached}" 2>/dev/null) || return 1
       [[ $attached == 0 ]] || return 1
       panes=$(tmux list-panes -s -t "$session" \
         -F "#{pane_pid} #{pane_current_command}" 2>/dev/null) || return 1
       [[ -n $panes ]] || return 1
       while read -r pid shell; do
         case $shell in
           sh|bash|zsh|fish|dash|ksh|mksh|tcsh|csh|nu) ;;
           *) return 1 ;;
         esac
         status=$(ps -p "$pid" -o pgid= -o tpgid= -o comm=) || return 1
         read -r pgid foreground command <<< "$status"
         command=${command##*/}; command=${command#-}
         [[ $pgid == "$foreground" && $command == "$shell" ]] || return 1
         pgrep -P "$pid" >/dev/null 2>&1
         result=$?
         [[ $result == 1 ]] || return 1
       done <<< "$panes"
     }
     idle_since=
     while tmux has-session -t "$session" 2>/dev/null; do
       marked=$(tmux show-option -qv -t "$session" @pi_agent 2>/dev/null)
       [[ $marked == "$marker" ]] || exit 0
       if idle; then
         [[ -n $idle_since ]] || idle_since=$SECONDS
         if (( SECONDS - idle_since >= 60 )) && idle; then
           tmux kill-session -t "$session"
           exit 0
         fi
       else
         idle_since=
       fi
       sleep 5
     done
   ' watcher "$session" "$marker" </dev/null >/dev/null 2>&1 &
   ```

   Verify the actual process and output, not just `tmux has-session`. A tmux session can
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

The watcher closes **only its own marked session** after a minute of verified idle
shell time. It exits if that session disappears or its marker changes. Keep a session
attached while the user needs to inspect or rerun a completed command; detaching
allows the idle timer to start. Capture results before the minute elapses if the user
needs them, because the watcher removes the pane and its scrollback. Never use
`tmux kill-server`: it also kills unrelated sessions. Sessions created before this
watcher was introduced are not retroactively marked or closed.
