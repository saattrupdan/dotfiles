---
name: dmi-dk
description: DMI (Danmarks Meteorologiske Institut) weather data and forecasts. Use for querying Denmark/Greenland weather, radar/satellite images, sea conditions, warnings, and tide tables via the internal JSON API or website.
last-updated: 2026-05-09
---

# dmi.dk — Denmark's meteorological institute

DMI is the Danish national weather service. Powered by TYPO3 CMS with a React SPA layer. All content in Danish (some English variants); no login required.

Base URL: `https://www.dmi.dk/`. URL slugs use spelled-out Danish letters: `æ`→`ae`, `ø`→`oe`, `å`→`aa`.

## Internal JSON API

Undocumented REST API at `https://www.dmi.dk/dmidk_byvejrWS/rest/`. No auth needed. All endpoints return JSON (images are binary). Responses cached with ~5 min freshness. **Always prefer API over browser automation.**

### Endpoints

#### `GET /json/Danmark/DK/land` — National forecast (3 days)
Returns meteorologist's written forecast for Denmark.
- `date` — Date of issue
- `valid` — Validity period
- `weatherForecast` — Main forecast text
- `slipperyWarning` — Road ice warning (if any)

#### `GET /json/Danmark/DK/land7` — 7-day national forecast
Extended forecast with daily sections and uncertainty assessment.
- `date`, `valid`, `headline`, `synopsis`, `weatherForecast`, `uncertainty`
- `sections[]` — Per-day forecast objects with `headline` + `weatherForecast`

#### `GET /json/Grønland/DK/land` — National forecast for Greenland
Same shape as `/land` but with Greenland regional sections (Qaanaaq, Vestgrønland, Sydgrønland, Tasiilaq, Ittoqqortoormiit).

#### `GET /json/Farvandsudsigter/<area>` — Sea area forecasts
Marine weather for Danish/Greenlandic waters. `<area>` = `Danmark` or `Gronland`.
Returns wind speed/direction, wave heights, ice conditions, fog warnings per sub-area.

#### `GET /texts/<gid>` — Shore station text forecast
Detailed XML forecast for a shore station. `gid` found via `/waters/<searchTerm>`.

#### `GET /waters/<searchTerm>` — Search weather stations
Search by name/keyword. Returns array with: `id`, `name`, `latitude`, `longitude`, `country`, `hassealevel`, `hasseatemp`, `haswave`, `hastide`.

#### `GET /location/area/<latMin>/<lonMin>/<latMax>/<lonMax>/<zoom>` — Geolocation
Returns stations within a bounding box. Response: `mapWeatherSymbols`, `mapTempSymbols`, `mapLocationLatitudes`, `mapLocationLongitudes`, `mapLocationNames`, `mapCountry`, `ids`.

#### `GET /vandstand/active` — Active water level stations
Stations reporting sea level data with statistics (`year20event`, `mlws`, `lowastrotide`, `year100event`, `year50event`).

### Image endpoints (static maps)

| Endpoint | Description |
|---|---|
| `/rest/image/gif/Radar/` | Radar (animation-ready GIF) |
| `/rest/image/png/<param>` | Weather parameter maps |
| `/rest/image/png/polarsat` | Polar satellite image |

Parameters include: `Lufttryk`, `Nedbør`, `Vind`, `Vindstød`, `Temperatur`, `RelativFugtighed`, `Skydække`, `Tåge`, `Iskoncentration`, `Bølgehøjde`, `Bølgeperiode`, `Strøm`, `Vindkraft`, `Is`, `Opstigning`, `Vandstand`, `VandstandObs`, `Badevand`. Suffixes like `24`, `48`, `72`, `120` for future periods.

### What the API does NOT cover

- **Articles/news** — server-rendered HTML at `/nyheder/<slug>`
- **Climate Atlas** — interactive tool at `/klimaatlas`; use browser automation
- **Historical measurement data** — rendered pages only
- **Site search** — server-rendered HTML at `/sog/?k=<query>`
- **Warnings** — React SPA-driven; use browser automation

## Website navigation

