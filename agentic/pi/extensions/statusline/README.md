# Statusline Extension

Compact single-line footer for Pi showing model, context usage, and subscription quotas.

## Features

- **Model name** — Active model identifier
- **Context window** — Token usage bar with percentage and `used / total` format
- **Quota bars** — For OAuth subscription models and OpenAI Codex:
  - Session limit (typically 5h window)
  - Weekly limit (7-day window)
  - Credits balance (when on credits-based plan)

## Quota Bar Behavior

Quota bars show **used** quota (not remaining):
- `0%` = quota untouched
- `100%` = quota exhausted

### Colors

| Used   | Color |
|--------|-------|
| < 50%  | Green |
| 50–80% | Yellow |
| > 80%  | Red |

### Reset Times

- **Session**: Shows time until reset (e.g., `↻ 23:13` or `↻ 45m` if within 1 hour)
- **Weekly**: Shows day + time (e.g., `↻ Mon 13:13`)

## How It Works

For **Codex**, live quota is only reported in the `x-codex-*` rate-limit response
headers of `POST https://chatgpt.com/backend-api/codex/responses` (there is no
cheap GET, and the headers are returned even on a `429`).

Pi issues its own codex requests over WebSocket, so it never writes the
`~/.codex/sessions/**/rollout-*.jsonl` files and never surfaces those headers to
extensions. To keep the bars fresh, the extension makes its own minimal request
and reads just the headers, aborting the stream as soon as they arrive so it
consumes negligible quota (and none while rate limited). It authenticates with
pi's own codex token from `~/.pi/agent/auth.json` (skipping the probe if the
token is missing/expired — pi refreshes it on its next real request).

Refreshes happen:

- after each turn (`turn_end` / user `message_end`) — usage just changed
- on footer install and model switch
- on a slow idle timer (every 5 minutes)

The freshest quota is cached for first render at:

```text
~/.pi/agent/state/statusline/codex-quota-cache.json
```

No quota cache should live under the extension source tree.

Quota bars are hidden for the `inference` provider because it is not
subscription-based.

## Footer Lifetime

Pi owns one footer slot and clears it (restoring the built-in footer) whenever it
tears down extension UI — `/reload`, `/new`, `/resume`, `/fork`. It then re-runs
the extensions and emits `session_start`, so the footer is reinstalled there and
survives a reload without waiting for the next message. The reinstall is forced
because `installed` may still be stale from the previous load of the module.

On a session with no messages yet the install is deferred to `agent_start`, so
the splash screen keeps its own chrome until the first prompt.
