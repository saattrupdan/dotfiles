---
name: dsb-dk
description: dsb.dk — Danish national railway operator. Covers ticket search, station list API, traffic info, ticket products, DSB Plus, and business accounts. Use for Danish train lookup, pricing, and station data.
last-updated: 2026-05-09
---

# dsb.dk — Danish national railway operator

`https://www.dsb.dk/` sells train tickets, publishes timetables and traffic information, and provides station details and loyalty programme info. **No public API for booking, seat availability, or personal data.** All purchases go through the website or mobile app.

Default language is Danish; respond in Danish unless the user signals otherwise. English mirror at `/en/`.

## Top-level navigation

| Tab | URL | Purpose |
|---|---|---|
| **Find rejse og pris** | `/` | Homepage with journey search form |
| **Trafikinformation** | `/trafikinformation/` | Live disruptions, planned changes |
| **Hjælp og kontakt** | `/hjaelp-og-kontakt/` | Customer service, refunds, contact |
| **DSB Plus** | `/dsb-plus/` | Free loyalty programme |
| **Erhverv** | `/dsb-erhverv/` | Business accounts and corporate rates |

Secondary: **Køreplaner** — `/trafik-information/koereplaner/` (timetables); **Priser og zoner** — `/priser-og-zoner/` (fare tables); **Om DSB** — `/om-dsb/` (about).

## Journey search form

The homepage form accepts:

| Field | Description |
|---|---|
| **Fra / Til** | From/to stations — autocomplete via `/api/stations/getstationlist` (returns all stations; client filters) |
| **Via** | Optional intermediate stop |
| **Udrejse / Ankomst** | Date and time |
| **Antal rejsende** | Adults, Children 0-11, Children 12-15, Seniors 67+, Youth 16-25 |
| **Pladsbilletter** | Optional seat reservations (1-7 per journey) |

Submits via POST to `/netbutik/resultat/`. Requires JavaScript for autocomplete/date picker.

## Key ticket products

- **DSB-appen** — `/find-produkter-og-services/dsb-app/` — Mobile app for tickets
- **Orange** — `/find-produkter-og-services/orange/` — Flexible ticket, choose time within 2h
- **Orange Fri** — `/find-produkter-og-services/orange-fri/` — Unlimited Orange for 30 days
- **Pendlerkort** — `/find-produkter-og-services/dsb-pendlerkort/` — Commuter/period tickets
- **Pendler20** — `/find-produkter-og-services/Pendler20/` — Subsidised commuter ticket
- **Ungdomskort** — `/find-produkter-og-services/ung/ungdomskort/` — Youth card (16-25)
- **DSB 1'** — `/find-produkter-og-services/dsb-1-billetter/` — Single ticket for 1 zone
- **Rejser til udlandet** — `/find-produkter-og-services/dsb-udland/` — International tickets
- **Cykel-pladsbillet** — `/find-produkter-og-services/cykel-pladsbillet/` — Bicycle reservation
- **DSB gruppebillet** — `/find-produkter-og-services/dsb-gruppebillet/` — Group tickets (up to 9)

## Traffic information

- `/trafikinformation/` — Live disruption feed
- `/trafikinformation/planlagte-aendringer/` — Planned changes (track work)
- `/trafikinformation/stationer/` — All stations list
- `/trafikinformation/elevatorer` — Elevator status
- `/trafik-information/koereplaner/` — Timetables
- `/trafik-information/oversigtskort/` — Line and zone maps

## Station details

URL pattern: `/trafikinformation/stationer/<station-slug>/`

Examples: `/trafikinformation/stationer/kobenhavn-h/`, `/trafikinformation/stationer/aarhus-h/`, `/trafikinformation/stationer/odense/`, `/trafikinformation/stationer/kobenhavns-lufthavn-kastrup/`

