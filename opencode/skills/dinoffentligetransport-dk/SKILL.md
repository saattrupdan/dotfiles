---
name: dinoffentligetransport-dk
description: Danish public transport info portal (DSB, Movia, Metro, letbaner). Look up bus schedules, zones, disruptions, and ticket info. Anonymous browsing open; ticket purchase needs MitID. Use for transit queries, schedule changes, and querying internal JSON APIs.
last-updated: 2026-05-09
---

# dinoffentligetransport.dk — Danish public transport portal

Official public transport information hub for Denmark's Zealand-region operators: **DSB** (trains), **Movia** (buses), **Metro**, and **letbaner** (light rail). Operated by DSB Group on Umbraco CMS + React SPA. Anonymous browsing fully open; buying tickets requires MitID login. Site language: Danish — respond in Danish unless the user signals otherwise.

> **Important**: The site requires a browser User-Agent. Headless/non-browser clients must send a browser-like User-Agent header.

All URLs below are relative to `https://dinoffentligetransport.dk/`. URL slugs use **proper Danish letters** spelled out (`æ`→`ae`, `ø`→`oe`, `å`→`aa`).

## Top-level navigation

| Section | URL | Content |
|---|---|---|
| Forsiden (Home) | `/` | Hero search widget, breaking news ticker, quick-access tiles |
| Planlæg din rejse | `/planlaeg-din-rejse` | Journey planning info, zone maps, general travel guidance |
| Buskøreplaner | `/planlaeg-din-rejse/koereplaner-for-bus-og-havnebus` | Bus schedule changes, line search, affected routes |
| Zone- og linjekort | `/planlaeg-din-rejse/zone-og-linjekort` | Zone maps for Metro and bus regions |
| Find billetter | `/find-billetter` | Ticket overview, types, pricing guidance |
| Apps til rejsen | `/find-billetter/apps-til-rejsen` | Mobile app recommendations |
| Erhverv | `/find-billetter/erhverv` | Business travel solutions |
| Sådan rejser du | `/saadan-rejser-du` | Travel rules, zone info, passenger rights |
| Trafikinformation | `/` (home page) | Live disruption ticker |
| Kontakt os | `/kontakt-os` | Contact, control fee, refund info |

## Multilingual support

Three languages: Danish (default), English (`/en`), German (`/de`). Prepend the prefix to the URL path.

## Breaking news ticker

Home page features a scrolling "breaking news" ticker (`<article class="breaking-news">`) showing current traffic disruptions. Content is server-rendered into the HTML — no separate API call needed.

## Rejseplanen integration

The site links to **Rejseplanen** (`http://www.rejseplanen.dk`) for actual journey planning. This is a separate service — dinoffentligetransport.dk provides informational pages about tickets, zones, and rules only.

## Ticket types overview

Key concepts: **Zoner** (zone-based pricing), **Pendlerkort** (commuter tickets), **Pensionistkort** (senior 67+), **Ungdomskort** (youth 16–25), **Print-selv-billet** (print-at-home, expires 4 AM after last valid date).

## Internal JSON APIs

Undocumented internal APIs used by the SPA, under `/api/`. Extracted from `index.client.js`. Prefer over browser automation when they cover the functionality.

### Conventions

- Base URL: `https://dinoffentligetransport.dk`
- All endpoints return JSON. No auth required for read-only endpoints.
- Error responses: `{"Message":"<text>"}` with HTTP `4xx`/`5xx`.
- SPA uses React Query with cookie-based session auth for authenticated endpoints.

### Anonymous endpoints

| Endpoint | Purpose |
|---|---|
| `GET /api/JourneyPlanner/addresses/<query>` | Station/address autocomplete (backed by "Fra"/"Til" search fields). Returns JSON array of location name strings. |
| `GET /api/BusLines/lines` | All bus lines. |
| `GET /api/BusLines/schedulechanges` | Planned service disruptions and schedule changes. |
| `GET /api/BusLines/schedulechanges/<line_id>` | Schedule changes for a specific line. |
| `GET /api/BusLines/schedulefileinfo/<line_id>` | Metadata about schedule file for a line. |
| `GET /api/buslines/directions/<line_id>` | Directions/stops for a specific line. |
| `GET /api/buslines/fromstoppoints/<stop_id>` | Departure times from a specific stop. |
| `GET /api/JourneyPlanner/seasonpasszone/` | Zone info for season pass pricing. |
| `GET /api/lostandfound/` | Lost and found information. |
| `GET /api/transportationChanges` | Current transportation disruptions. |
| `GET /api/content/type/<content_type>` | Dynamic page content loading. |

### Auth model

| Endpoint group | Auth | Notes |
|---|---|---|
| JourneyPlanner, BusLines, transportationChanges, content, lostandfound | **Anonymous** | Fully open read access |
| Product, Order, Basket | **Session-bound** | Require browser session with cookies |
| Member, MitId | **Interactive** | MitID login requires live browser |

## Common tasks

### Find bus schedules and changes
Navigate to `/planlaeg-din-rejse/koereplaner-for-bus-og-havnebus`, search by line number or location. Alternatively: `GET /api/BusLines/schedulechanges` and `GET /api/buslines/directions/<line_id>`.

### Look up a specific bus line
Go to the bus schedule page and search for the line number. Alternatively: `GET /api/BusLines/lines` then `GET /api/buslines/directions/<line_id>`.

### Learn about ticket zones
Navigate to `/planlaeg-din-rejse/zone-og-linjekort` for interactive zone maps. Alternatively: `GET /api/JourneyPlanner/seasonpasszone/`.

### Understand travel rules
Navigate to `/saadan-rejser-du` and sub-pages for ticket types, passenger rights, control fees (`/kontakt-os/kontrolafgift`), refunds (`/kontakt-os/tilbagebetaling`).

### Contact / customer service
Navigate to `/kontakt-os`.

## What you cannot do

- **No live journey planning** — the journey planner is at Rejseplanen (separate service).
- **No ticket purchasing** — basket/order flow requires full browser session with MitID.
- **No structured article fetch** — articles are SSR HTML at their slug URL; no `/api/article/<id>`.
- **No bulk export** — enumerate URLs from site structure, then fetch each HTML page.
- **No documented contract** — APIs can change without notice; inferred from SPA bundle.

## Related hosts

- `https://www.rejseplanen.dk` — journey planner (separate service).
- `https://pendlertjek.dk` — commuter ticket calculator.
- `https://app-dot-webshop-prod-umbraco-we.azurewebsites.net` — Azure backend (Umbraco CMS + API).
