# gmail-cli

Gmail CLI via Google's REST API — list, search, read, send, draft, label, delete.

## Installation

```bash
uv pip install -e .
```

## Quick Start

```bash
# Login (first time only)
gmail login

# List messages
gmail list
gmail list --unread

# Read a message
gmail read <message-id>

# Send an email
gmail send --to alice@example.com --subject "Hi" --body "Hello!"

# Create a draft
gmail draft --to bob@example.com --subject "Later" --body "Draft content"

# Manage labels
gmail label --list
gmail label --add STARRED --message-id <id>
```

## Authentication

Requires `~/.gmail/credentials.json` from Google Cloud Console (OAuth 2.0 Desktop app).

See [SKILL.md](./SKILL.md) for full documentation.
