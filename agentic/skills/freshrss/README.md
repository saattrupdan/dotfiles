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

# View curated digest
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

## Digest Output

The `--digest` flag produces **curated highlights** grouped by topic, not by
feed:

```bash
freshrss unread --digest -n 50
```

Output includes:
- 📌 **Highlights** - 5-8 most relevant items with brief summaries
- ★ **○** icons indicating interest matches vs. other items
- 📁 **Topics** - Condensed breakdown by topic (e.g. Technology, Programming,
  General) with source feeds shown as provenance metadata
- Sample note if `-n` limit was reached

**Important:** Items are grouped by topic/interest, NOT by feed name. Feed
names appear only as secondary metadata (e.g. "Technology: 5 items (from The
Verge, TechCrunch)").

**Important:** `-n 50` fetches **up to 50 items** for review — it's not the
total unread count. There may be more unread items in FreshRSS.

## Examples

```bash
# Morning digest with curated highlights
freshrss unread --digest -n 30

# Set interests for filtering
freshrss interests set --name python --keywords python,fastapi,pytest

# Check health
freshrss health

# Full item view
freshrss view item:tag:example.com:abc123

# Raw JSON for agent processing
freshrss unread --digest --raw
```

## For Agents

When building responses about FreshRSS items:

1. **Treat `-n` as a fetch limit** — not the total unread count
2. **Use `--raw` mode** to get structured JSON for your own summarisation
3. **Check Pi memories** for user interests to prioritise relevant items
4. **Present curated highlights** (5-8 items) with brief "why it matters" notes
5. **Ask what to expand** — don't list every title from the fetch
6. **Group by topic or interest, NOT by feed** — feed names are provenance
   metadata only

Example agent response:

> "I've fetched 50 items for review. Here are the highlights most relevant
> to your interests in Python and AI: [3-4 bullet summaries with item IDs].
> Which would you like to explore?"

**Do NOT output grouped-by-feed sections** like "○ AI | The Verge". The raw
JSON already groups by topic with feed names in `sources` arrays for
provenance.

See `SKILL.md` for detailed agent workflows and gotchas.

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
