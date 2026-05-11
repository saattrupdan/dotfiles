---
name: alexandra-confluence
description: CLI access to Alexandra's internal Confluence (confluence.alexandra.dk). Requires VPN + credentials. Covers space/page browsing, CQL search, and page CRUD. Use when the user wants to search, read, or write Confluence content.
last-updated: 2026-05-11
---

# alexandra-confluence

Internal Confluence at `https://confluence.alexandra.dk/`. **Requires VPN** — without it, all requests fail with DNS or connection errors.

**Agent note:** Always try the `alex-confluence` command first. If it is not found (`command not found`), install it automatically by running `pipx install -e <skill_directory>` (editable install from the skill's own directory). For instance, `pipx install -e ~/.opencode/skills/alexandra-confluence` if OpenCode is used. After installation, retry the original command.

All interaction goes through the `alex-confluence` command. Credentials come from `CONFLUENCE_USER` / `CONFLUENCE_PASS` — either as env vars, in a `.env` file (simple `KEY=VALUE` format, loaded automatically), or via interactive prompts. When env vars are set, authentication is proactive (no anonymous first request). Only session cookies are persisted (in `~/.alexandra-confluence/cookies.txt`). Expired sessions (302 to login) are detected and re-authenticated automatically.

## Commands

Commands follow a standardized **CRUD+S** pattern across all resource groups: `size` returns a single number, `list` enumerates items, `read` fetches one item, `create` adds a new item, `update` modifies an existing one. Some resources also have `search` as a convenience helper. Every leaf command supports `--raw` to print unformatted JSON. Errors go to stderr with non-zero exit.

### Spaces

```bash
alex-confluence spaces size
alex-confluence spaces list [--limit 100] [--start 0]
alex-confluence spaces read --key KEY
alex-confluence spaces search QUERY [--limit 20]
alex-confluence spaces search --cql 'type=space AND title~"foo"' [--limit 20]
alex-confluence spaces create --key K --name N [--description TEXT]
alex-confluence spaces update --key K [--name N] [--description TEXT]
```

`spaces size` prints the total number of spaces as a single integer.

`spaces search` uses the Confluence CQL search API. `QUERY` is shorthand for title search. Use `--cql` for full CQL queries (e.g., `description~"AI"`).

All `--limit` flags cap the **desired** number of results per call, but the Confluence API enforces a hard maximum of 100 per page. The CLI handles pagination automatically: when the desired limit exceeds 100, it makes multiple API calls (with `limit=100`) until all results are fetched. You can manually paginate with `--start` + `--limit` for fine-grained control.

The `spaces list` default of `--limit 100` returns the first 100 spaces. To list all ~721 spaces, use `--limit 1000` (the CLI will paginate internally with multiple `limit=100` API calls).

### Pages

```bash
alex-confluence pages size
alex-confluence pages list --space-key PROJ [--limit 20]
alex-confluence pages search "Alexandra Way" [--limit 10]
alex-confluence pages search --cql 'space=PROJ AND type=page' [--limit 20]
alex-confluence pages read --key PAGE_KEY [--body-format auto|text|html]
alex-confluence pages read --id PAGE_ID [--body-format auto|text|html]
alex-confluence pages create --space-key PROJ --title T --body "<p>…</p>" [--parent ID]
alex-confluence pages update --id ID --body "<p>…</p>" [--title T] [--minor-edit]
```

`pages size` prints the total number of pages across all spaces as a single integer.

`pages search` is a convenience helper for searching across spaces. Use `--cql` for full CQL queries.

### Projects

```bash
alex-confluence projects size
alex-confluence projects list --space-key PROJ [--limit 20]
alex-confluence projects read --key PAGE_KEY [--body-format auto|text|html]
alex-confluence projects read --id PAGE_ID [--body-format auto|text|html]
alex-confluence projects create --title T --client C --owner O [--budget B] [--space-key PROJ]
alex-confluence projects update --id ID --body "<p>…</p>" [--title T] [--minor-edit]
```

`projects size` prints the total number of project pages (children of "Projektoverblik") as a single integer.

Projects use the same `pages read`/`update` implementation under the hood, but `projects create` fills the standard "Projektforklæde" template.

### AI Lab Slides

```bash
alex-confluence ai-lab-slides size
alex-confluence ai-lab-slides list
alex-confluence ai-lab-slides read --id CAT:INDEX
alex-confluence ai-lab-slides search "keyword"
alex-confluence ai-lab-slides search --cql 'title~"something"'
alex-confluence ai-lab-slides create --category CAT --title T [--date YYYY-MM-DD] [--owner-key KEY] [--language LANG] [--slides FILE] [--note TEXT]
alex-confluence ai-lab-slides update --category CAT --index N [--title T] [--date D] [--owner-key K] [--language L] [--slides F] [--note N]
```

`ai-lab-slides size` prints the total number of slide entries as a single integer.

**Available categories:**

| Category key | Confluence heading |
|---|---|
| `about-us` | 1. About Us presentations |
| `themed` | 2. Themed presentation (h1 parent — no slides directly) |
| `themed-general` | 2.1. General presentation about AI / AI potential checks |
| `nlp` | 2.2. NLP |
| `energy` | 2.3. Energy, Utilities & Construction |
| `healthcare` | 2.4. Healthcare |
| `iot` | 2.5. IoT / Anomaly detections |
| `client` | 3. Client Presentations |
| `courses` | 4. Courses / workshops |
| `presentations` | 5. Presentions ("oplæg") |
| `legacy` | 6. Legacy presentation Links |

Note: The `presentations` heading has a typo ("Presentions" instead of "Presentations") on the Confluence page.

**Unique slide IDs and reading slides:**

All slides live in one Confluence page (id `97042311`) organized into tables by category. Every slide has a unique ID in `category:index` format (e.g., `nlp:3`, `client:0`). The `list` and `search` commands return these IDs.

To read a specific slide:

1. Run `alex-confluence ai-lab-slides list` to see all slides with their IDs, or `alex-confluence ai-lab-slides search "keyword"` to find matching ones.
2. Copy the ID from the output, e.g. `[nlp:3]`.
3. Read it: `alex-confluence ai-lab-slides read --id nlp:3`.

You can also use `--category` + `--index` instead of `--id`: `alex-confluence ai-lab-slides read --category nlp --index 3`.

When using `--raw`, the output includes a `_id` field you can use in subsequent commands.

### Authentication

```bash
alex-confluence whoami
alex-confluence auth   # force re-auth
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

Note: Security Lab does not have a dedicated Confluence space. Other spaces exist for ad-hoc projects and smaller teams. To find a specific space, use `alex-confluence spaces search "keyword"` or `alex-confluence spaces list` to browse all of them.

To list all spaces (~721), use `--limit 1000` — the CLI paginates internally (the Confluence API caps each page at 100):
```bash
alex-confluence spaces list --limit 1000
```

For manual pagination, combine `--start` (offset) with `--limit` (page size).

## .env file

Place a `.env` file in the working directory with:
```
CONFLUENCE_USER=your_username
CONFLUENCE_PASS=your_password
```

Simple `KEY=VALUE` format. Blank lines and `#` comments are ignored. Surrounding quotes on values are stripped.

## "The Alexandra Way" — PROJ space

PROJ is the heart of Confluence. It houses **The Alexandra Way** methodology (hybrid project management, agile development, user-driven innovation), core docs (`Om The Alexandra Way`, `Projektordbog`), and all active project pages.

All project pages are children of **`Projektoverblik (The Alexandra Way)`** (page id `208044217`). Use `alex-confluence projects create` to create a new one — it auto-fills the standard "Projektforklæde" template with sections for Projektinfo (status, owner, budget, kode), Beskrivelse, Tjeklister, Administrative/Migrations-/Udviklingsopgaver, and Milestones. Defaults: `--space-key PROJ`, ancestor `208044217`, status "Under initiering".

## No destructive operations

The CLI intentionally omits `delete` and `move` commands. To delete a page, open its URL in a browser and delete it manually. To move a page, edit its location via the Confluence UI.

## Etiquette

Stay under ~1 req/s. Delete `~/.alexandra-confluence/cookies.txt` to force re-authentication.
