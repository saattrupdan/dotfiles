# alexandra-confluence Skill

Agent skill for Alexandra Institute's internal Confluence at `confluence.alexandra.dk` (Confluence Server 7.19.17). **Requires Alexandra VPN.**

## Files

- **SKILL.md** — Full reference: nested commands by resource, CQL syntax, key spaces, "The Alexandra Way" project template.
- **alexandra_confluence.py** — Python CLI helper. Standard library only. Reads `CONFLUENCE_USER` / `CONFLUENCE_PASS` env vars or prompts via `getpass`; session cookies cached in `~/.alexandra-confluence/cookies.txt`.

## Quick start

```bash
export CONFLUENCE_USER=your.username
export CONFLUENCE_PASS='your-password'   # single-quote if it has & @ / # etc.

python3 alexandra_confluence.py spaces list
python3 alexandra_confluence.py pages search "Alexandra Way"
python3 alexandra_confluence.py pages get --key PAGE_KEY
python3 alexandra_confluence.py projects create --title "My Project" --client "Client" --owner "Owner"
```

## Commands by resource

| Resource | Commands |
|---|---|
| **Spaces** | `spaces list [--limit N] [--start N]` |
| **Pages** | `pages list --space-key K [--limit N]`, `pages search "q" [--limit N]`, `pages search --cql '...' [--limit N]`, `pages get --key K | --id N [--body-format auto|text|html]`, `pages create --space-key K --title T --body B [--parent ID]`, `pages update --id N --body B [--title T] [--minor-edit]` |
| **Projects** | `projects create --title T --client C --owner O [--budget B] [--space-key K]` |
| **Slides** | `slides add --category CAT --title T [--date D] [--owner-key K] [--language L] [--slides F] [--note N]` |
| **Auth** | `whoami`, `auth` |

Every command supports `--raw` for unformatted JSON output.

## Destructive operations

`delete` and `move` are intentionally omitted. Open the page URL in a browser to delete or rearrange pages via the Confluence UI.

## Troubleshooting

- **Connection / DNS errors** — VPN not connected.
- **Login failed** — wrong credentials; delete `~/.alexandra-confluence/cookies.txt` and retry.
- **HTTP 302** — session expired; the script re-authenticates automatically, or run `auth` to force it.
