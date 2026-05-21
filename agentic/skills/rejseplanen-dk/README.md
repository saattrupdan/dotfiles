# rejseplanen-dk

Reference for navigating rejseplanen.dk — Denmark's official public transit journey planner (rail, bus, metro, ferry, bike-share, car-share, walk). Powered by HaCon HAFAS. No login required.

## Requirements

- Internet access to `webapp.rejseplanen.dk`
- HAFAS RPC endpoint: `https://webapp.rejseplanen.dk/bin/iphone.exe`
- EU-Spirit endpoint (cross-border): `https://webapp.rejseplanen.dk/bin/eu/iphone.exe`

## Quick Start

```bash
# Route planner
open https://rejseplanen.dk/webapp/

# Station board (departures/arrivals)
open https://rejseplanen.dk/webapp/?#!P%7CSQ

# English language
# Set lang=eng in HAFAS requests

# HAFAS: location autocomplete
# POST to /bin/iphone.exe with {"svcReqL":[{"meth":"req/locSearch","req":{"reqSearch":{"stbLocReqL":[{"loc":{"name":"kobenhavn h"}}],"num":5}},"res":["locResL"]}]

# HAFAS: journey planning
# POST with meth=req/getCon, outFrwd=true, outDt=YYYYMMDD, outT=HHMMSS, locReqL=[origin,dest]

# HAFAS: station board
# POST with meth=req/getStb, stabLocReqL=[{loc:{lid:"900100101"}}], getArrivals=false
```

## Navigation Reference

### Webapp tabs

| Tab | Hash | Purpose |
|---|---|---|
| Route Planner | `#!P\|TP` | Plan a journey A→B |
| Station Board | `#!P\|SQ` | Departures/arrivals for a station |

### HAFAS RPC methods

All requests POST to `https://webapp.rejseplanen.dk/bin/iphone.exe` with `Content-Type: application/json`.

| Method | Purpose |
|---|---|
| `req/locSearch` | Location autocomplete (fast, lightweight) |
| `req/locSearchExt` | Full location autocomplete (richer data) |
| `req/getCon` | Journey planning (main query) |
| `stb/getStb` | Station board (departures/arrivals) |
| `req/getConLad` | Connection details (journey course) |
| `req/getTariff` | Fare/pricing for a connection |
| `req/getConGroups` | Cluster group definitions |
| `req/getServerDateTime` | Server time sync |
| `req/getEuSpiritRegions` | Cross-border regions |

### Key response fields

- `lid` — Location ID (primary identifier for any location)
- `conL[]` — Connections (journey options) with `dep`, `arr`, `dur`, `secL[]` (sections)
- `jnyL[]` — Journeys for station board
- Product class masks: `1`=IC, `2`=ICL, `4`=RE, `8`=train, `16`=S-tog, `32`=bus, `128`=night bus, `512`=ferry, `1024`=metro, `2048`=tram
- Language: `lang="dan"` (default), `"eng"`, `"deu"`

### Common recipes

1. **Plan a trip**: `locSearch` for origin → get `lid`, `locSearch` for dest → get `lid`, then `getCon` with both lids.
2. **Station departures**: `locSearch` for station → get `lid`, then `getStb` with `getArrivals=false`.
3. **Cross-border**: Query `getEuSpiritRegions`, then use `bin/eu/iphone.exe` endpoint.

## Troubleshooting

- **No auth required** — all queries are anonymous. No account or session.
- **Endpoint is undocumented** — the API key (`aid`) and HCI version (`1.24`) may change.
- **Real-time data included** — delays, platform changes, and cancellations are in results.
- **Tariff data** is only available for Danish domestic travel, not cross-border EU trips.
- **Max ~50 results** per query. Be reasonable with request frequency.
