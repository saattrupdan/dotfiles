---
name: freshrss
description: CLI for FreshRSS - local RSS reader with Google Reader API
tagline: FreshRSS CLI via macOS Keychain auth, digest views for agents
last-updated: 2026-07-02
autoload:
  tools:
    - bash
    - question
---

# FreshRSS CLI Skill

This skill defines the `freshrss` CLI tool for interacting with a local
FreshRSS instance running on `http://localhost:9999`. It uses the Google
Reader-compatible API and stores credentials securely in macOS Keychain.

## When to Use

Use this skill when the user asks to:

- **Check unread RSS items** - "What's new in my feeds?", "Show unread items"
- **Get a digest summary** - "Summarise my feed updates", "What should I read?"
- **Mark items as read** - "Mark these as read", "I've read these articles"
- **View article content** - "Show me the full article", "What does this say?"
- **Configure interests** - "I'm interested in Python and AI", "Filter for tech"
- **Troubleshoot FreshRSS** - "My FreshRSS isn't connecting", "Check my setup"

**Agent workflow**: Always start with a digest view (`freshrss unread --digest`),
ask the user which items they want to explore, then mark items as read after
confirmation. Never dump thousands of items without user direction.

## Requirements

- FreshRSS running locally on port 9999
  (Docker: `docker run -p 9999:80 freshrss/freshrss`)
- macOS Keychain access (via `/usr/bin/security`)
- Python 3.12+
- FreshRSS user account with API access enabled

## Quick Start

```bash
# Navigate to skill directory
cd agentic/skills/freshrss

# Install the CLI
uv pip install -e .

# Initialize credentials (prompts for username/password)
freshrss init

# View unread digest
freshrss unread --digest

# Check connection health
freshrss health

# Set user interests for filtering
freshrss interests set --name python --keywords python,programming,pycon

# Mark items as read (after user confirms)
freshrss mark-read item:abc123 item:def456
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

## Credential Management

### Init Command

The `init` command stores FreshRSS credentials in macOS Keychain:

```bash
freshrss init
```

It prompts for:
1. Username (email address or API username)
2. Password (user password or API-specific password)

**Scripting mode**: When stdin is not a TTY, provide credentials on two lines:

```bash
echo -e "user@example.com\nmyapipassword" | freshrss init
```

### Keychain Storage

Credentials are stored under service name `freshrss-cli`. No credentials
appear in config files, logs, or command history.

**Privacy note**: API passwords are recommended over main account passwords
when FreshRSS supports them (Settings > Profile > API password).

## API Reference

### Base URL

Default: `http://localhost:9999`

Override with `--base-url` flag for custom ports or remote instances:

```bash
freshrss unread --base-url http://myserver:8080
```

### Auth Token Flow

1. CLI exchanges username/password for GoogleLogin auth token
2. Token is used for all API requests via `Authorization` header
3. Token is NOT stored - re-authenticated on each command

### Google Reader API Endpoints

- `/api/greader.php/accounts/ClientLogin` - Authentication
- `/api/greader.php/reader/api/0/subscription/list` - List feeds
- `/api/greader.php/reader/api/0/stream/items/ids` - Get item IDs
- `/api/greader.php/reader/api/0/stream/item/contents` - Get item content
- `/api/greader.php/reader/api/0/edit-tag` - Mark as read

## Digest View

The `--digest` flag groups items for agent-friendly summarisation:

```bash
freshrss unread --digest -n 50
```

Output groups items by:
1. **Interest match** - Items matching configured keywords (★ prefix)
2. **Feed title** - Other items grouped by source (○ prefix)

Each group shows:
- Item count
- First 3 item titles with extractive summaries
- "N more" indicator for larger groups

### --raw JSON Mode

All commands support `--raw` for machine-readable output:

```bash
freshrss unread --digest --raw | jq '.[] | select(.interest)'
```

Agents should use `--raw` output for their own summarisation logic.

## Interests Storage

Non-secret interests are stored in `~/.config/freshrss-cli/interests.json`:

```json
{
  "groups": [
    {"name": "Python", "keywords": ["python", "pycon", "pydantic"]},
    {"name": "AI", "keywords": ["llm", "transformer", "diffusion"]}
  ]
}
```

### Commands

```bash
# Show current interests
freshrss interests show

# Add interest group (replaces existing with same name)
freshrss interests set --name tech --keywords python,ai,fastapi

# Remove all interests
freshrss interests remove-all
```

### Pi Memory Integration

Agents should also store user interests in Pi memory for persistence across
sessions:

```markdown
User interests for FreshRSS digest:
- Python ecosystem (pytest, ruff, fastapi)
- AI/ML (llama.cpp, transformers, agent systems)
- Local-first software (SQLite, sync-free tools)
```

