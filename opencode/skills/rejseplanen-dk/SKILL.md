---
name: rejseplanen-dk
description: rejseplanen.dk — Denmark's public transit journey planner (rail, bus, metro, ferry, bike-share, car-share, walk). Powered by HaCon HAFAS. Use when planning trips in Denmark, looking up station departures, or programmatically querying the HAFAS backend API.
last-updated: 2026-05-09
---

# rejseplanen.dk — Danish transit journey planner

Powered by **HaCon HAFAS**. No login required; all queries anonymous and free.

**Base URL:** `https://webapp.rejseplanen.dk/`
**HAFAS mgate:** `https://webapp.rejseplanen.dk/bin/iphone.exe`
**EU-Spirit (cross-border):** `https://webapp.rejseplanen.dk/bin/eu/iphone.exe`

## Webapp overview

Single-page app with two tabs: **Route Planner** (`#!P|TP`) for A→B journey planning and **Station Board** (`#!P|SQ`) for station timetables.

Location autocomplete supports: stations, addresses, POIs, and lat/lon coordinates.

## HAFAS RPC API

Undocumented RPC endpoint powering the webapp. Always prefer this over scraping — clean JSON, batchable, faster.

### Endpoint

```
POST https://webapp.rejseplanen.dk/bin/iphone.exe
Content-Type: application/json
```

### Common envelope

Every request wraps method calls in `svcReqL[]` with `ver`, `ext`, `auth`, `lang`, `client`, and `formatted`. Responses nest under `svcResL[]`. On error, `err` ≠ "OK" and `errTxt` has the message.

```json
{
  "ver": "1.24", "ext": "DK.11",
  "auth": {"type": "AID", "aid": "j1sa92pcj72ksh0-web"},
  "lang": "dan", "client": {"id": "DK", "type": "WEB", "name": "rejseplanwebapp"},
  "formatted": false,
  "svcReqL": [{"meth": "req/<method>", "req": {…}, "res": ["field"]}]
}
```

### Supported methods

| Method | Purpose | Key request params | Key response fields |
|---|---|---|---|
| `req/getServerDateTime` | Clock sync | `{}` | `srvResL[0].sD`, `sT` |
| `loc/SearchExt` | Full location autocomplete | `reqSearchExt` | `locResL[].loc[].lid`, `name`, `type`, `coord` |
| `loc/Search` | Lightweight autocomplete | `reqSearch` | Same as above, fewer fields |
| `req/GetCon` | Journey planning | `reqConReq` | `conL[]`, `himMsgL[]` |
| `stb/GetStboard` | Station departures/arrivals | `reqStb` | `jnyL[]`, `stopL[]` |
| `req/GetConLad` | Connection details (course) | `reqConLad` | `secL[]`, `gis`, `stopL` |
| `req/GetTariff` | Fare/pricing for a connection | `reqTariff` | `tariffInfoBoxGroupL` |
| `req/getEuSpiritRegions` | Cross-border regions | `{}` | `euspRegL[]` |
| `req/getConGroups` | Cluster group definitions | `{}` | `conGrpL[]`, `common` |

#### `loc/Search` — Location autocomplete

Fastest autocomplete for From/To fields.

**Params:** `reqSearch.stbLocReqL[0].loc.name` (search string), `num` (max results).

**Response:** Array of locations with `lid` (primary ID), `name`, `type` (`sta`/`adress`/`poi`), `coord` (OSGP3031 projected meters), `dist` (meters from search center).

#### `loc/SearchExt` — Full location autocomplete

Same interface as `loc/Search` but returns more fields (product classes, nearby stations).

#### `req/GetCon` — Journey planning

Finds connections between two locations.

**Key params:** `outFrwd` (true=departure, false=arrival), `outDt`/`outT` (date YYYYMMDD, time HHMMSS), `locReqL[]` (origin + destination, use `lid`), `num` (results, max ~50), `productFilter` (transport type masks), `getGIS` (include GPS for map), `getConLad` (include sections/stops), `getTariff` (include fares), `bikeFlag` (1=bike, 2=bike+PT), `walkMLimit` (max walk meters), `ptSc` (product class shortcut, 0=all), `sChL` (exclude lines), `sccL` (exclude connections).

