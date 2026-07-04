---
name: gmail
description:
  CLI for Gmail via Google's REST API — list, search, read, send, draft, label,
  delete. Use for all Gmail email operations.
last-updated: 2026-07-04
---

# gmail

Read and send email through the `gmail` CLI for Gmail via Google's REST API.

**All interaction goes through the `gmail` CLI.** Authentication is via OAuth 2.0,
stored securely in `~/.gmail/token.json`.

## How it works

The Gmail CLI uses the **Google Gmail REST API** directly — no browser automation, no
IMAP/SMTP. This is more robust and reliable than browser-based approaches.

- **OAuth 2.0** authentication with automatic token refresh
- **REST API** for all operations (list, read, send, draft, label, delete)
- **macOS Keychain** integration for storing sensitive credentials
- **Gmail-specific features**: labels (not folders), threads, stars, spam, trash

Config lives in `~/.gmail/`. The OAuth token is refreshed automatically.

## Prerequisites

Verify the CLI is available:

```bash
which gmail
```

If missing, install it editable with `uv`:

```bash
cd /Users/dansmart/gitsky/dotfiles/agentic/skills/gmail
uv pip install -e .
```

## Authentication

### First-time setup

1. **Get OAuth credentials:**
   - Go to [Google Cloud Console](https://console.cloud.google.com/)
   - Create a new project (or select existing)
   - Enable the Gmail API
   - Create credentials → OAuth 2.0 Client ID → Application type: **Desktop app**
   - Download the JSON and save as `~/.gmail/credentials.json`

2. **Login:**
   ```bash
   gmail login
   ```
   This opens a browser window for OAuth consent. The token is saved to
   `~/.gmail/token.json` (chmod 600).

3. **Optional — store refresh token in Keychain:**
   ```bash
   security add-generic-password -s 'gmail' -a 'your-email@gmail.com' -w '<refresh-token>'
   ```

### Subsequent sessions

The OAuth token is automatically refreshed. If it expires, re-run `gmail login`.

## Read

```bash
# List messages (newest first) — table format
gmail list
gmail list --limit 20
gmail list --unread
gmail list --starred
gmail list --label INBOX
gmail list --label SENT

# Search with Gmail query syntax
gmail list --query "from:boss@company.com"
gmail list --query "subject:invoice"
gmail list --query "has:attachment"
gmail list --query "after:2026-01-01 before:2026-07-04"

# Read a specific message (use ID from list)
gmail read <message-id>
gmail read --raw <message-id>    # JSON output
```

**Gmail query syntax:**
- `from:name@example.com` — sender
- `to:name@example.com` — recipient
- `subject:keyword` — subject line
- `is:unread`, `is:starred`, `is:important`
- `has:attachment`, `has:drive`
- `after:YYYY/MM/DD`, `before:YYYY/MM/DD`
- `label:label-name` — custom labels

## Unread workflow

Process unread emails one at a time:

```bash
# Fetch unread messages
gmail list --unread --limit 1

# Read the message
gmail read <message-id>

# Mark as read (if needed — reading doesn't auto-mark)
gmail label --remove UNREAD --message-id <id>
```

## Send

```bash
gmail send --to alice@example.com --subject "Hi" --body "Quick note"
gmail send --to a@x.com --subject "Report" --body-file ./report.txt --cc boss@x.com
echo "body from stdin" | gmail send --to a@x.com --subject Hi --body-file - --confirm
```

- `--to` takes a single email (Gmail API limitation for simple send)
- `--cc` for carbon copy
- Body from `--body` or `--body-file` (`-` reads stdin)
- **Confirms first** (prints message, waits for `y/N`) unless `--confirm`

**Always show the draft to the user and get explicit approval before sending.**

## Drafts

```bash
# Create a draft
gmail draft --to alice@example.com --subject "Hi" --body "Draft message"
gmail draft --to a@x.com --subject "Report" --body-file ./draft.txt

# List drafts
gmail draft --list
gmail draft --list --limit 5
gmail draft --list --raw    # JSON

# Show a specific draft
gmail draft --show <draft-id>
gmail draft --show <draft-id> --raw

# Delete a draft
gmail draft --delete <draft-id>
```

## Delete / Trash / Spam

```bash
# Move to trash (can be recovered)
gmail delete <message-id> --trash

# Mark as spam
gmail delete <message-id> --spam

# Delete permanently (bypass trash)
gmail delete <message-id>
```

## Labels (Gmail's folders)

Gmail uses **labels** instead of folders. A message can have multiple labels.

```bash
# List all labels
gmail label --list
gmail label --list --raw

# Create a new label
gmail label --create "Projects/Client-X"

# Add label to message
gmail label --add LABEL_ID --message-id <id>

# Remove label from message
gmail label --remove LABEL_ID --message-id <id>
```

**Built-in label IDs:**
- `INBOX`, `SENT`, `DRAFT`, `SPAM`, `TRASH`
- `UNREAD`, `STARRED`, `IMPORTANT`

**Custom labels** get auto-generated IDs (use `gmail label --list` to find them).

## Archive

Archive removes the `INBOX` label (message stays in "All Mail"):

```bash
# Archive is just removing INBOX label
gmail label --remove INBOX --message-id <id>
```

## Star / Unstar

```bash
# Star a message
gmail label --add STARRED --message-id <id>

# Unstar a message
gmail label --remove STARRED --message-id <id>
```

## Output formats

Most commands support `--raw` for JSON output — useful for scripting:

```bash
gmail list --raw | jq '.[].id'
gmail read --raw <id> | jq '.payload.headers'
```

## Error handling

- **`Not authenticated`** — run `gmail login`
- **`credentials.json not found`** — download from Google Cloud Console
- **`Token expired`** — automatic refresh; if that fails, re-run `gmail login`
- **`Gmail API error`** — network issue or API quota exceeded; retry

## Etiquette & security

- **Email is sensitive.** Never paste message contents, addresses, or tokens into
  external services, logs, or other models.
- **OAuth token** in `~/.gmail/token.json` is chmod 600 — never commit it.
- **`credentials.json`** (OAuth client secret) should also be kept private.
- **Respect rate limits.** Gmail API has generous quotas but don't hammer it.
- **Re-confirm every send** with the user before it goes out.

## Differences from folder-based email

Gmail uses **labels**, not folders:

| Concept | Folders (IMAP/OWA) | Gmail Labels |
|---------|-------------------|--------------|
| Organization | One folder per message | Multiple labels per message |
| "Move" | Copy then delete | Add/remove labels |
| Archive | Move to Archive folder | Remove INBOX label |
| Delete | Move to Trash | Remove all labels → auto-trash |

This means a message can be in "Inbox" AND "Projects" AND "Important" simultaneously.

## Gmail API limitations

- **No attachments** in this CLI version (API supports it, not implemented)
- **Single recipient** in `--to` (use BCC/CC workarounds or send multiple)
- **No HTML body** — plaintext only
- **No threads** — messages individually (Gmail threads via `threadId` not exposed)

These can be added in future versions if needed.
