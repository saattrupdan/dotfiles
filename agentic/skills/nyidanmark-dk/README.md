# nyidanmark-dk

Reference for navigating nyidanmark.dk — Denmark's official immigration portal operated by Udlændingestyrelsen and SIRI. Covers five life-state sections (apply, wait, answered, extend, changed), the Min Side self-service portal, and internal JSON APIs for search and news.

## Requirements

- `nyidanmark_dk_api.py` CLI helper — standard library only
- Internet access to `nyidanmark.dk`
- URL slugs use URL-encoded Danish letters: `æ`→`%C3%A6`, `ø`→`%C3%B8`, `å`→`%C3%A5`

## Quick Start

```bash
# Five main sections
open https://nyidanmark.dk/da/Du-vil-ans%C3%B8ge          # Apply
open https://nyidanmark.dk/da/Du-venter-svar             # Waiting
open https://nyidanmark.dk/da/Du-har-f%C3%A5et-svar      # Answered
open https://nyidanmark.dk/da/Du-vil-forl%C3%A6nge       # Extend
open https://nyidanmark.dk/da/Din-situation-%C3%A6ndrer-sig  # Changed

# Min Side (self-service, requires MitID)
open https://minside.nyidanmark.dk/en-US/minside

# English mirror
open https://nyidanmark.dk/en-GB/

# CLI: search for "visum"
python3 nyidanmark_dk_api.py search visum

# CLI: page 2 of results
python3 nyidanmark_dk_api.py search "arbejde" --page 2

# CLI: list news category tags
python3 nyidanmark_dk_api.py news-tags

# CLI: news for a category
python3 nyidanmark_dk_api.py news "Arbejde"
```

## Navigation Reference

### Card navigation pattern

Every hub page follows: `/da/<Section>/<Category>`

Examples:
- `/da/Du-vil-ans%C3%B8ge/Familie` — Family reunification (apply)
- `/da/Du-vil-ans%C3%B8ge/Arbejde` — Work (apply)
- `/da/Du-vil-ans%C3%B8ge/Studie` — Study (apply)
- `/da/Du-vil-ans%C3%B8ge/Asyl` — Asylum (apply)
- `/da/Du-vil-ans%C3%B8ge/Kort-ophold-(Visum)` — Short stay / visa

### Key reference pages

| URL | Content |
|---|---|
| `/da/Ord-og-begreber` | Glossary |
| `/da/Kontakt-os` | Contact info |
| `/da/Nyheder` | Latest news |
| `/da/Lovstof` | Legal framework |
| `/da/Tal-og-statistik` | Processing times |

### Internal APIs

| Endpoint | Purpose |
|---|---|
| `GET /api/search/getsearchresults?query=<q>&page=<n>` | Site search (JSON) |
| `POST /api/news/getNews` with `{"newsTypeTag": "Arbejde"}` | News articles by tag |
| `GET /api/news/getTags` | News tag taxonomy |

## Troubleshooting

- **No application submission** — the site is informational only. Applications go through Min Side portals.
- **No personal-data API** — case details are only in the Min Side login portals.
- **Search is HTML-only on the site** — use the `/api/search` GET endpoint for programmatic access.
- **English content is incomplete** — the `/en-GB/` mirror is a curated subset.
- **Self-service portals are separate apps** — Min Side links point to `minside.nyidanmark.dk` and other sub-domains.
