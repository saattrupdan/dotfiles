# dsb-dk

Reference for navigating dsb.dk — the Danish national railway operator's public website. Covers ticket products, traffic information, station details, prices/zones, and DSB Plus loyalty. No login required for browsing.

## Requirements

- `dsb_dk_api.py` CLI helper — standard library only
- Internet access to `www.dsb.dk`

## Quick Start

```bash
# Homepage with journey search
open https://www.dsb.dk/

# Traffic disruptions
open https://www.dsb.dk/trafikinformation/

# Station details
open https://www.dsb.dk/trafikinformation/stationer/kobenhavn-h/

# Prices and zones
open https://www.dsb.dk/priser-og-zoner/

# English mirror
open https://www.dsb.dk/en/

# CLI: list all stations
python3 dsb_dk_api.py stations

# CLI: filter stations by name
python3 dsb_dk_api.py stations -q aarhus --raw

# CLI: traffic info page
python3 dsb_dk_api.py traffic-info

# CLI: enumerate sitemap
python3 dsb_dk_api.py sitemap --prefix /trafikinformation/ --limit 20
```

## Navigation Reference

### Top-level sections

| Tab | URL | Purpose |
|---|---|---|
| Find rejse og pris | `/` | Journey search form |
| Trafikinformation | `/trafikinformation/` | Live disruptions |
| Hjælp og kontakt | `/hjaelp-og-kontakt/` | Customer service |
| DSB Plus | `/dsb-plus/` | Loyalty programme |
| Erhverv | `/dsb-erhverv/` | Business accounts |

### Ticket products

| Product | URL |
|---|---|
| DSB-appen | `/find-produkter-og-services/dsb-app/` |
| Orange | `/find-produkter-og-services/orange/` |
| Pendlerkort | `/find-produkter-og-services/dsb-pendlerkort/` |
| Ungdomskort | `/find-produkter-og-services/ung/ungdomskort/` |
| DSB 1' | `/find-produkter-og-services/dsb-1-billetter/` |
| Rejser til udland | `/find-produkter-og-services/dsb-udland/` |

### Station detail pages

`/trafikinformation/stationer/<station-slug>/`

### Internal API

| Endpoint | Purpose |
|---|---|
| `GET /api/stations/getstationlist` | Station list (always returns all ~320 stations; server ignores `?q=`) |
| Sitemap | `/sitemap.xml` (~1200 URLs) |

## Troubleshooting

- **No ticket booking API** — all purchases go through the interactive website or DSB app.
- **No seat availability API** — seat selection happens on the journey result page.
- **Station list returns ALL stations** — server ignores `?q=`; use `-q` with the helper script for client-side filtering.
- **No journey search API** — the search form requires JavaScript for autocomplete.
