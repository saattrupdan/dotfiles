# dinoffentligetransport-dk

Reference for navigating dinoffentligetransport.dk — the Danish public transport information portal for DSB, Movia buses, Metro, and letbaner on Zealand. Operated by DSB Group. Anonymous browsing is fully open.

## Requirements

- No CLI script — this is a site-navigation skill
- Internet access to `dinoffentligetransport.dk`
- Send a browser-like `User-Agent` — headless clients are blocked

## Quick Start

```bash
# Front page with live disruption ticker
open https://dinoffentligetransport.dk/

# Journey planning info
open https://dinoffentligetransport.dk/planlaeg-din-rejse

# Bus schedules and changes
open https://dinoffentligetransport.dk/planlaeg-din-rejse/koereplaner-for-bus-og-havnebus

# Ticket info
open https://dinoffentligetransport.dk/find-billetter

# Zone maps
open https://dinoffentligetransport.dk/planlaeg-din-rejse/zone-og-linjekort

# English mirror
open https://dinoffentligetransport.dk/en/plan-your-journey
```

## Navigation Reference

### Top-level sections

| Section | URL | Content |
|---|---|---|
| Planlæg din rejse | `/planlaeg-din-rejse` | Journey info, zone maps |
| Buskøreplaner | `/planlaeg-din-rejse/koereplaner-for-bus-og-havnebus` | Bus schedule changes |
| Zone- og linjekort | `/planlaeg-din-rejse/zone-og-linjekort` | Zone maps |
| Find billetter | `/find-billetter` | Ticket overview |
| Sådan rejser du | `/saandan-rejser-du` | Travel rules, passenger rights |
| Trafikinformation | (home page ticker) | Live disruptions |

### Multilingual support

| Language | Prefix | Example |
|---|---|---|
| Danish | none | `/planlaeg-din-rejse` |
| English | `/en` | `/en/plan-your-journey` |
| German | `/de` | `/de/fahren-sie-mit-uns` |

### Internal APIs (GET)

| Endpoint | Purpose |
|---|---|
| `GET /api/JourneyPlanner/addresses/<query>` | Station/address autocomplete |
| `GET /api/BusLines/lines` | All bus lines |
| `GET /api/BusLines/schedulechanges` | Scheduled changes |
| `GET /api/BusLines/schedulechanges/<line_id>` | Specific line changes |
| `GET /api/buslines/directions/<line_id>` | Line directions/stops |
| `GET /api/buslines/fromstoppoints/<stop_id>` | Departures from stop |
| `GET /api/transportationChanges` | Live disruptions |
| `GET /api/JourneyPlanner/seasonpasszone/` | Season pass zones |
| `GET /api/lostandfound/` | Lost and found |

## Troubleshooting

- **No live journey planning on this site** — the actual planner is at Rejseplanen.dk.
- **No ticket purchasing** — requires full browser session with MitID.
- **Must send browser User-Agent** — the site blocks headless/non-browser clients.
