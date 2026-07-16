---
name: freshrss
description: CLI for FreshRSS - local RSS reader with Google Reader API
tagline: FreshRSS CLI via macOS Keychain auth, digest views for agents
last-updated: 2026-07-16
autoload:
  tools:
    - bash
    - question
    - memory_suggest
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

The `--digest` flag produces curated highlights organised by topic, not by
feed/source:

```bash
freshrss unread --digest -n 50
```

Output format:
- **📌 Highlights** - 5-8 most relevant items with brief summaries and IDs
- **★ prefix** - Interest-matched items (prioritised first)
- **○ prefix** - Other items grouped by derived topic (e.g. Technology, AI &
  Machine Learning, Programming, General)
- **📁 Topics** - Condensed list showing item counts per topic, with source
  feeds listed as provenance metadata in parentheses
- **Sample note** - Indicates when `-n` limit was reached

**Important:** Items are grouped by topic/interest, NOT by feed name. Feed
names appear only as secondary metadata (e.g. "Technology: 5 items (from The
Verge, TechCrunch)"). This allows agents to regroup and summarise without
relying on feed names as the primary organisation.

### Important: `-n` is a Fetch Limit, Not Total Count

The `-n N` flag fetches **up to N items** from FreshRSS. It does NOT mean
there are exactly N unread items total. The CLI output will say:

- `FreshRSS Digest - 50 fetched (sample of up to 50)` - if you hit the limit
- `FreshRSS Digest - 23 fetched` - if fewer items exist than the limit

**Never tell the user "you have 50 unread items"** unless you actually
know the total count (which requires fetching all items). Always phrase it as:

- "I've fetched up to 50 items for review"
- "Reviewing a sample of 50 items from your feeds"
- "Found 50 items in this fetch (may be more unread)"

### Using `--raw` for Agent Summarisation

For building your own curated response, use JSON output:

```bash
freshrss unread --digest --raw -n 50
```

This returns structured JSON with topic-based groups. Each group contains:
- `topic`: The topic/interest label used for grouping
- `items`: Array of items with `title`, `content_snippet`, `link`, `id`, `source`
- `interest`: Boolean indicating if group matches configured interests
- `sources`: Array of feed names that contributed items to this topic

Example structure:
```json
{
  "groups": {
    "Programming": {
      "topic": "Programming",
      "interest": true,
      "sources": ["Real Python", "PyCoder's Weekly"],
      "items": [
        {
          "id": "item:123",
          "title": "Python Tips",
          "content_snippet": "...",
          "link": "...",
          "source": "Real Python"
        }
      ]
    }
  }
}
```

**Recommended agent workflow:**

1. Load user interests from Pi memory (`memory_suggest` with "fresh rss interests")
2. Fetch digest with `freshrss unread --digest --raw -n 50`
3. Prioritise interest-matched items using configured keywords
4. Present 5-8 curated highlights with brief "why it matters" summaries
5. Ask user what to expand; don't list every title
6. Use Pi memory to persist any new interest preferences

**Do NOT present feed/source groups as the main organisation.** Group by
topic, interest, or story cluster. Mention feed names only as provenance
metadata when useful (e.g. "from The Verge").

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
2. **Get digest with limit** - `freshrss unread --digest -n 50` (sample, not total)
3. **Use raw mode for processing** - `freshrss unread --digest --raw -n 50`
4. **Apply interests** - Match items against user interests from Pi memory
5. **Curate highlights** - Select 5-8 most relevant, write brief summaries
6. **Ask user preferences** - "Which topics interest you?" not "Here are all 50 titles"
7. **View specific items** - `freshrss view <id>` for full content on request
8. **Confirm and mark read** - `freshrss mark-read <ids>` after user confirms

### Example Agent Dialogue

```
Agent: Checking your FreshRSS... Fetching up to 50 items for review.

📌 Highlights (most relevant first):

★ pytest 9.0 released with improved assert rewriting
   → New version includes better error messages and xdist support.
   [ID: item:tag:example.com:abc123]

★ Ruff adds 15 new linting rules for aiohttp
   → Rules cover async context managers and session lifetime.
   [ID: item:tag:example.com:def456]

○ Hacker News (12 items)
○ Python Weekly (8 items)
...

Which would you like to explore first?
```

### What NOT to Do

❌ **Don't claim the limit is the total count:**
> "You have 50 unread items."  
> (Wrong — there may be 200 unread, you only fetched 50)

✅ **Do clarify it's a sample:**
> "I've fetched 50 items for review."  
> "Reviewing a sample of up to 50 items."

❌ **Don't dump all titles:**
> Lists 50+ titles with no prioritisation

✅ **Do curate highlights:**
> Show 5-8 items most relevant to user interests, ask what to expand

❌ **Don't mark items read without asking:**
> Automatically marking items as read

✅ **Do confirm first:**
> "Mark these 8 items as read?" [y/N]

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
2. Try `freshrss unread --raw` to see raw API response
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
  (agents should use `--raw` and build their own highlights)

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

### `-n` is a Limit, Not Total Unread Count

The `-n N` flag fetches **up to N items** — it's a sample size, not the
total unread count. If you fetch 50 items, there may be 50, 200, or 500
total unread items in FreshRSS.

**Correct phrasing:**
- "Reviewing 50 items" ✓
- "Fetched up to 50 for this digest" ✓
- "You have 50 unread" ✗ (unless you checked the total separately)

Default limit is 20 items. Use `-n 50` or `--digest` for morning briefings.

## Examples

### Morning Digest Routine

```bash
# Check what's new (sample of up to 30)
freshrss unread --digest -n 30

# View specific item
freshrss view item:tag:example.com:abc123

# Mark as read after reading
freshrss mark-read item:tag:example.com:abc123
```

### Agent Curated Highlights (using --raw)

```bash
# Get structured data for agent processing
freshrss unread --digest --raw -n 50 > /tmp/freshrss.json

# Agent reads JSON, applies user interests from Pi memory,
# and presents 5-8 highlights with brief summaries
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
