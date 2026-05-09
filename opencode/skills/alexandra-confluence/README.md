# alexandra-confluence Skill

Agent skill for Alexandra Institute's internal Confluence at `confluence.alexandra.dk` (Confluence Server 7.19.17). **Requires Alexandra VPN.**

## Files

- **SKILL.md** — Full reference: commands, CQL syntax, key spaces, "The Alexandra Way" project template.
- **alexandra_confluence.py** — Python CLI helper. Standard library only. Reads `CONFLUENCE_USER` / `CONFLUENCE_PASS` env vars or prompts via `getpass`; session cookies cached in `~/.alexandra-confluence/cookies.txt`.

## Quick start

```bash
export CONFLUENCE_USER=your.username
export CONFLUENCE_PASS='your-password'   # single-quote if it has & @ / # etc.

python3 alexandra_confluence.py spaces
python3 alexandra_confluence.py search "Alexandra Way"
python3 alexandra_confluence.py page --key PAGE_KEY
python3 alexandra_confluence.py create-project --title "My Project" --client "Client" --owner "Owner"
```

## Troubleshooting

- **Connection / DNS errors** — VPN not connected.
- **Login failed** — wrong credentials; delete `~/.alexandra-confluence/cookies.txt` and retry.
- **HTTP 302** — session expired; the script re-authenticates automatically, or run `auth` to force it.
