# alexandra-confluence

CLI tool for Alexandra's internal Confluence instance at `confluence.alexandra.dk`.

## Requirements

- **Alexandra VPN** must be connected
- Python 3.10+ (uses `from __future__ import annotations`)
- No external dependencies — standard library only

## Quick Start

```bash
# Authenticate (prompts for username/password if env vars not set)
python3 alexandra_confluence.py auth

# List spaces
python3 alexandra_confluence.py spaces

# Search for pages
python3 alexandra_confluence.py search "Alexandra Way"

# List pages in a space
python3 alexandra_confluence.py pages --space-key PROJ

# Get a page's content
python3 alexandra_confluence.py page --key SOME_KEY

# Create a new project page (auto-fills The Alexandra Way template)
python3 alexandra_confluence.py create-project --title "My Project" --client "Client" --owner "Owner"
```

## Authentication

Credentials are read from environment variables or prompted interactively:

```bash
export CONFLUENCE_USER=your.username
export CONFLUENCE_PASS='your-password'  # Use single quotes if password has special chars
```

If either variable is unset, the script prompts via `getpass` (input hidden on terminal).

**Security:**
- Credentials are **never stored on disk**
- Only session cookies are persisted in `~/.alexandra-confluence/cookies.txt`
- Delete that file to force re-authentication

## Commands

| Command | Description |
|---|---|
| `auth` | Force re-authentication |
| `spaces [--limit N] [--start N]` | List all spaces |
| `pages --space-key KEY [--limit N]` | List pages in a space |
| `search QUERY [--cql "cql"] [--limit N]` | Search pages (simple query or full CQL) |
| `page --key KEY \| --id ID [--format text\|html]` | Get a single page |
| `create --space-key KEY --title T --body "<html>" [--ancestor-id ID]` | Create a new page |
| `create-project --title T --client C --owner O [--budget B]` | Create project page with The Alexandra Way template |
| `update --id ID --body "<html>" [--title T]` | Update an existing page |
| `delete --id ID` | Delete a page |
| `whoami` | Show current user |
| `api --method GET\|POST --path PATH [--body JSON]` | Raw API call (advanced) |

All commands accept `--raw` to print the unformatted JSON response.

## Password Special Characters

The login POST body requires URL-encoding for `&`, `@`, `/`, `#`. If your password contains these, either:
1. Set `CONFLUENCE_PASS` in your shell with proper quoting, or
2. Let the script prompt interactively (it handles encoding automatically)

## Troubleshooting

- **"Cannot reach Confluence"** — VPN is not connected
- **"Login failed"** — Wrong credentials; delete `~/.alexandra-confluence/cookies.txt` and retry
- **"Not permitted to use confluence"** — Session expired; run `python3 alexandra_confluence.py auth`
