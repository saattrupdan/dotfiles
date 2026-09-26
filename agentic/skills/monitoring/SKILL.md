---
name: monitoring
description: >-
  Monitor long-running processes by repeatedly sleeping, checking progress, and
  reporting timestamped status updates with completion percentage and ETA. Use whenever
  a user asks an agent to monitor, watch, wait for, track, or keep an eye on a process,
  job, build, deployment, training run, transfer, or other long-running operation.
tagline: Monitor long-running work with adaptive status updates
last-updated: 2026-09-26
---

# Monitoring long-running processes

Use this procedure when the user asks you to monitor a long-running operation. Do not
return after one status check: remain in a sleep-check-report loop until the process
reaches a terminal state, the user asks you to stop, or continued monitoring becomes
impossible.

## Before monitoring

1. Identify a read-only status command or endpoint and the operation's stable
   identifier. Do not rely only on a process name if IDs, job names, or run IDs exist.
2. Determine the signals for successful completion, failure, cancellation, a stall, and
   normal progress.
3. Find an authoritative total and completed count where possible. Examples include
   tasks completed, bytes transferred, epochs run, or pipeline stages finished.
4. Record the start time and an initial baseline when available, but sleep before the
   first reported monitoring check unless the expected runtime is shorter than the
   initial interval.

## Monitoring loop

For every cycle:

1. Sleep for the current interval. Use a foreground sleep with a timeout safely longer
   than the interval so that you can report after it finishes. Do not start a detached
   polling loop that cannot send updates to the user.
2. Check the operation without disrupting it.
3. Report the result immediately using the required format below.
4. Stop after reporting a terminal success, failure, or cancellation state.
5. Otherwise, choose the next interval using the adaptive schedule and repeat.

Do not say that you will continue monitoring unless you actually continue the loop.

## Adaptive schedule

Start with frequent checks, then back off while the process remains healthy:

| Healthy checks completed | Default next interval |
| ------------------------ | --------------------: |
| 0–2                      |             2 minutes |
| 3–5                      |             5 minutes |
| 6–8                      |            10 minutes |
| 9–11                     |            20 minutes |
| 12–14                    |            30 minutes |
| 15–17                    |                1 hour |
| 18 or more               |               2 hours |

Use these as defaults rather than rigid timers:

- Advance through the schedule only while status checks are healthy and progress is
  consistent with the operation's expected behavior.
- Never sleep longer than 2 hours between checks.
- Use a shorter interval when the ETA is sooner than the planned next check, completion
  is near, a stage boundary is approaching, or the process reports warnings.
- Reset to 2 minutes after an error, restart, unexpected state change, suspected stall,
  or recovery. If repeated checks confirm stability, back off again.
- A lack of visible progress is not necessarily a stall. Account for operations with
  long indivisible stages, sparse metrics, or queued work.
- Respect service rate limits. If they conflict with the schedule, use the shortest
  permitted interval, capped at 2 hours, and mention the constraint.

## Status report format

Every report must include:

- **Timestamp:** ISO 8601 in Danish local time, with an explicit UTC offset and the
  applicable `CET` or `CEST` abbreviation.
- **Status:** A concise state such as `queued`, `running`, `stalled`, `succeeded`,
  `failed`, or `cancelled`, plus the current stage or useful detail.
- **Progress:** A percentage when a trustworthy total exists. Prefer an authoritative
  metric; otherwise derive it from `completed / total` and show those counts. Never
  invent a percentage.
- **ETA:** Both an approximate duration and expected completion timestamp when they can
  be estimated. If not, write `unknown` and briefly explain why.
- **Next check:** The planned interval, unless this is the final report.

Always convert timestamps to the `Europe/Copenhagen` timezone, including timestamps
received from a remote service. Apply daylight-saving time for the reported date; do not
use the agent host's timezone unless it is also `Europe/Copenhagen`.

Use this compact template:

```text
[2026-09-26T14:32:00+02:00 CEST]
Status: running — processing batch 18 of 40
Progress: 45% (18/40 batches)
ETA: about 24 minutes, around 2026-09-26T14:56:00+02:00 CEST
Next check: 5 minutes
```

For unknown progress or ETA, retain the fields:

```text
[2026-09-26T14:32:00+02:00 CEST]
Status: running — waiting for the remote build stage
Progress: unavailable — the service exposes no work total
ETA: unknown — no completed unit or historical rate is available
Next check: 10 minutes
```

## Estimating the ETA

Prefer an ETA reported by the process itself. Otherwise:

1. Measure progress over at least two checks rather than extrapolating from a single
   sample.
2. Estimate the recent rate and calculate `remaining work / rate`.
3. Smooth noisy rates over several healthy checks when possible.
4. Label the result as approximate, and revise it as new information arrives.
5. Do not provide a numeric ETA when progress is stalled, moving backward, or too
   irregular for a defensible estimate.

## Failures and stalls

- Report errors and abnormal states immediately; do not wait for the next scheduled
  update once detected.
- Include the last known progress and ETA, but do not present a stale ETA as current.
- Retry transient status-check failures on the frequent interval before concluding that
  the monitored operation failed. Distinguish a monitoring failure from a process
  failure.
- Do not restart, cancel, or otherwise modify the operation unless the user asked for
  that behavior or separately approves the consequential action.
