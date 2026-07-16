# freshrss

CLI for interacting with local FreshRSS instance via Google Reader-compatible
API. Uses macOS Keychain for secure credential storage.

## Requirements

- FreshRSS running locally (port 9999 default)
- macOS (for Keychain integration)
- Python 3.12+

## Quick Start

```bash
# Install
cd agentic/skills/freshrss
uv pip install -e .

# Initialise credentials
freshrss init

# View unread digest
freshrss unread --digest

# Mark items as read
freshrss mark-read item:id1 item:id2
```

## Commands

| Command | Description |
|---------|-------------|
| `init` | Store credentials in Keychain |
| `unread [-n N] [--digest] [--raw]` | List unread items |
| `read [-n N] [--raw]` | List recently read items |
| `view <id> [--raw]` | Show single item |
| `mark-read <id...>` | Mark items as read |
| `health` | Check connectivity and auth |
| `interests show [--raw]` | Show interest groups |
| `interests set --name N --keywords K` | Add interest group |
| `interests remove-all` | Clear all interests |

## FreshRSS Setup

Start FreshRSS container:

```bash
docker run -d -p 9999:80 --name freshrss freshrss/freshrss
```

Enable API access in FreshRSS Settings > Profile.

## Examples

```bash
# Morning digest
freshrss unread --digest -n 30

# Set interests for filtering
freshrss interests set --name python --keywords python,fastapi,pytest

# Check health
freshrss health

# Full item view
freshrss view item:tag:example.com:abc123

# Raw JSON output for agents
freshrss unread --raw
```

## Testing

```bash
# Unit tests (no live FreshRSS required)
uv run python -m unittest tests.test_freshrss -v

# CLI tests
bun run tests/test.ts
```

## Privacy Notes

- Credentials stored in macOS Keychain, never in config files
- Use FreshRSS API password (not main login) when available
- Interests file (`~/.config/freshrss-cli/interests.json`) is non-secret

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Not reachable | Start FreshRSS: `docker run -p 9999:80 freshrss/freshrss` |
| Auth failed | Re-run `freshrss init` with correct credentials |
| No items | Check you have unread items in FreshRSS web UI |
| Keychain error | Click "Always Allow" on macOS prompt |

See `SKILL.md` for detailed API reference and agent workflows.