**Response:** `conL[]` array of connections, each with `id`, `date`, `dep`/`arr` (location + time), `dur` (minutes), `prod` (product mask), `tag` (cluster: PT/BIKE/WALK/CAR), `secL[]` (sections: walk/pt/transfer), `line` (name, prod, prodT, number), `stopL[]`, `gis` (GPS segL for maps), `trfRes` (fare data), `himMsgs` (disturbances).

#### `stb/GetStboard` — Station board

Departures or arrivals for a station.

**Key params:** `stabLocReqL` (location, use `lid`), `maxJny` (max results), `getArrivals` (true=arrivals, false=departures), `getPlatform`, `getDelay`, `getDisturbance`/`getMessages`.

**Response:** `jnyL[]` journeys with line, destination, time, delay, platform.

#### `req/GetConLad` — Connection details

Loads detailed section data for a specific connection (journey course).

**Key params:** `conId` (from `conL[].id`), `conIdx` (index, usually 0), `getGIS`, `getConLadSec`, `getOccupancy`.

#### `req/GetTariff` — Tariff/pricing

Gets fare information for a connection.

**Key params:** `conId`, `ctxRecon` (base64-encoded recon data), `getTariff`, `getTariffExt`, `getTariffInfoBox`, `getTariffFilter`.

#### `req/getConGroups` — Cluster groups

Returns cluster/group definitions used in the route planner UI. Call first to discover available cluster types.

#### `req/getEuSpiritRegions` — Cross-border regions

Gets available cross-border regions (Scania, Germany, EU).

## Product class masks

| Bit | Mask | Product | Icon class |
|---|---|---|---|
| 1 | `1` | Intercity (IC, ICL) | `haf_prod_fern` |
| 2 | `2` | Lyn Tog (ICL) | `haf_prod_fern` |
| 4 | `4` | Regional train (RE) | `haf_prod_fern` |
| 8 | `8` | Other trains (TOG) | `haf_prod_fern` |
| 16 | `16` | S-train (STOG) | `haf_prod_sbahn` |
| 32 | `32` | Bus | `haf_prod_bus` |
| 64 | `64` | Express bus (SBUS) | `haf_prod_bus` |
| 128 | `128` | Night bus (NBUS) | `haf_prod_bus` |
| 256 | `256` | Other bus (DIVBUS) | `haf_prod_bus` |
| 512 | `512` | Ferry (SHIP) | `haf_prod_ship` |
| 1024 | `1024` | Metro (METRO) | `haf_prod_metro` |
| 2048 | `2048` | Tram (TRAM) | `haf_prod_letbane` |

Masks combine as bitmasks. `prod` in results is a bitmask.

## Common recipes

1. **Plan a trip:** `loc/Search` origin + destination → extract `lid` values → `req/GetCon` with both lids, `outFrwd: true`, date/time. Results in `conL[]`.
2. **Station departures:** `loc/Search` for station → `stb/GetStboard` with lid, `getArrivals: false`. Results in `jnyL[]`.
3. **Coords to location:** `loc/SearchExt` with `reqSearchExt.geoLocReq` containing `x`, `y` (OSGP3031).
4. **Cross-border:** `req/getEuSpiritRegions` → set `euSpirit` mode with region ID in `reqConReq` → endpoint switches to `bin/eu/iphone.exe`.

## Limits and caveats

- No auth, no accounts, no personal data.
- Be reasonable with calls; max ~50 results per query.
- Undocumented endpoint — `aid`, HCI version (`1.24`), and extension (`DK.11`) may break on backend updates.
- Real-time data (delays, platform changes, cancellations) included in `GetCon` and `GetStboard`. Data from DSB, Movia, Metroselskabet, etc.
- **DK.11 extension** enables Danish-specific features: Rejsekort pricing, tariff zones, bike-share (Bycyklen, Donkey Republic, ShareNow).
- Tariff data requires `getTariff: true`; only for Danish domestic travel (not cross-border).