| Section | URL | Description |
|---|---|---|
| Varsling | `/varsler` | Weather warnings for Denmark |
| Varsler for Grønland | `/varsler-gronland` | Warnings for Greenland |
| Pollen | `/pollen` | Pollen forecast |
| UV-indeks | `/uv-indeks` | UV index forecast |
| **Vejr** | `/danmark` | Denmark weather overview |
| Danmark | `/danmark` | 7-day forecast for Denmark |
| Grønland | `/gronland` | Greenland weather |
| Færøerne | `/faeroeerne/farvandsudsigter-frn` | Faroe Islands sea forecasts |
| Forecasts in English | `/products-in-english` | English-language forecasts |
| Vejrkort | `/vejrkort` | Interactive weather maps |
| Frontkort | `/vejret/frontkort` | Front analysis maps |
| Radar | `/radar` | Weather radar |
| Satellitbilleder | `/satellitbilleder` | Satellite imagery |
| Tørke | `/toerke` | Drought monitoring |
| **Vejrdata** | `/vejrdata/maalinger` | Measurements & archives |
| Målinger | `/vejrdata/maalinger` | Current weather measurements |
| Vejrarkiv | `/vejrarkiv` | Historical weather data |
| Frie data | `/frie-data` | Free/open data |
| Publikationer | `/publikationer` | Publications & reports |
| **Hav** | `/vind` | Sea & ocean data |
| Vind | `/vind` | Wind conditions |
| Bølger | `/bolger` | Wave conditions |
| Strøm | `/strom` | Ocean currents |
| Havtemperatur | `/havtemperatur` | Sea temperature |
| Vandstand | `/vandstand` | Sea level / water level |
| Badevandstemperatur | `/badevandstemperatur` | Bathing water temperature |
| Farvandsudsigter | `/farvandsudsigter` | Sea area forecasts |
| Tidevand | `/hav-og-is/temaforside-tidevand` | Tide tables |
| Temaer om hav og is | `/hav-og-is` | Sea & ice themes |
| **Klima** | `/klimaatlas` | Climate atlas |
| Klimanormaler | `/klimanormaler` | Climate normals & extremes |
| Klima | `/klima` | Climate themes |
| **Forskning** | `/research` | Research & publications |
| Nyheder | `/nyheder` | News & articles |
| Kontakt | `/kontakt` | Contact information |

## Quick reference

| Task | Method |
|---|---|
| National forecast | `curl .../json/Danmark/DK/land` |
| 7-day forecast | `curl .../json/Danmark/DK/land7` |
| Greenland forecast | `curl .../json/Grønland/DK/land` |
| Sea area forecast | `curl .../json/Farvandsudsigter/Danmark` |
| Search stations | `curl .../waters/<city>` |
| Shore station text | `curl .../texts/<gid>` |
| Water level data | `curl .../vandstand/active` |
| Radar image | `open .../image/gif/Radar/` |
| Satellite image | `open .../image/png/polarsat` |
| Pressure map | `open .../image/png/Lufttryk` |
| City weather | Search on homepage or use `/waters/` |
| Warnings | `open /varsler` (browser automation) |
| Radar/satellite maps | `open /radar`, `/vejrkort`, `/satellitbilleder` |
| Tide tables | `open /hav-og-is/temaforside-tidevand` |
| News/articles | `open /nyheder/<year>/<slug>` |
| Climate atlas | `open /klimaatlas` (browser) |
| Climate normals | `open /klimanormaler` |
| Pollen forecast | `open /pollen` |
| UV index | `open /uv-indeks` |
| Research | `open /research`, `/research/publications` |
| Bathwater temp | `open /badevandstemperatur` |

## Local weather search

Homepage search box (`#citySearch3`) accepts city names, places, and sea areas. Location URLs follow `/<region>/<city-slug>`.

## English content

`/products-in-english` provides English versions of selected forecasts. Not all content has an English equivalent.

## Limits worth flagging

- API is undocumented and unsupported — endpoint shapes may change without notice
- Covers **forecasts and current conditions** only — no historical data, articles, or climate atlas
- Some endpoints (`/waters/`, `/location/area/`) return `204 No Content` for empty results — normal
- Image endpoints are static; use website for interactive zoom/pan
- Cookie consent banner on first visit only

## Related hosts

- `https://www.dmi.dk/dmidk_byvejrWS/` — Internal REST API base (JSON + images)
- `https://livredder.nu/webservice/rest/server.php` — Beach safety data (token visible in React bundle)
