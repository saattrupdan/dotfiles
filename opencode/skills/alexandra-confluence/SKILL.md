---
name: alexandra-confluence
description: CLI access to Alexandra's internal Confluence (confluence.alexandra.dk). Requires VPN + credentials. Covers space/page browsing, CQL search, and page CRUD. Use when the user wants to search, read, or write Confluence content.
last-updated: 2026-05-10
---

# alexandra-confluence

Internal Confluence at `https://confluence.alexandra.dk/`. **Requires VPN** — without it, all requests fail with DNS or connection errors.

All interaction goes through `alexandra_confluence.py` (stdlib only). Credentials come from `CONFLUENCE_USER` / `CONFLUENCE_PASS` — either as env vars, in a `.env` file (simple `KEY=VALUE` format, loaded automatically), or via interactive prompts. When env vars are set, authentication is proactive (no anonymous first request). Only session cookies are persisted (in `~/.alexandra-confluence/cookies.txt`). Expired sessions (302 to login) are detected and re-authenticated automatically.

## Commands

Commands follow a standardized **CRUD** pattern across all resource groups: `list`, `read`, `create`, `update`. Some resources also have `search` as a convenience helper. Every leaf command supports `--raw` to print unformatted JSON. Errors go to stderr with non-zero exit.

### Spaces

```bash
python3 alexandra_confluence.py spaces list [--limit 1000] [--start 0]
python3 alexandra_confluence.py spaces read --key KEY
python3 alexandra_confluence.py spaces search QUERY [--limit 20]
python3 alexandra_confluence.py spaces search --cql 'type=space AND title~"foo"' [--limit 20]
python3 alexandra_confluence.py spaces create --key K --name N [--description TEXT]
python3 alexandra_confluence.py spaces update --key K [--name N] [--description TEXT]
```

`spaces search` uses the Confluence CQL search API. `QUERY` is shorthand for title search. Use `--cql` for full CQL queries (e.g., `description~"AI"`).

### Pages

```bash
python3 alexandra_confluence.py pages list --space-key PROJ [--limit 20]
python3 alexandra_confluence.py pages search "Alexandra Way" [--limit 10]
python3 alexandra_confluence.py pages search --cql 'space=PROJ AND type=page' [--limit 20]
python3 alexandra_confluence.py pages read --key PAGE_KEY [--body-format auto|text|html]
python3 alexandra_confluence.py pages read --id PAGE_ID [--body-format auto|text|html]
python3 alexandra_confluence.py pages create --space-key PROJ --title T --body "<p>…</p>" [--parent ID]
python3 alexandra_confluence.py pages update --id ID --body "<p>…</p>" [--title T] [--minor-edit]
```

`pages search` is a convenience helper for searching across spaces. Use `--cql` for full CQL queries.

### Projects

```bash
python3 alexandra_confluence.py projects list --space-key PROJ [--limit 20]
python3 alexandra_confluence.py projects read --key PAGE_KEY [--body-format auto|text|html]
python3 alexandra_confluence.py projects read --id PAGE_ID [--body-format auto|text|html]
python3 alexandra_confluence.py projects create --title T --client C --owner O [--budget B] [--space-key PROJ]
python3 alexandra_confluence.py projects update --id ID --body "<p>…</p>" [--title T] [--minor-edit]
```

Projects use the same `pages read`/`update` implementation under the hood, but `projects create` fills the standard "Projektforklæde" template.

### AI Lab Slides

```bash
python3 alexandra_confluence.py ai-lab-slides list
python3 alexandra_confluence.py ai-lab-slides read --id CAT:INDEX
python3 alexandra_confluence.py ai-lab-slides search "keyword"
python3 alexandra_confluence.py ai-lab-slides search --cql 'title~"something"'
python3 alexandra_confluence.py ai-lab-slides create --category CAT --title T [--date YYYY-MM-DD] [--owner-key KEY] [--language LANG] [--slides FILE] [--note TEXT]
python3 alexandra_confluence.py ai-lab-slides update --category CAT --index N [--title T] [--date D] [--owner-key K] [--language L] [--slides F] [--note N]
```

Categories: `about-us`, `themed`, `client`, `courses`, `presentations`, `nlp`, `energy`, `healthcare`, `iot`.

**Unique slide IDs and reading slides:**

All slides live in one Confluence page (id `97042311`) organized into tables by category. Every slide has a unique ID in `category:index` format (e.g., `nlp:3`, `client:0`). The `list` and `search` commands return these IDs.

To read a specific slide:

1. Run `ai-lab-slides list` to see all slides with their IDs, or `ai-lab-slides search "keyword"` to find matching ones.
2. Copy the ID from the output, e.g. `[nlp:3]`.
3. Read it: `ai-lab-slides read --id nlp:3`.

You can also use `--category` + `--index` instead of `--id`: `ai-lab-slides read --category nlp --index 3`.

When using `--raw`, the output includes a `_id` field you can use in subsequent commands.

### Authentication

```bash
python3 alexandra_confluence.py whoami
python3 alexandra_confluence.py auth   # force re-auth
```

## Page bodies

Page bodies use **Confluence Storage Format** (XML with `<ac:…>` macros) — pass HTML-ish XML to `--body` on `create`/`update`. The `read` command supports `--body-format auto|text|html` to control body display.

## CQL search

`pages search QUERY` is shorthand for `title~"QUERY"`. Full CQL via `--cql`:

- `space=PROJ AND type=page` — pages in a space
- `text~"Alexandra Way"` — body text contains phrase
- `created > "2025-01-01"` — date filter
- `title~"projekt"` — partial title match

## Key spaces

~721 spaces, ~14,684 pages. Here are some commonly used spaces:

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

Note: Security Lab does not have a dedicated Confluence space. Other spaces exist for ad-hoc projects and smaller teams. To find a specific space, use `spaces search "keyword"` or `spaces list` to browse all of them.

To list all spaces (default limit 1000 covers all 721 spaces):
```bash
python3 alexandra_confluence.py spaces list
```

For pagination, use `--start` (offset) and `--limit` (page size).

## .env file

Place a `.env` file in the working directory with:
```
CONFLUENCE_USER=your_username
CONFLUENCE_PASS=your_password
```

Simple `KEY=VALUE` format. Blank lines and `#` comments are ignored. Surrounding quotes on values are stripped.

## "The Alexandra Way" — PROJ space

PROJ is the heart of Confluence. It houses **The Alexandra Way** methodology (hybrid project management, agile development, user-driven innovation), core docs (`Om The Alexandra Way`, `Projektordbog`), and all active project pages.

All project pages are children of **`Projektoverblik (The Alexandra Way)`** (page id `208044217`). Use `projects create` to create a new one — it auto-fills the standard "Projektforklæde" template with sections for Projektinfo (status, owner, budget, kode), Beskrivelse, Tjeklister, Administrative/Migrations-/Udviklingsopgaver, and Milestones. Defaults: `--space-key PROJ`, ancestor `208044217`, status "Under initiering".

## No destructive operations

The CLI intentionally omits `delete` and `move` commands. To delete a page, open its URL in a browser and delete it manually. To move a page, edit its location via the Confluence UI.

## Etiquette

Stay under ~1 req/s. Delete `~/.alexandra-confluence/cookies.txt` to force re-authentication.
