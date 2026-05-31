---
name: kultunaut-dk
description: KultuNaut.dk — Denmark's electronic cultural guide. Search events by genre, place, and date via Perl CGI endpoints returning HTML. Use when browsing Danish cultural events, cinema films, adult education courses, or embedding a KultuNaut calendar widget.
last-updated: 2026-05-09
---

# KultuNaut.dk Skill

KultuNaut is Denmark's electronic cultural guide ("Den elektroniske kulturguide") — a centralized calendar covering culture, music, theater, exhibitions, sports, adult education, and community activities across Denmark and the Øresund region. 126,000+ events served via Perl CGI.

## CLI

All interaction goes through the `kultunaut` CLI — it can be run from anywhere, with no need to point at the skill directory:

```bash
kultunaut <events|event|films|rss> [options]
```

KultuNaut has **no JSON API** — every endpoint returns HTML (the documented "RSS" feed currently redirects to an HTML widget). The CLI fetches those pages and best-effort extracts a readable, machine-friendly list (compact JSON). Parsing is **defensive**: if the expected markup is not found it prints the raw body with a one-line note on stderr. Pass `--raw` to always get the unparsed upstream HTML/XML.

### Prerequisites

Verify the CLI is installed:

```bash
which kultunaut
```

If missing, install it editable with pipx (from the skill directory). First make sure pipx itself is available, then install:

```bash
# Ensure pipx is installed
which pipx || python3 -m pip install --user pipx
python3 -m pipx ensurepath

# Install the kultunaut CLI
pipx install -e <path-to-kultunaut-dk-skill>
```

After installing, confirm `kultunaut` is on the PATH (you may need to restart the shell so `pipx ensurepath` takes effect):

```bash
which kultunaut
```

Pure Python standard library — no extra dependencies.

### Examples

```bash
# Today's events in Aarhus
kultunaut events --area "8000 Aarhus C" --periode 1

# Most-popular music events in the capital region this month
kultunaut events --area "Region Hovedstaden" --periode 30 --genre Musik --order Rating

# A single event's detail by ArrNr
kultunaut event 19896575

# Cinema films now showing (blank --area = all of Denmark)
kultunaut films --periode 1
kultunaut films --area "8000 Aarhus C" --periode 1

# Popular-events feed
kultunaut rss --order Rating

# English-language pages (code goes after type-nynaut: /perl/arrlist/type-nynaut/UK)
kultunaut events --area "Hele Danmark" --periode 1 --lang uk

# Raw upstream HTML/XML for any command
kultunaut events --area "8000 Aarhus C" --periode 1 --raw
```

Global options on every subcommand: `--raw` (raw upstream body) and `--lang {da,sv,uk,de}` (da=Danish default, sv=Swedish `S`, uk=English `UK`, de=German `D`).

## URL Structure

Base: `https://www.kultunaut.dk/`

Language codes go between the type prefix and page name:
- No code → Danish (default)
- `S` → Swedish
- `UK` → English
- `D` → German

Example: `/type-nynaut/S/` = Swedish, `/type-nynaut/UK/` = English

## API Endpoints (Prefer Over Browser Automation)

All endpoints use GET. No auth required for read operations.

### Event Calendar (Primary Search)

```
GET https://www.kultunaut.dk/perl/arrlist/type-nynaut
```

Query parameters:

| Param | Description | Examples |
|-------|-------------|----------|
| `Area` | Geography | `8000 Aarhus C`, `Region Hovedstaden`, `Hele Danmark` |
| `periode` | Time period | `1` = today, `30` = upcoming month |
| `Genre` | Event genre | `Musik`, `Jazz`, `Skuespil`, `Udstilling`, `Familiefilm`, `Workshop` |
| `Order` | Sort | `Rating` = most popular |

Example: `https://www.kultunaut.dk/perl/arrlist/type-nynaut?Area=8000+Aarhus+C&periode=1&Genre=Rock/Pop`

### Event Detail

```
GET https://www.kultunaut.dk/perl/arrmore/type-nynaut?ArrNr={number}
```

Each event has a unique `ArrNr` (e.g., `19896575`). Retrieve from search results for full details.

### Cinema Films

```
GET https://www.kultunaut.dk/perl/searchlist/type-nynaut?periode=1&Genre=Film&Area=
```

Add `Area` to filter by region.

### RSS Feed

```
GET https://www.kultunaut.dk/perl/mini/type-rss?Order=Rating&periode=
```

Add `Order=Rating` for popularity sort.

### Widget

```
GET https://www.kultunaut.dk/perl/widget/type-nynaut
```

Embeddable widget for external sites.

### One-Liners

| Endpoint | URL |
|----------|-----|
| Free Events | `/perl/view/type-nynaut/gratiskalender` |
| Special Calendars | `/perl/view/type-nynaut/specialkalendere` |
| Adult School Courses | `/perl/view/type-nynaut/aftenskole` |
| Bookmarks | `/perl/profile/type-nynaut/myratings` (requires login) |

## Key Notes

- Perl-based application — no JSON REST API. All endpoints return HTML.
- No authentication required for browsing/searching.
- Login at `/perl/openlogin/type-nynaut` enables bookmarking.
- Events carry structured metadata: title, date/time, venue, genre, description, organizer.
- `MarkType` filter covers niche categories (circus, cycling, chess, scouts, dogs, etc.).
- `periode=1` = current events, `periode=30` = upcoming month.
