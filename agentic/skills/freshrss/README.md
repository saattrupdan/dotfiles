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

The `--digest` flag produces **curated highlights** grouped by specific topic
clusters, not by feed:

```bash
freshrss unread --digest          # Fetches ALL unread (recommended)
freshrss unread --digest -n 50    # Bounded sample for testing
```

Output includes:
- 📌 **Highlights** - 5-8 most relevant items with brief summaries
- ★ **○** icons indicating interest matches vs. other items
- 📁 **Topics** - Specific clusters (e.g. AI agents, code tooling, model
  releases, security vulnerabilities) with source feeds as provenance
- **Completeness indicator** - "reviewed all N unread items" vs "reviewed N
  fetched items (bounded by --limit; more may exist)"

**Important:** Items are grouped by topic/interest, NOT by feed name. Feed
names appear only as secondary metadata (e.g. "AI agents: 5 items (from
Hacker News, The Verge)").

**Default behavior:** Without `-n`, `--digest` fetches **all unread items**
via pagination. Use `-n` only for debugging or when user explicitly wants a
bounded sample.

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

1. **Default: fetch all unread** — use `freshrss unread --digest --raw` (no `-n`)
2. **Check completeness** — raw JSON includes `complete` flag and `fetched_count`
3. **Disclose bounded samples** — if `complete: false`, tell user it's incomplete
4. **Use `--raw` mode** for structured JSON with topic clusters
5. **Check Pi memories** for user interests to prioritise relevant items
6. **Present curated highlights** (5-8 items) with brief "why it matters" notes
7. **Ask what to expand** — don't list every title from the fetch
8. **Group by specific topic clusters** — not broad buckets or feed names

Example agent response:

> "I've reviewed all 247 unread items. Here are the highlights most relevant
> to your interests in Python and AI: [3-4 bullet summaries with item IDs].
> Which would you like to explore?"

**When using `-n` for bounded review:**

> "I've reviewed 50 items (bounded by --limit; more may exist). Here are the
> highlights: [summaries]. Want me to fetch more?"

**Topic labels:** Use specific clusters like "AI agents", "code tooling",
"model releases", "Grok/xAI" — not broad labels like "Technology" or
"Programming".

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
