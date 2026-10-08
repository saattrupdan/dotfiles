# `/loop`

Run a prompt repeatedly in the **current Pi session**:

```text
/loop fix the next TypeScript error
/loop task.txt
/loop @prompts/task.txt
/loop 1m30s @"prompts/fix errors.txt"
/loop 1m30s "prompts/fix errors.txt"
/loop 1m30s fix TypeScript errors in src/
/loop 1h --max-runs 3 check the PR's CI status
/loop 1m30s fix TypeScript errors --until npx tsc --noEmit exits with code 0
/loop status
/loop stop
```

Syntax: `/loop [duration] [--max-runs N] <prompt|file.txt> [--until <condition>]`.
A standalone `.txt` path is read relative to Pi's working directory (or as an
absolute path) when the loop starts. Prefix it with `@` to use Pi's tab completion;
quote paths containing spaces after the `@` (for example `@"my prompt.txt"`). Its
contents become the prompt for every run, even if the file changes later. An unreadable or
empty file does not start a loop. Prose mentioning a `.txt` file remains a normal
prompt.
Durations consist of positive integer `h`, `m`, and `s` components in that order,
for example `1h2m3s`. The maximum duration is 24 hours. Omit the duration to
start the next run immediately after the previous run (and check) settles. The
first run always starts immediately. There is one active loop per Pi session.

Starting a loop automatically enables non-interactive mode for its full lifetime:
iterations are instructed not to ask questions, and the `question` tool is
blocked in the orchestrator and its subagents. The mode ends when the loop stops.
On macOS, caffeinate treats the whole loop (including delays, compaction, and
completion checks) as a live session, so a shut lid does not put the laptop to
sleep between runs when caffeinate is configured and enabled. If the loop ends
with the lid closed, the Mac stays awake until the lid opens; `/caffeinate off`
or session shutdown releases it sooner, and the thermal safety cutoff still
applies. Keeping the lid shut after completion consumes battery power.

Each working run gets the same prompt in the **same Pi session**. Before each
subsequent run, the extension compacts earlier conversation into a short
progress summary **when Pi has enough history to compact**. The next run then
receives that summary and whatever recent history Pi retains; this is not a
fresh agent or a full context reset. Files changed in earlier runs remain
changed. Pi normally retains its most recent 20,000 tokens, so short sessions
run with their existing history rather than wasting a compaction call. Other
compaction failures stop the loop. Compaction itself uses an additional model
call and may take time. With `--until`, a separate, fresh, ephemeral Pi process checks the
condition after every run. It can inspect the working directory and run verification commands,
but it does not inherit the working agent's conversation: it sees the condition
and a bounded copy of the last final answer. It returns a yes/no verdict with
evidence. A failed or malformed check stops the loop visibly; it never counts
as success. The checker is instructed not to modify files, but its shell tool is
**not a read-only sandbox**. Use explicit, verifiable conditions and review
its work as you would any other agent action.

`--until` loops default to 20 runs unless `--max-runs N` overrides the cap.
Plain loops have no default cap. `/loop stop` is the explicit way to stop a
loop: it prevents future runs and cancels an active checker, but does not abort
an already-running working turn. Sending a user message (interactive or RPC)
does not stop the loop; the next run waits until Pi is idle and pending messages
have settled. Loops can also end automatically when a completion condition or
run cap is reached, or on an error. Session changes, reloads, and shutdowns
clear the loop. The loop is in-memory only, requires an
interactive Pi session (TUI or RPC), and does not survive a restart. Print/JSON
mode cannot keep an extension-started turn alive and is not supported. The interval is measured from the end of the
working run and any completion check; compaction happens after the delay and
before the next run. Runs never overlap. A busy Pi session defers the next run
until it is idle.
