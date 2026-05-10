# alexandra-confluence Skill

Agent skill for Alexandra Institute's internal Confluence at `confluence.alexandra.dk` (Confluence Server 7.19.17). **Requires Alexandra VPN.**

## Files

- **SKILL.md** — Full reference: CRUD commands by resource, CQL syntax, key spaces, "The Alexandra Way" project template.
- **alexandra_confluence.py** — Python CLI helper. Standard library only. Reads `CONFLUENCE_USER` / `CONFLUENCE_PASS` from env vars, a `.env` file, or prompts via `getpass`; session cookies cached in `~/.alexandra-confluence/cookies.txt`. Proactive auth when env vars are set.

## Quick start

Set credentials via a `.env` file in the working directory, or export env vars:

```bash
export CONFLUENCE_USER=your.username
export CONFLUENCE_PASS='your-password'   # single-quote if it has & @ / # etc.
```

```bash
python3 alexandra_confluence.py spaces list
python3 alexandra_confluence.py spaces search "AI"
python3 alexandra_confluence.py pages search "Alexandra Way"
python3 alexandra_confluence.py pages read --key PAGE_KEY
python3 alexandra_confluence.py projects create --title "My Project" --client "Client" --owner "Owner"
```

## Commands by resource

Every resource supports `list`, `read`, `create`, `update`. Some also have `search` and `list-all` as convenience helpers.

| Resource | Commands |
|---|---|
| **Spaces** | `spaces list [--limit N] [--start N]`, `spaces read --key K`, `spaces search "q" [--limit N]`, `spaces create --key K --name N [--description TEXT]`, `spaces update --key K [--name N] [--description TEXT]` |
| **Pages** | `pages list --space-key K [--limit N]`, `pages search "q" [--limit N]`, `pages read --key K \| --id N [--body-format auto\|text\|html]`, `pages create --space-key K --title T --body B [--parent ID]`, `pages update --id N --body B [--title T] [--minor-edit]` |
| **Projects** | `projects list --space-key K [--limit N]`, `projects read --key K \| --id N [--body-format auto\|text\|html]`, `projects create --title T --client C --owner O [--budget B] [--space-key K]`, `projects update --id N --body B [--title T] [--minor-edit]` |
| **AI Lab Slides** | `ai-lab-slides list --category CAT`, `ai-lab-slides list-all`, `ai-lab-slides read --category CAT --index N`, `ai-lab-slides search "q"` / `--cql 'CQL'`, `ai-lab-slides create --category CAT --title T [--date D] [--owner-key K] [--language L] [--slides F] [--note N]`, `ai-lab-slides update --category CAT --index N [--title T] [--date D] [--owner-key K] [--language L] [--slides F] [--note N]` |
| **Auth** | `whoami`, `auth` |

Every command supports `--raw` for unformatted JSON output.

### Finding and reading slides

Slides live in a single Confluence page (id `97042311`) organized into tables by category. The `read` command uses `--category` and `--index` rather than a Confluence page ID.

To find and read a specific slide:

1. **Browse all slides:** `ai-lab-slides list-all` — shows every slide grouped by category, with `[category:INDEX]` tags.
2. **Browse one category:** `ai-lab-slides list --category nlp` — shows slides in a single category.
3. **Search across all categories:** `ai-lab-slides search "deep learning"` — text-searches title, owner, date, language, and slides fields.
4. **Read a specific slide:** Use the category and index from the output, e.g. `ai-lab-slides read --category nlp --index 3`.

Each slide row has columns: Date, Owner, Title, Language, Slides (attachment). Use `--raw` for JSON output that includes a `_category` field for scripting.

## Common spaces

Some frequently used spaces:

| Key | Name |
|---|---|
| **PROJ** | The Alexandra Way (methodology + all active projects) |
| EHBK | Personalehåndbog (employee handbook) |
| AILAB | AI Lab |
| DXS | Digital Experience and Solutions Lab |
| PTB | Insights Lab |
| GDPR | Alexandra GDPR |
| IT | IT |
| CorporateComm | Alexandra corporate communication |
| ACC | Accounting Space |

Note: Security Lab does not have a dedicated Confluence space. Other spaces exist for ad-hoc projects and smaller teams. Use `spaces search "keyword"` to find additional spaces.

## .env file

Place a `.env` file in the working directory with:
```
CONFLUENCE_USER=your.username
CONFLUENCE_PASS='your-password'
```

Simple `KEY=VALUE` format. Blank lines and `#` comments are ignored. Surrounding quotes on values are stripped.

## Destructive operations

`delete` and `move` are intentionally omitted from the CLI. Open the page URL in a browser to delete or rearrange pages via the Confluence UI.

## Troubleshooting

- **Connection / DNS errors** — VPN not connected.
- **Login failed** — wrong credentials; delete `~/.alexandra-confluence/cookies.txt` and retry.
- **HTTP 302** — session expired; the script re-authenticates automatically, or run `auth` to force it.
