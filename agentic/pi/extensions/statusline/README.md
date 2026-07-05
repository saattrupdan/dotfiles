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

Quota bars show **remaining** quota (not used):
- `100%` = full quota available
- `0%` = quota exhausted

### Colors

| Remaining | Color |
|-----------|-------|
| > 50%     | Green |
| 20–50%    | Yellow |
| < 20%     | Red |

### Reset Times

- **Session**: Shows time until reset (e.g., `↻ 23:13` or `↻ 45m` if within 1 hour)
- **Weekly**: Shows day + time (e.g., `↻ Mon 13:13`)

## How It Works

For **Codex**, quota data is read from rollout files at:
```
~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
```

The extension polls these files every 30 seconds and after each provider response.

For **other OAuth models**, quota data comes from HTTP response headers in the `after_provider_response` event.

## Commands

View quota from the terminal:
```bash
codex-quota
```

This reads the same rollout files and shows session + weekly remaining percentages.
