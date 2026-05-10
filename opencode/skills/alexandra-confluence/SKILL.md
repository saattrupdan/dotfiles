---
name: alexandra-confluence
description: CLI access to Alexandra's internal Confluence (confluence.alexandra.dk). Requires VPN + credentials. Covers space/page browsing, CQL search, and page CRUD. Use when the user wants to search, read, or write Confluence content.
last-updated: 2026-05-10
---

# alexandra-confluence

Internal Confluence at `https://confluence.alexandra.dk/`. **Requires VPN** — without it, all requests fail with DNS or connection errors.

All interaction goes through `alexandra_confluence.py` (stdlib only). Credentials come from `CONFLUENCE_USER` / `CONFLUENCE_PASS` env vars or interactive `getpass` prompt; only session cookies are persisted (in `~/.alexandra-confluence/cookies.txt`). Expired sessions (302 to login) are detected and re-authenticated automatically.

## Commands

Commands are organized by resource. Every leaf command supports `--raw` to print unformatted JSON. Errors go to stderr with non-zero exit.

### Spaces

```bash
python3 alexandra_confluence.py spaces list [--limit 100] [--start 0]
```

### Pages

```bash
python3 alexandra_confluence.py pages list --space-key PROJ [--limit 20]
python3 alexandra_confluence.py pages search "Alexandra Way" [--limit 10]
python3 alexandra_confluence.py pages search --cql 'space=PROJ AND type=page' [--limit 20]
python3 alexandra_confluence.py pages get --key PAGE_KEY [--body-format auto|text|html]
python3 alexandra_confluence.py pages get --id 208044217 [--body-format auto|text|html]
python3 alexandra_confluence.py pages create --space-key PROJ --title T --body "<p>…</p>" [--parent ID]
python3 alexandra_confluence.py pages update --id ID --body "<p>…</p>" [--title T] [--minor-edit]
```

### Projects

```bash
python3 alexandra_confluence.py projects create --title T --client C --owner O [--budget B] [--space-key PROJ]
```

### Slides

```bash
python3 alexandra_confluence.py slides add --category CAT --title T [--date YYYY-MM-DD] [--owner-key KEY] [--language LANG] [--slides FILE] [--note TEXT]
```

Categories: `about-us`, `themed`, `client`, `courses`, `presentions`, `nlp`, `energy`, `healthcare`, `iot`.

### Authentication

```bash
python3 alexandra_confluence.py whoami
python3 alexandra_confluence.py auth   # force re-auth
```

## Page bodies

Page bodies use **Confluence Storage Format** (XML with `<ac:…>` macros) — pass HTML-ish XML to `--body` on `create`/`update`. The `pages get` command supports `--body-format auto|text|html` to control body display.

## CQL search

Plain `pages search QUERY` is shorthand for `title~"QUERY"`. Full CQL via `--cql`:

- `space=PROJ AND type=page` — pages in a space
- `text~"Alexandra Way"` — body text contains phrase
- `created > "2025-01-01"` — date filter
- `title~"projekt"` — partial title match

## Key spaces

~600 spaces, ~14,684 pages. Notable keys:

| Key | Name |
|---|---|
| **PROJ** | The Alexandra Way (methodology + all active projects) |
| EHBK | Employee handbook |
| AIDK | AI Denmark |
| DXS | Digitaliseringsstyrelsen |
| SUPPORT | Support knowledge base |

## "The Alexandra Way" — PROJ space

PROJ is the heart of Confluence. It houses **The Alexandra Way** methodology (hybrid project management, agile development, user-driven innovation), core docs (`Om The Alexandra Way`, `Projektordbog`), and all active project pages.

All project pages are children of **`Projektoverblik (The Alexandra Way)`** (page id `208044217`). Use `projects create` to create a new one — it auto-fills the standard "Projektforklæde" template with sections for Projektinfo (status, owner, budget, kode), Beskrivelse, Tjeklister, Administrative/Migrations-/Udviklingsopgaver, and Milestones. Defaults: `--space-key PROJ`, ancestor `208044217`, status "Under initiering".

## No destructive operations

The CLI intentionally omits `delete` and `move` commands. To delete a page, open its URL in a browser and delete it manually. To move a page, edit its location via the Confluence UI.

## Etiquette

Stay under ~1 req/s. Delete `~/.alexandra-confluence/cookies.txt` to force re-authentication.
