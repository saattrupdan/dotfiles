# kk-dk

Reference for navigating kk.dk — the official website of the City of Copenhagen (Københavns Kommune). Built on Drupal 11 with a custom theme. Server-rendered HTML only; no usable public API.

## Requirements

- No CLI script — this is a site-navigation skill
- Internet access to `www.kk.dk`
- URL slugs use Danish letters spelled out: `æ`→`ae`, `ø`→`oe`, `å`→`aa`

## Quick Start

```bash
# Citizen services
open https://www.kk.dk/borger
open https://www.kk.dk/borger/borgerservice

# News
open https://www.kk.dk/nyheder

# Politics
open https://www.kk.dk/politik

# Jobs
open https://www.kk.dk/ledigestillinger

# Global search
open https://www.kk.dk/soeg?k=topic

# English mirror
open https://international.kk.dk
```

## Navigation Reference

### Top-level sections

| Section | URL | Content |
|---|---|---|
| Borger | `/borger` | Citizen services: pass, moving, pension, health, school |
| Erhverv | `/erhverv` | Business: permits, construction, procurement, property rental |
| Brug byen | `/brug-byen` | Culture, sports, parks, events, associations |
| Politik | `/politik` | Governance: council, committees, mayor, budget, agendas |
| Om kommunen | `/om-kommunen` | Contacts, departments, jobs, statistics, press |

### News and press

`/nyheder` is a paginated Views list with eight filters: keyword, date range, category (319–554), content type ("Nyhed"/"Pressemeddelelse"), and department (1–8). 24 items per page, navigate with `?page=N`.

### Internal search

- Global search: `GET /soeg?k=<query>` returns HTML results.
- Search autocomplete at `/search_api_autocomplete/search` exists but returns empty arrays via HTTP (JS-dependent). **Use the HTML search page directly.**

### English mirror

`https://international.kk.dk` — subset of kk.dk content translated into English.

## Troubleshooting

- **No public API** — the site is entirely server-rendered HTML. All interactions must go through page navigation.
- **Search autocomplete is JS-dependent** — the `/search_api_autocomplete/*` endpoint returns empty arrays via HTTP.
- **News listing is paginated** — `/nyheder` shows 24 items per page.
- **No MitID login on kk.dk** — personal self-service is not available; only appointment booking and informational forms.
