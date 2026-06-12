---
name: transport-dk
description: Danish public transport via the `transport` CLI — plan routes, read live station departures, look up disruptions and planned schedule changes, browse ticket products, and search transport Q&A. Merges Rejseplanen (journey engine), DSB, Copenhagen Metro (m.dk) and dinoffentligetransport.dk. Use for any Danish transit lookup. Buying tickets is out of scope.
last-updated: 2026-05-30
---

# transport-dk

One CLI for Danish public transport, spanning trains (DSB), buses (Movia),
Metro and light rail. The journey engine is **Rejseplanen**'s HaCon **HAFAS**
RPC API (the same backend the rejseplanen.dk webapp uses); disruptions also pull
from **dinoffentligetransport.dk**, and content search uses the **m.dk** (Metro)
Ankiro index.

All data is anonymous and free. **Buying tickets is intentionally not
supported** — that requires MitID and the operators' own apps.

## CLI

```bash
transport <command> [options]
```

### Prerequisites

```bash
which transport || pipx install -e <path-to-this-skill>   # install the CLI
```

Standard library only — no third-party dependencies. Every command takes
`--json` for the raw upstream JSON, and exits non-zero on HTTP/API errors.

## Commands

| Command | What it does |
| --- | --- |
| `transport route FROM TO [--date YYYY-MM-DD] [--time HH:MM] [--arrive] [--only P…] [-n N]` | Plan a journey A→B with legs, times, platforms, transfers |
| `transport departures STATION [--arrivals] [--date] [--time] [-n N]` | Live station board with real-time delays |
| `transport stations QUERY [-n N]` | Resolve a place name to stations/addresses/POIs |
| `transport changes [--no-bus] [-n N]` | Disruptions (Rejseplanen HIM) + planned bus schedule changes |
| `transport tickets [--operator dsb\|metro\|movia\|all]` | Curated ticket-product reference with official links |
| `transport search QUERY [-n N]` | Transport content Q&A (m.dk Metro index) |

### Routes

```bash
transport route "København H" "Aarhus H"
transport route "Nørreport" "Lufthavnen" --time 08:30
transport route "Odense St." "Esbjerg St." --arrive --time 17:00
transport route "Vanløse" "Vestamager" --only metro      # restrict products
```

Place names are resolved with the same matcher as `stations`; if a name is
ambiguous the first match wins, so disambiguate via `transport stations` first.
`--only` accepts any of: `ic lyn re train stog bus expressbus nightbus otherbus
ferry metro tram` (space-separated, combined as a HAFAS product bitmask).

### Departures

```bash
transport departures "Nørreport"            # next ~15 departures, with delays
transport departures "Aarhus H" --arrivals  # arrival board
```

Real-time predictions appear as `(real HH:MM)` when they differ from the
scheduled time.

### Changes / disruptions

```bash
transport changes                # HIM disruptions + bus schedule changes
transport changes --no-bus       # only the nationwide Rejseplanen HIM feed
```

### Tickets & search

```bash
transport tickets --operator dsb     # DSB products + shared products
transport search "cykel"             # search Metro content / FAQs
transport search "elevator" --json
```

## What this replaces

Supersedes the separate `rejseplanen-dk`, `dsb-dk`, `m-dk`, and
`dinoffentligetransport-dk` skills. The reference material previously in those
skills now lives here:

- **Rejseplanen HAFAS** is the journey/departures/disruptions engine (`route`,
  `departures`, `stations`, `changes`).
- **dinoffentligetransport.dk** `/api/BusLines/schedulechanges` and
  `/api/transportationChanges` feed the bus side of `changes`.
- **DSB** ticket products and **Metro** info feed `tickets`.
- **m.dk** Ankiro search powers `search`.

## How it works / robustness notes

- **HAFAS** is called at `https://webapp.rejseplanen.dk/bin/iphone.exe` with the
  `aid` `j1sa92pcj72ksh0-web`, HCI version `1.24`, extension `DK.11`. If
  Rejseplanen rotates these, update the constants at the top of
  `transport_dk/main.py`. Methods used: `LocMatch`, `TripSearch`,
  `StationBoard`, `HimSearch`.
- HAFAS times are `HHMMSS` with an optional leading **day offset** for journeys
  that cross midnight; the CLI renders these as `HH:MM (+1d)`.
- `search` covers the **Metro** content index only — it's the one public,
  structured transport content-search API. For journeys/stops use `route` and
  `departures`, not `search`.
- `tickets` is a **curated pointer list** (no live API for fares); buying always
  happens in the operators' apps.

## Limits

- No ticket purchase, seat reservation, or personal-account data (all need MitID
  / operator apps).
- No fare/price calculation — HAFAS tariff data is not exposed by this CLI.
- Undocumented endpoints; they can change without notice.
