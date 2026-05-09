---
name: alexandra-confluence
description: Alexandra's internal Confluence instance at confluence.alexandra.dk - Atlassian Confluence 7.19.17 with ~600 spaces and ~14,684 pages. Requires Alexandra VPN and user credentials. Covers browsing spaces, searching pages via CQL, fetching page content, creating new project pages (which auto-fills "The Alexandra Way" project template), and managing page hierarchies. All interaction is through the CLI helper script alexandra_confluence.py which handles authentication seamlessly. Use when the user wants to search Confluence, read project documentation, create a new project page, browse "The Alexandra Way" methodology, or interact with any Confluence space.
last-updated: 2026-05-08
---

# alexandra-confluence - Confluence CLI skill

Access to Alexandra's internal Confluence instance at `https://confluence.alexandra.dk/`. Runs **Atlassian Confluence 7.19.17** (Server edition). Requires **Alexandra VPN** and **user credentials** to authenticate.

**Requires VPN.** If the VPN is not connected, all requests will fail with connection errors or DNS resolution failures.

## The Helper Script

All interaction with Confluence goes through `alexandra_confluence.py` in this skill folder. It handles authentication, cookie management, session expiry, and all REST API calls. The script is standard-library-only — no pip install needed.

### Authentication

Credentials are read securely from environment variables or interactively prompted via `getpass` (which hides input on terminal). Credentials are **never stored on disk** — only session cookies are persisted.

| Variable | Purpose |
|---|---|
| `CONFLUENCE_USER` | Alexandra username |
| `CONFLUENCE_PASS` | Alexandra password |

If either is unset, the script prompts interactively. Session cookies are stored in `~/.alexandra-confluence/cookies.txt` for reuse. The script detects expired sessions automatically (302 redirects to login) and silently re-authenticates — the user is prompted at most once per session.

### Usage

```bash
# List all spaces
python3 alexandra_confluence.py spaces [--limit 50] [--start 0]

# List pages in a space
python3 alexandra_confluence.py pages --space-key PROJ [--limit 20]

# Search across all spaces (simple query)
python3 alexandra_confluence.py search "Alexandra Way" [--limit 10]

# Search with full CQL
python3 alexandra_confluence.py search --cql "space=PROJ AND type=page AND created > '2025-01-01'" [--limit 20]

# Get a page by key or ID
python3 alexandra_confluence.py page --key PAGE_KEY
python3 alexandra_confluence.py page --id 208044217

# Get page body as plain text
python3 alexandra_confluence.py page --key PAGE_KEY --format text

# Get page body as HTML
python3 alexandra_confluence.py page --key PAGE_KEY --format html

# Create a generic new page
python3 alexandra_confluence.py create --space-key PROJ --title "My Page" --body "<p>Content</p>" [--ancestor-id 208044217]

# Create a new project page (auto-fills The Alexandra Way template)
python3 alexandra_confluence.py create-project --title "My Project" --client "Client Name" --owner "Project Owner" [--budget "1000000"]

# Update an existing page
python3 alexandra_confluence.py update --id PAGE_ID --body "<p>New content</p>" [--title "New Title"]

# Delete a page
python3 alexandra_confluence.py delete --id PAGE_ID

# Show current user
python3 alexandra_confluence.py whoami

# Force re-authentication
python3 alexandra_confluence.py auth
```

Pass `--raw` to any subcommand to skip the human-readable formatter and print the exact JSON response. Errors (HTTP 4xx/5xx, JSON parse failure) go to stderr and exit non-zero.

### CQL Query Syntax

The `search` subcommand accepts either a simple query string (converted to a title search) or a full CQL query via `--cql`.

| CQL | Meaning | Example |
|---|---|---|
| `space=KEY` | Pages in a specific space | `space=PROJ` |
| `title="Exact Title"` | Exact title match | `title="Om The Alexandra Way"` |
| `title~"partial"` | Title contains substring | `title~"projekt"` |
| `text~"phrase"` | Body text contains phrase | `text~"Alexandra Way"` |
| `type=page` | Only pages (not attachments) | `type=page AND space=PROJ` |
| `author=username` | Created by user | `author="username"` |
| `created > "YYYY-MM-DD"` | Date filtering | `created > "2025-01-01" AND space=PROJ` |
| `AND` / `OR` | Boolean logic | `space=PROJ AND type=page` |
| `~` | Contains / fuzzy match | `text~"Alexandra Way"` |
| `=` | Exact match | `title="Om The Alexandra Way"` |

