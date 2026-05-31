---
name: kultunaut-dk
description: KultuNaut.dk — Denmark's electronic cultural guide. Search events by genre, place, and date via Perl CGI endpoints returning HTML. Use when browsing Danish cultural events, cinema films, adult education courses, or embedding a KultuNaut calendar widget.
last-updated: 2026-05-31
---

# KultuNaut.dk Skill

KultuNaut is Denmark's electronic cultural guide ("Den elektroniske kulturguide") — a centralized calendar covering culture, music, theater, exhibitions, sports, adult education, and community activities across Denmark and the Øresund region. 126,000+ events, served by a Perl CGI backend with **no JSON API** (every endpoint returns HTML; the documented "RSS" feed currently redirects to an HTML widget).

## Use the `kultunaut` CLI

**Always go through the `kultunaut` CLI** to search events, get event details, list films, or read the feed. The CLI fetches the upstream pages, best-effort extracts the data, and prints **JSON** — so you do **not** construct the Perl-CGI URLs or scrape the site by hand. (The raw endpoints and URL conventions are documented at the end as a fallback, for the rare case the CLI doesn't expose what you need.)

The CLI runs from anywhere — no need to point at the skill directory:

```bash
kultunaut <events|event|films|rss> [options]
```

Parsing is **defensive**: if the expected markup is not found, the CLI prints the raw body with a one-line note on stderr. Pass `--raw` on any command to always get the unparsed upstream HTML/XML instead of JSON. Pure Python standard library — no extra dependencies.

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

### Command reference

| Command | Purpose |
|---------|---------|
| `kultunaut events [opts]` | Search the event calendar; prints a JSON list of events (arrnr, title, genre, datetime, venue, url). |
| `kultunaut event <ArrNr>` | Fetch one event's detail (title + description) by its `ArrNr`. |
| `kultunaut films [opts]` | List cinema films now showing (title + cinema/series `stednr`). |
| `kultunaut rss [opts]` | Read the popular-events feed (title/link/description, falling back to event cards). |

**`events` options:**

| Option | Maps to | Values |
|--------|---------|--------|
| `--area` | `Area` | `"8000 Aarhus C"`, `"Region Hovedstaden"`, `"Hele Danmark"` |
| `--periode` | `periode` | `1` = today/current, `30` = upcoming month |
| `--genre` | `Genre` | `Musik`, `Jazz`, `Rock/Pop`, `Skuespil`, `Udstilling`, `Familiefilm`, `Workshop`, … |
| `--order` | `Order` | `Rating` = most popular |

**`films` options:** `--area` (blank = all of Denmark) and `--periode` (`Genre=Film` is set automatically).

**`rss` options:** `--order` (`Rating` for popularity) and `--periode`.

**Global options on every subcommand:**

- `--raw` — print the raw upstream HTML/XML instead of parsed JSON.
- `--lang {da,sv,uk,de}` — page language: `da`=Danish (default), `sv`=Swedish (`S`), `uk`=English (`UK`), `de`=German (`D`). The code is inserted after `type-nynaut` in the URL. (Note: `rss` has no language segment.)

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

# English-language pages
kultunaut events --area "Hele Danmark" --periode 1 --lang uk

# Raw upstream HTML/XML for any command
kultunaut events --area "8000 Aarhus C" --periode 1 --raw
```

---

## Reference: underlying endpoints & URL conventions

This is what the CLI wraps. **Consult it only when you need something the CLI doesn't expose** (e.g. the website-only features below). For everyday event/film/feed lookups, use the CLI above instead of building these URLs or scraping by hand.

All endpoints use GET and require no auth for read operations. Base: `https://www.kultunaut.dk/`

**Language-code convention** (what `--lang` implements): the code goes between the type prefix and page name, directly after `type-nynaut`:

- no code → Danish (default)
- `S` → Swedish
- `UK` → English
- `D` → German

Example: `/perl/arrlist/type-nynaut/UK` = English event list.

### Endpoints the CLI wraps

| CLI | Endpoint | Notes |
|-----|----------|-------|
| `events` | `GET /perl/arrlist/type-nynaut` | Event calendar search. Params: `Area`, `periode`, `Genre`, `Order` (see option tables above). Example: `?Area=8000+Aarhus+C&periode=1&Genre=Rock/Pop` |
| `event` | `GET /perl/arrmore/type-nynaut?ArrNr={number}` | Single event detail. Each event has a unique `ArrNr` (e.g. `19896575`), found in search results. |
| `films` | `GET /perl/searchlist/type-nynaut?Genre=Film&Area=&periode=1` | Cinema films; add `Area` to filter by region. |
| `rss` | `GET /perl/mini/type-rss?Order=Rating&periode=` | Popular-events feed (no `type-nynaut`/language segment). |

`periode=1` = current events, `periode=30` = upcoming month. The `MarkType` param covers niche categories (circus, cycling, chess, scouts, dogs, etc.). Events carry structured metadata: title, date/time, venue, genre, description, organizer.

### Website-only features (not covered by the CLI)

These have no CLI subcommand — navigate the site directly if needed:

| Feature | URL |
|---------|-----|
| Embeddable widget | `/perl/widget/type-nynaut` |
| Login (enables bookmarking) | `/perl/openlogin/type-nynaut` |
| Bookmarks (requires login) | `/perl/profile/type-nynaut/myratings` |
| Free events | `/perl/view/type-nynaut/gratiskalender` |
| Special calendars | `/perl/view/type-nynaut/specialkalendere` |
| Adult-school courses | `/perl/view/type-nynaut/aftenskole` |
