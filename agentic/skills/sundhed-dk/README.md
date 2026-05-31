# sundhed-dk

Reference for navigating sundhed.dk — the Danish national e-health portal. Covers citizen ("borger") and healthcare-professional ("sundhedsfaglig") flows. Citizen login = MitID; clinician login = MitID Erhverv or SOSI smartcard.

## Requirements

- `sundhed` CLI — standard library only (`pipx install -e .`)
- Internet access to `www.sundhed.dk`
- Fronted by `queue-it.net` at peak load — at-scale automation may be queued

## Quick Start

```bash
# --- Citizen ---
open https://www.sundhed.dk/borger/patienthaandbogen/
open https://www.sundhed.dk/borger/sygdom-og-behandling/
open https://www.sundhed.dk/borger/guides/find-behandler/
open https://www.sundhed.dk/borger/min-side/

# --- Clinician ---
open https://www.sundhed.dk/sundhedsfaglig/
open https://www.sundhed.dk/sundhedsfaglig/laegehaandbogen/dli-medicin/

# CLI: version, login, settings
sundhed version
sundhed login
sundhed settings

# CLI: menus, filters, org types
sundhed menu --section borger --kind top
sundhed filters --section borger
sundhed orgtypes

# CLI: autocomplete, sitemap
sundhed autocomplete blod
sundhed sitemap
sundhed urls --shard artikel
```

## Navigation Reference

### Citizen — anonymous

| Feature | URL |
|---|---|
| Patient handbook | `/borger/patienthaandbogen/` |
| Illness & treatment | `/borger/sygdom-og-behandling/` |
| Prevention | `/borger/forebyggelse/` |
| Hospital choice | `/borger/patientrettigheder/sygehusvalg-ventetider/` |
| Find provider | `/borger/guides/find-behandler/` |

### Citizen — Min Side (logged-in)

Root: `/borger/min-side/`

| Area | Key pages |
|---|---|
| Health journal | `min-sundhedsjournal/` — medicinkortet, laboratoriesvar, journal-fra-sygehus, vaccinationer, diagnoser |
| Self-service | `receptfornyelse/` (prescription renewal), `tidsbestilling/` (book GP) |
| Registrations | `mine-registreringer/` — organdonation, livstestamente, screeningsprogrammer |
| Audit log | `min-log/min-log/` — who accessed your data |

### Clinician — public reference

| Feature | URL |
|---|---|
| Professional home | `/sundhedsfaglig/` |
| Clinician handbook | `/sundhedsfaglig/laegehaandbogen/` |
| Drug-interaction lookup | `/sundhedsfaglig/laegehaandbogen/dli-medicin/` |

### Internal API (`/api/`)

| Endpoint | Purpose |
|---|---|
| `GET /api/version` | Site version info |
| `GET /api/login/isloggedin` | Login state JSON |
| `GET /api/keepalive/timeleft` / `POST /api/keepalive/renew` | Session lifetime |
| `GET /api/core/startupsettings` | Site config |
| `GET /api/navigation{top|footer|icon}menu/?section=borger` | Menus |
| `GET /api/search/searchadditionalfilters?section=borger` | Regions + municipalities |
| `GET /api/searchorganizationtype/` | Provider categories |
| `GET /api/alertbanners/` | Active outage banners |
| `GET /api/core/applicationplugin/` | SPA app registry |
| `POST /api/ordbog/autocomplete/` | Medical dictionary autocomplete |
| `GET /api/cms/sitemap` | Sitemap shards |

## Troubleshooting

- **No public API for personal health data** — endpoints are session-bound to MitID.
- **queue-it.net challenge** — at-scale automation may be queued during peak load.
- **Regional apps are region-specific** — AK Online, Diabetes Online, etc. only work for citizens in the operating region.
- **Danish-only** — all content and copy is in Danish.
- **No bulk export** — enumerate URLs from sitemap shards; rendered pages are in the SPA.
