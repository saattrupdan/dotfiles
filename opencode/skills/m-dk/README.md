# m-dk

Reference for navigating m.dk — the official Copenhagen Metro website operated by Metroselskabet. Covers four metro lines (~30 stations), journey planning, ticketing info, live status, and exploration guides. Bilingual (Danish/English).

## Requirements

- `m_dk_api.py` CLI helper — standard library only
- Internet access to `m.dk` and `m.ankiro.dk` (search API)
- No login required for any content

## Quick Start

```bash
# Metro lines
open https://m.dk/da/linjer-og-koereplaner/
open https://m.dk/da/linjer-og-koereplaner/vanloese-vestamager/  # M1
open https://m.dk/da/linjer-og-koereplaner/cityringen/            # M3

# Stations
open https://m.dk/da/planlaeg-rejsen/koebenhavn-h/
open https://m.dk/da/planlaeg-rejsen/noerreport/

# Live status
open https://m.dk/da/drift-og-service/status-og-planlagte-driftsaendringer/

# English mirror
open https://m.dk/en/frontpage/

# CLI: search for "koebenhavn"
python3 m_dk_api.py search koebenhavn

# CLI: search with pagination
python3 m_dk_api.py search metroen --start 10 --max 5

# CLI: show facet definitions
python3 m_dk_api.py facets koebenhavn
```

## Navigation Reference

### Metro lines

| Line | Route | Slug |
|---|---|---|
| M1 | Vanløse ↔ Vestamager | `/da/linjer-og-koereplaner/vanloese-vestamager/` |
| M2 | Vanløse ↔ Lufthavn | `/da/linjer-og-koereplaner/vanloese-koebenhavns-lufthavn/` |
| M3 | Cityringen (ring) | `/da/linjer-og-koereplaner/cityringen/` |
| M4 | Orientkaj ↔ København Syd | `/da/linjer-og-koereplaner/orientkaj-koebenhavn-syd/` |

### Key stations

| Station | Lines | Slug |
|---|---|---|
| København H | M3/M4 | `/da/planlaeg-rejsen/koebenhavn-h/` |
| Nørreport | M1/M2/M3 | `/da/planlaeg-rejsen/noerreport/` |
| Kongens Nytorv | M1/M2/M3/M4 | `/da/planlaeg-rejsen/kongens-nytorv/` |
| Lufthavn | M2 | `/da/planlaeg-rejsen/koebenhavns-lufthavn/` |

### Internal API: Ankiro Search

`GET https://m.ankiro.dk/Rest/Metro-Live/Search?q=<query>&culture=da&startIndex=0&maxResults=10`

Returns JSON with `Documents[]` containing `Title`, `Uri`, `pageType`, `metroLine`, and `Culture`. Pagination via `startIndex`.

## Troubleshooting

- **No journey planner on m.dk** — always redirect to Rejseplanen.dk.
- **No ticket purchasing on m.dk** — always redirect to rejsekort.dk.
- **No live departure times API** — m.dk does not expose real-time departure data.
- **English mirror has fewer articles** — the `/en/` path maps to `/da/` but content is sparser.
