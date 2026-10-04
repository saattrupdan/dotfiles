# `/loop`

Run a prompt repeatedly in the **current Pi session**:

```text
/loop fix the next TypeScript error
/loop 1m30s fix TypeScript errors in src/
/loop 1h --max-runs 3 check the PR's CI status
/loop 1m30s fix TypeScript errors --until npx tsc --noEmit exits with code 0
/loop status
/loop stop
```

Syntax: `/loop [duration] [--max-runs N] <prompt> [--until <condition>]`.
Durations consist of positive integer `h`, `m`, and `s` components in that order,
for example `1h2m3s`. The maximum duration is 24 hours. Omit the duration to
start the next run immediately after the previous run (and check) settles. The
first run always starts immediately. There is one active loop per Pi session.

Each working run gets the same prompt **and the existing conversation history**;
it is not a fresh agent or a context reset. Files changed in earlier runs also
remain changed. Pi may compact old conversation as the context grows. With
`--until`, a separate, fresh, ephemeral Pi process checks the condition after
every run. It can inspect the working directory and run verification commands,
but it does not inherit the working agent's conversation: it sees the condition
and a bounded copy of the last final answer. It returns a yes/no verdict with
evidence. A failed or malformed check stops the loop visibly; it never counts
as success. The checker is instructed not to modify files, but its shell tool is
**not a read-only sandbox**. Use explicit, verifiable conditions and review
its work as you would any other agent action.

`--until` loops default to 20 runs unless `--max-runs N` overrides the cap.
Plain loops have no default cap. `/loop stop` prevents future runs and cancels
an active checker; it does not abort an already-running working turn. Starting
another user task (interactive or RPC) stops the loop. Session changes,
reloads, and shutdowns clear its timer. The loop is in-memory only, requires an
interactive Pi session (TUI or RPC), and does not survive a restart. Print/JSON
mode cannot keep an extension-started turn alive and is not supported. The interval is measured from the end of the
working run and any completion check; runs never overlap. A busy Pi session
defers the next run until it is idle.