When the user updates interests via CLI, agents should update Pi memory
accordingly for richer context.

## Agent Workflow

### Recommended Flow

1. **Check health first** - `freshrss health` to verify connectivity
2. **Get digest** - `freshrss unread --digest -n 50` for overview
3. **Highlight matches** - Point out interest-matched items (★ prefix)
4. **Ask user preferences** - "Which feeds or topics interest you?"
5. **View specific items** - `freshrss view <id>` for full content
6. **Confirm and mark read** - `freshrss mark-read <ids>` after user confirms

### Example Agent Dialogue

```
Agent: Checking your FreshRSS... You have 47 unread items.

Highlights:
★ Python (5 items) - pytest 9.0 release, new ruff rules
★ AI (3 items) - agent-browser updates, llama.cpp quantisation
○ Tech News (12 items)
○ Blogs (27 items)

Which would you like to explore first?
```

### Marking as Read

Always confirm before marking:

```
Agent: Mark these 8 items as read? [y/N]
```

Then execute: `freshrss mark-read id1 id2 id3...`

## Troubleshooting

### FreshRSS Not Reachable

```bash
freshrss health
# Output: ✗ - FreshRSS not running on port 9999
```

**Fix**: Start FreshRSS container:

```bash
docker run -d -p 9999:80 --name freshrss freshrss/freshrss
```

If the port is already in use, check existing container:

```bash
docker ps | grep freshrss
```

### Docker Daemon Not Running

```bash
freshrss health
# Output: ✗ - Network unreachable. Check Docker daemon is running.
```

**Fix**: Start Docker Desktop or `colima start`.

### Authentication Failed

```bash
freshrss init
# Output: Error: Authentication failed. Check credentials.
```

**Fixes**:
1. Verify FreshRSS is running
2. Check API password in FreshRSS Settings > Profile
3. Re-run `freshrss init` with correct credentials
4. Ensure user has API access enabled

### No Items Returned

If `freshrss unread` shows "No unread items":
1. Check if you actually have unread items in FreshRSS web UI
2. Try `freshrss unread raw` to see raw API response
3. Check subscription list: `freshrss health` shows feed count

### Keychain Errors

On first run, macOS may prompt for Keychain access. Click "Always Allow".

If credentials become corrupted:

```bash
# Remove stored credentials
security delete-generic-password -s freshrss-cli

# Re-initialise
freshrss init
```

## Privacy and Security

- **No hardcoded credentials** - all stored in Keychain
- **No credential logging** - passwords never appear in output
- **Local-only by default** - no cloud sync unless user configures remote
- **API password recommended** - use FreshRSS API password, not main login
- **Interests file non-secret** - `interests.json` contains no credentials

## Limitations

- **macOS only** - Keychain integration requires macOS
- **Single account** - no multi-account support
- **No OPML import/export** - use FreshRSS web UI for feed management
- **Digest summarisation extractive only** - no LLM summarisation built-in

## Testing

### Install and Verify

```bash
cd agentic/skills/freshrss
uv pip install -e .
freshrss --help
```

### Run Unit Tests (no live FreshRSS required)

```bash
cd agentic/skills/freshrss
uv run python -m unittest tests.test_freshrss -v
```

### Run CLI Tests

```bash
cd agentic/skills/freshrss
bun run tests/test.ts
```

### Test Keychain Mocking

Tests mock `/usr/bin/security` calls - no real Keychain access needed.

## Gotchas

### Port 9999 Reserved

Port 9999 is reserved for existing FreshRSS container. Do not start test
services on this port - use `--base-url` for custom ports during development.

### API Password vs User Password

FreshRSS supports a separate API password (Settings > Profile). Use this
instead of your main login password for API access.

### Token Expiry

Auth tokens don't expire, but re-authentication happens on each command.
If login fails mid-session, re-run `freshrss init`.

### Large Unread Counts

Default limit is 20 items for `unread`. Always use `-n` flag or `--digest`
to avoid dumping thousands of items.

## Examples

### Morning Digest Routine

```bash
# Check what's new
freshrss unread --digest -n 30

# View specific item
freshrss view item:tag:example.com:abc123

# Mark as read after reading
freshrss mark-read item:tag:example.com:abc123
```

### Filter by Interest

```bash
# Set interests
freshrss interests set --name devops --keywords kubernetes,docker,terraform

# View only interest-matched items (via --raw + jq)
freshrss unread --raw | jq '.[] | select(.origin.title == "DevOps Weekly")'
```

### Scripted Setup

```bash
# Non-interactive init
echo -e "user@example.com\napipass123" | freshrss init

# Verify setup
freshrss health && echo "Setup complete"
```

---

See `README.md` for user documentation and `tests/` for test suite.
