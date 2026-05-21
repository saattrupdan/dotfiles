---
name: kultunaut-dk
description: KultuNaut.dk — Denmark's electronic cultural guide. Search events by genre, place, and date via Perl CGI endpoints returning HTML. Use when browsing Danish cultural events, cinema films, adult education courses, or embedding a KultuNaut calendar widget.
last-updated: 2026-05-09
---

# KultuNaut.dk Skill

KultuNaut is Denmark's electronic cultural guide ("Den elektroniske kulturguide") — a centralized calendar covering culture, music, theater, exhibitions, sports, adult education, and community activities across Denmark and the Øresund region. 126,000+ events served via Perl CGI.

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
