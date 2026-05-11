# alexandra-confluence Skill

Agent skill for Alexandra Institute's internal Confluence at `confluence.alexandra.dk` (Confluence Server 7.19.17). **Requires Alexandra VPN.**

## Installation

Install the CLI in editable mode from this directory:

```bash
pip install -e .
```

Or install normally:

```bash
pip install .
```

This provides the `alex-confluence` command globally.

## Files

- **SKILL.md** — Full reference: CRUD commands by resource, CQL syntax, key spaces, "The Alexandra Way" project template.
- **scripts/main.py** — Entry point. Loads `.env`, parses args, dispatches.
- **scripts/http.py** — HTTP helpers with retry logic.
- **scripts/auth.py** — Authentication, cookie management, credential loading.
- **scripts/cli_parser.py** — CLI argument parser builder.
- **scripts/cli_dispatch.py** — Command dispatch table.
- **scripts/utils/parsing.py** — HTML/table parsing helpers.
- **scripts/utils/pages.py** — Page ID resolution, heading/category mapping.
- **scripts/resources/** — Resource handlers (spaces, pages, projects, slides).

## Quick start

Set credentials via a `.env` file in the working directory, or export env vars:

```bash
export CONFLUENCE_USER=your.username
export CONFLUENCE_PASS='your-password'   # single-quote if it has & @ / # etc.
```

```bash
alex-confluence spaces list
alex-confluence spaces search "AI"
alex-confluence pages search "Alexandra Way"
alex-confluence pages read --key PAGE_KEY
alex-confluence projects create --title "My Project" --client "Client" --owner "Owner"
```

## Commands by resource

Every resource supports `size`, `list`, `read`, `create`, `update`. Some also have `search` as a convenience helper.

| Resource | Commands |
|---|---|
| **Spaces** | `spaces size`, `spaces list [--limit N] [--start N]`, `spaces read --key K`, `spaces search "q" [--limit N]`, `spaces create --key K --name N [--description TEXT]`, `spaces update --key K [--name N] [--description TEXT]` |
| **Pages** | `pages size`, `pages list --space-key K [--limit N]`, `pages search "q" [--limit N]`, `pages read --key K \| --id N [--body-format auto\|text\|html]`, `pages create --space-key K --title T --body B [--parent ID]`, `pages update --id N --body B [--title T] [--minor-edit]` |
| **Projects** | `projects size`, `projects list --space-key K [--limit N]`, `projects read --key K \| --id N [--body-format auto\|text\|html]`, `projects create --title T --client C --owner O [--budget B] [--space-key K]`, `projects update --id N --body B [--title T] [--minor-edit]` |
| **AI Lab Slides** | `ai-lab-slides size`, `ai-lab-slides list` (all slides), `ai-lab-slides read --id CAT:INDEX`, `ai-lab-slides search "q"` / `--cql 'CQL'`, `ai-lab-slides create --category CAT --title T [--date D] [--owner-key K] [--language L] [--slides F] [--note N]`, `ai-lab-slides update --category CAT --index N [--title T] [--date D] [--owner-key K] [--language L] [--slides F] [--note N]` |
| **Auth** | `whoami`, `auth` |

Every command supports `--raw` for unformatted JSON output.

### Finding and reading slides

Slides live in a single Confluence page (id `97042311`) organized into tables by category. Every slide has a unique ID in `category:index` format (e.g., `nlp:3`, `client:0`).

**Available categories:** `about-us`, `themed`, `themed-general`, `nlp`, `energy`, `healthcare`, `iot`, `client`, `courses`, `presentations`, `legacy`.

Note: The `presentations` category heading has a typo ("Presentions") on the Confluence page. The `themed` h1 heading is a parent section — actual slides are in the h2 subcategories (`themed-general`, `nlp`, `energy`, `healthcare`, `iot`).

To find and read a specific slide:

1. **List all slides:** `alex-confluence ai-lab-slides list` — shows every slide with its unique `[cat:index]` ID.
2. **Search:** `alex-confluence ai-lab-slides search "deep learning"` — finds matching slides across all categories.
3. **Read a specific slide:** `alex-confluence ai-lab-slides read --id nlp:3` — uses the unique ID from the list/search output. You can also use `--category nlp --index 3` as an alternative.

Use `--raw` for JSON output that includes a `_id` field for scripting.

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

Note: Security Lab does not have a dedicated Confluence space. Other spaces exist for ad-hoc projects and smaller teams. Use `alex-confluence spaces search "keyword"` to find additional spaces.

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
- **HTTP 302** — session expired; the CLI re-authenticates automatically, or run `alex-confluence auth` to force it.
