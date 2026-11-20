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
3. Identify the user's end goal and all remaining stages needed to reach it. Progress
   and ETA refer to that entire run, not just the active stage. Find an authoritative
   total and completed count where possible, such as tasks, bytes, or epochs.
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

- **Timestamp:** A human-readable weekday, date, and 24-hour time in Danish local time,
  formatted as `Weekday, D Mon YYYY, HH:mm`. Do not include the timezone or use ISO 8601
  separators such as `T`.
- **Status:** A concise state such as `queued`, `running`, `stalled`, `succeeded`,
  `failed`, or `cancelled`, plus the current stage or useful detail.
- **Progress:** Whole-run completion percentage toward the user's end goal. Prefer an
  authoritative metric or derive it from `completed / total` and show those counts.
  Without a total, give a rough percentage based on completed and remaining work,
  explicitly labeled `estimated`; never present a guess as a measured percentage.
- **ETA:** Always give an estimated remaining duration and expected completion
  timestamp for the entire run. Use a rough guess when data is sparse or absent;
  label it `rough estimate` and briefly state its basis. Low confidence is a reason
  to use a wider range, not to omit the estimate or write `unknown`.
- **Stage estimates:** When useful, add separately labeled progress and ETA for the
  current stage, alongside the whole-run estimates. If only stage timings are known,
  use them for the stage ETA and make a rough guess for the full run, including the
  remaining stages. Never silently substitute stage completion for the user's goal.
- **Next check:** The planned interval, unless this is the final report.

Always convert timestamps to the `Europe/Copenhagen` timezone, including timestamps
received from a remote service. Apply daylight-saving time for the reported date; do not
use the agent host's timezone unless it is also `Europe/Copenhagen`.

Use this compact template:

```text
[Saturday, 26 Sep 2026, 14:32]
Status: running — processing batch 18 of 40
Progress: 45% (18/40 batches)
ETA: about 24 minutes, around Saturday, 26 Sep 2026, 14:56
Next check: 5 minutes
```

With sparse data, give explicit whole-run guesses rather than withholding estimates:

```text
[Saturday, 26 Sep 2026, 14:32]
Status: running — remote build, then deployment and verification
Progress: roughly 30% of full run (estimated from remaining stages)
ETA: rough estimate 30–60 minutes, around Saturday, 26 Sep 2026, 15:02–15:32
Basis: no timing data yet; estimated build, deployment, and verification time
Stage ETA: build about 20 minutes, around Saturday, 26 Sep 2026, 14:52
Next check: 10 minutes
```

## Estimating the ETA

Always estimate; do not wait for enough data to make the estimate reliable. An ETA
is a working prediction, not a guarantee. Use the best available basis:

1. Prefer a process-reported ETA, checking whether it covers the full run or only the
   current stage. Add time for all remaining stages to obtain the whole-run ETA.
2. Use recent iteration durations or progress deltas as soon as any are available:
   estimate `remaining work / recent rate`. A single completed iteration is enough
   for an initial guess; refine it over subsequent checks and smooth noisy rates.
3. If no timing data exists, make an informed guess based on the task type, apparent
   size, and remaining stages. Even a very rough guess is better than no ETA.
4. Weight stages by expected duration or effort when estimating overall progress;
   completing one of four stages does not necessarily mean 25% of the run is done.
5. Use a range for highly variable work and state the main assumption briefly.
   Revise both progress and ETA on every check as evidence arrives, including when
   an earlier guess proves wrong. Do not keep an expired completion time.
6. For stalls, queues, or retries, include a rough allowance for the delay and name
   the recovery assumption. Continue estimating while the run remains active. If
   completion requires user action, state that dependency and estimate the remaining
   runtime after it. For terminal states, report the outcome rather than predicting
   future completion.

## Failures and stalls

- Report errors and abnormal states immediately; do not wait for the next scheduled
  update once detected.
- Include the last known progress and revise the whole-run ETA for the delay using
  an explicit recovery assumption; do not present a stale ETA as current.
- Retry transient status-check failures on the frequent interval before concluding that
  the monitored operation failed. Distinguish a monitoring failure from a process
  failure.
- Do not restart, cancel, or otherwise modify the operation unless the user asked for
  that behavior or separately approves the consequential action.
