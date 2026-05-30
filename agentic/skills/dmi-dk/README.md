# dmi-dk

Reference for navigating dmi.dk — Denmark's national meteorological institute (Danmarks Meteorologiske Institut).

## Requirements

- Internet access to `www.dmi.dk`
- No authentication needed — all data is public
- Python 3 for the CLI helper (standard library only)

## Quick Start

```bash
# Browse the DMI website
open https://www.dmi.dk/

# Get national weather forecast via API
curl -s https://www.dmi.dk/dmidk_byvejrWS/rest/json/Danmark/DK/land

# View radar map
open https://www.dmi.dk/radar

# Read DMI news
open https://www.dmi.dk/nyheder/
```

### CLI

The `dmi` CLI provides convenient one-liners for common tasks. Install it
editable with pipx (`pipx install -e <path-to-dmi-dk-skill>`), then run it from
anywhere:

```bash
# Search for a city
dmi city-search København

# Get a city's weather forecast (search + forecast in one command)
dmi forecast-city København

# Get just the city ID
dmi city-search København --id-only

# Show daily aggregates instead of hourly
dmi forecast-city København --daily

# Limit to N hours
dmi forecast-city København --hours 24

# Raw JSON output
dmi city-search København --raw
dmi city-forecast 2618425 --raw
```

The script also supports the existing commands:
```bash
# National weather forecast
dmi forecast

# Sea area forecast
dmi sea --area Danmark

# Search weather stations
dmi waters "København"

# Water level stations
dmi waterlevels

# Weather images
dmi images
dmi images --type radar

# Shore station text forecast
dmi texts <gid>
```

## Navigation Reference

### Top-level sections

| Section | URL |
|---|---|
| Varsling (warnings) | `/varsler` |
| Vejr (weather) | `/danmark` |
| Vejrdata (measurements) | `/vejrdata/maalinger` |
| Hav (sea) | `/vind` |
| Klima (climate) | `/klimaatlas` |
| Forskning (research) | `/research` |
| Nyheder (news) | `/nyheder` |
| Kontakt | `/kontakt` |

### Key patterns

| Pattern | Description |
|---|---|
| `/varsler` | Weather warnings |
| `/danmark/7doegnsudsigt-dk` | 7-day forecast |
| `/vejrkort` | Interactive weather maps |
| `/radar` | Weather radar |
| `/farvandsudsigter` | Sea area forecasts |
| `/klimaatlas` | Climate atlas |
| `/nyheder/<year>/<slug>` | Individual news articles |

## API Quick Reference

| Endpoint | Description |
|---|---|
| `/dmidk_byvejrWS/rest/json/Danmark/DK/land` | National forecast (3 days) |
| `/dmidk_byvejrWS/rest/json/Danmark/DK/land7` | 7-day forecast |
| `/dmidk_byvejrWS/rest/json/Grønland/DK/land` | Greenland forecast |
| `/dmidk_byvejrWS/rest/json/Farvandsudsigter/<area>` | Sea forecasts |
| `/dmidk_byvejrWS/rest/waters/<search>` | Search weather stations |
| `/dmidk_byvejrWS/rest/vandstand/active` | Active water level stations |
| `/dmidk_byvejrWS/rest/image/gif/Radar/` | Radar image |
| `/dmidk_byvejrWS/rest/image/png/<param>` | Weather parameter maps |
| `/solr/city_core/select?wt=json&q={query}` | Search cities by name (returns Solr docs with IDs) |
| `/NinJo2DmiDk/ninjo2dmidk?cmd=llj&id={id}` | Get NinJo forecast for a city by ID |

## Troubleshooting

- **API returns empty or 204** — The endpoint may not support that query. Check the SKILL.md for valid parameters.
- **City search not working** — Try the station search endpoint with the city name: `/waters/<cityname>`.
- **Images not loading** — Direct image URLs work; interactive maps require the website.
- **Danish letters in URLs** — Spell out `æ`→`ae`, `ø`→`oe`, `å`→`aa` for website URLs. The API accepts UTF-8.