Pages show departures, arrivals, facilities (shops, elevators, bike parking), and platform info. Common tags: `DSB Salg & Service`, `DSB 7-Eleven`, `Aflåst cykelparkering`, `Stationsstuer`, `Servicecenter`.

## DSB Plus

Free loyalty programme with discounts on food, drinks, and experiences. Partners include Tivoli, Louisiana Museum, Hamlets Scenen, Bakken, DanHostel. Root: `/dsb-plus/`. Account: `/dsb-plus/minside/` (requires login).

## Business (Erhverv)

Corporate accounts with benefits: 20% savings over Storebælt, up to 50% on Erhverv cards. Root: `/dsb-erhverv/`. Sub-pages: `/dsb-erhverv/co2/` (CO2 tracking), `/dsb-erhverv/checkind/` (business check-in), `/dsb-erhverv/bp/` (business portal).

## Login / authentication

DSB uses **Gigya** (Social Login). CIAM config embedded in page HTML:

```javascript
dsbdk.ciam.configuration = {
    ApiKey: "4_sgl-E5_0k4GxgwQJBsMWLQ",
    ScreenSets: {
        RegisterLogin: "DSB-RegistrationLogin-20240920",
        ProfileUpdate: "DSB-ProfileUpdate-20240920",
        RegisterLoginWeb: "DSB-RegistrationLogin-20240920-captcha"
    }
};
```

Login: `/auth/log-ind/` (Danish), `/en/auth/login/` (English). Logout: `/auth/signout/`.

## Sitemap

`https://www.dsb.dk/sitemap.xml` — ~1200 URLs with daily changefreq. `robots.txt` blocks `/webformularer/`, `/rejseplan/bin/`, `/dsb-plus/redirect-til-login/`, `/netbutik/dakker-min-billet/`.

## Station List API

The only useful internal API endpoint.

**URL**: `https://www.dsb.dk/api/stations/getstationlist`
**Method**: GET
**Params**: none (server ignores `q`; the helper script filters client-side)
**Auth**: None

Returns JSON array of station objects with fields: `stationName` (Danish name), `stationUrl` (detail page URL), `stationLatitude`, `stationLongitude`, `tags` (facility tags). Always returns all ~320 stations; pass `-q` to the helper script to filter client-side (case-insensitive substring match). Danish letters preserved as UTF-8.

## Common tasks

- **Find route/price**: Use journey search form or station list API for programmatic access.
- **Look up station**: Browse `/trafikinformation/stationer/` or use station list API.
- **Check disruptions**: `/trafikinformation/` (live) or `/trafikinformation/planlagte-aendringer/` (planned).
- **Find prices**: `/priser-og-zoner/` or `/find-produkter-og-services/`.
- **Timetables**: `/trafik-information/koereplaner/`.
- **English**: Prefix any URL with `/en/`.

## Limits

- **No ticket booking API** — purchases require the website or mobile app.
- **No seat availability API** — selection happens on the result page.
- **No personal data API** — account data is session-bound to Gigya.
- **Station list API always returns all ~320 stations** — server ignores `?q=`; use `-q` with the helper script for client-side filtering.
- **No journey search API** — search form requires JavaScript.
- **No Cludo search API** — site search is client-side only.

## Helper script

`dsb_dk_api.py` (in this folder) wraps the station list API and sitemap. Standard library only.

```bash
python3 dsb_dk_api.py stations                         # all ~320 stations
python3 dsb_dk_api.py stations -q kobenhavn             # filter by name
python3 dsb_dk_api.py stations -q aarhus --raw           # raw JSON
python3 dsb_dk_api.py station-detail /trafikinformation/stationer/kobenhavn-h/
python3 dsb_dk_api.py traffic-info                      # traffic info page
python3 dsb_dk_api.py prices-zones                      # prices/zones page
python3 dsb_dk_api.py sitemap [--prefix /trafikinformation/] [--limit N]
```

Each subcommand exits non-zero on HTTP error and writes the response body to stderr.