## Key Spaces

The instance has **~600 spaces** and **~14,684 pages**. The most important ones:

| Key | Name | Description |
|---|---|---|
| **PROJ** | The Alexandra Way | Core project methodology space. Contains "The Alexandra Way" docs, project overview, and all active project pages. |
| EHBK | Employee Handbook / Personalehåndbog | Personnel handbook, references The Alexandra Way methodology. |
| AIDK | AI Denmark | AI Denmark project space. |
| DXS | Digitaliseringsstyrelsen | Digitaliseringsstyrelsen project space. |
| PTB | Project Management | Project management space. |
| SUPPORT | Alexandra Support Knowledge Base | Support KB. |
| GDPR | Alexandra GDPR | GDPR documentation. |
| AOSS | Alexandra Open Source | Open source project space. |
| ATP | Alexandra Tech Platform | Tech platform space. |
| CorporateComm | Alexandra corporate communication | Corporate comms. |
| ~user.name | Personal spaces | ~40 personal spaces (keys start with `~`). |

## "The Alexandra Way" — PROJ Space Structure

The PROJ space is the heart of the Confluence instance. It contains "The Alexandra Way" — a project methodology framework built on three core competencies:

1. **Hybrid project management** — continuous expectation alignment and value creation
2. **Agile software development** — keeping customer needs at the center
3. **User-driven innovation** — user-centered process

### PROJ Space Pages

| Page Title | Description |
|---|---|
| Projektoverblik (The Alexandra Way) | Hub page with project overview table. Parent of all active project pages (page ID `208044217`). |
| Om The Alexandra Way | Main documentation explaining the methodology. |
| The Alexandra Way - Initiering | Initiation phase — diagram showing the initiation process. |
| The Alexandra Way - Eksekvering | Execution phase — diagram of the execution process. |
| The Alexandra Way - Afslutning | Closing phase — diagram of the closing process. |
| TAW ressourcer | Resources page — aggregates templates and illustrations. |
| Projektordbog | Project glossary — defines Sprint, Kunde, Projektejer, MVP, PoC, Pulstjek. |

### Project Page Template ("Projektforklæde")

Each project page in PROJ follows a standardized template with sections:
- **Projektbeskrivelse** — project description
- **Tjeklister** — checklists for initiering, eksekvering, afslutning
- **Administrative opgaver** — administrative tasks
- **Projektledelsesopgaver** — project management tasks
- **Softwareudviklingsopgaver** — software development tasks
- **Project info table** — Status, Projektansvarlig/-leder, Intern Projektejer, Budget, Projekttype, Projektslut, Projektkode, Skabelon Version

Projects are child pages of "Projektoverblik (The Alexandra Way)" (page ID `208044217`). Use `create-project` to create one with the template pre-filled.

## Body Formats

Confluence pages have multiple body representations. The script always uses `storage` format for reading and writing:

| Representation | Description |
|---|---|
| `storage` | Native Confluence Storage Format (ASF XML). Contains `<ac:structured-macro>`, `<ac:link>`, `<ri:page>`, `<p>`, `<h2>`, `<table>`, etc. This is what the script uses. |
| `view` | Formatted for display (HTML). Includes `@@@hl@@@...@@@endhl@@@` markers for search highlights. |
| `editor` | Editor-specific format. |

The `--format` flag on the `page` subcommand controls output: `auto` (default) shows a plain-text preview, `text` shows the full stripped body, `html` shows the raw storage XML.

## Pagination

Most list endpoints support:
- `limit` — max items per page (default ~25, max ~100)
- `start` — offset (0-based)
- Response includes `start`, `limit`, `size` (total count)

## Etiquette

- Throttle: stay under ~1 req/s for polite usage
- The script handles session expiry and re-authentication transparently
- Cookies are stored in `~/.alexandra-confluence/cookies.txt` — delete this file to force re-authentication
