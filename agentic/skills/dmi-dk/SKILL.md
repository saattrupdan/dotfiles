---
name: dmi-dk
description: DMI (Danmarks Meteorologiske Institut) weather data and forecasts. Use to get weather forecasts, radar-satellite images, sea conditions, warnings, and tide tables.
last-updated: 2026-05-09
---

# dmi-dk

DMI (Danmarks Meteorologiske Institut) weather data and forecasts.

## CLI

All interaction goes through the `dmi` CLI — it can be run from anywhere, with
no need to point at the skill directory:

```bash
dmi <command> [options]
```

### Prerequisites

Verify the CLI is installed:

```bash
which dmi
```

If missing, install it editable with pipx (from the skill directory). First
make sure pipx itself is available, then install:

```bash
# Ensure pipx is installed
which pipx || python3 -m pip install --user pipx
python3 -m pipx ensurepath

# Install the dmi CLI
pipx install -e <path-to-dmi-dk-skill>
```

After installing, confirm `dmi` is on the PATH (you may need to restart the
shell so `pipx ensurepath` takes effect):

```bash
which dmi
```

Pure Python standard library — no extra dependencies.

---

## ANSWERING WEATHER QUESTIONS — READ THIS FIRST

When the user asks about the weather, **always use `forecast-city`**. This command handles everything: city lookup, forecast fetching, and pretty-printed output. **Do NOT use `forecast` (national forecast) or `city-forecast` (requires a city ID) for weather questions.**

The `city` argument is **optional**. If the user does not name a city, run the command with **no city argument**. The CLI auto-detects the user's city and country from their IP address (ipinfo.io, falling back to ipwho.is) and fetches that city's forecast — anywhere in the world, not just Denmark. If detection fails, it falls back to København.

### The default command (user didn't specify a city)

```bash
# Auto-detect city from IP → daily forecast
dmi forecast-city

# This is the command you should use 90% of the time
```

### User specified a city

```bash
# Daily forecast for the named city
dmi forecast-city Aarhus
dmi forecast-city Odense
```

### Tomorrow or today

```bash
# Tomorrow's forecast (auto-detected city)
dmi forecast-city --tomorrow

# Today's forecast (auto-detected city)
dmi forecast-city --today

# Tomorrow for a specific city
dmi forecast-city Aarhus --tomorrow
```

### Hourly forecast

The default output is **daily aggregates**. Use `--hours N` or `--days N` for hourly data:

```bash
# Next 24 hours
dmi forecast-city --hours 24

# Next 3 days (hourly)
dmi forecast-city --days 3
```

### City name input

Accepts ASCII approximations — `aa` → `å`, `oe` → `ø`, `ae` → `æ` are normalised automatically. So `kobenhavn`, `aarhu`, `aalbu` all work.

### Sample output

```
Vejrprognose for København (DK)
Opdateret: 2026-05-09 17:37:36
Solopgang: 05:10  Solnedgang: 21:02

 Uge     Dato   Min   Max   Nedbør       Vind   UV
----------------------------------------------------
 lør    09-05    11    15      0.0 2.6 m/s Syd  4.4
 søn    10-05     9    15     2.32 2.2 m/s SØ  4.5
 man    11-05     9    12     2.53 1.8 m/s Øst  4.0
```

Or with `--tomorrow`:

```
Vejrprognose for København (DK)
Opdateret: 2026-05-09 17:37:36
Solopgang: 05:10  Solnedgang: 21:02

I morgen (søn 10-05):
  Temperatur: 9–15 °C  Nedbør: 2.32 mm  Vind: 2.2 m/s SØ  UV: 4.5 (Moderat — beskyttelse anbefales)
```

---

## OTHER COMMANDS (rarely needed for weather questions)

### City Search

```bash
# List matching cities
dmi city-search København

# Get just the city ID
dmi city-search København --id-only
# → 2618425
```

### City Forecast by ID

```bash
dmi city-forecast 2618425
dmi city-forecast 2618425 --today
dmi city-forecast 2618425 --tomorrow
```

### National Forecast

```bash
dmi forecast
dmi forecast --days DK/land7
```

### Sea Area Forecast

```bash
dmi sea
```

### Weather Stations

```bash
dmi waters København
dmi texts <gid>
```

### Water Levels

```bash
dmi waterlevels
```

### Weather Images

```bash
dmi images
dmi images --type radar
# Also: satellite, pressure, precipitation, wind, temperature, waves, ice
```

---

## ARGUMENTS REFERENCE

### `forecast-city [city]`

| Argument | Description |
|----------|-------------|
| `city` | City name (**optional** — auto-detects from IP if omitted) |
| `--hours` | Hourly forecast for N hours |
| `--days` | Hourly forecast for N days (each day = 24 hours) |
| `--daily` | Daily aggregates (**default**) |
| `--today` | Today only |
| `--tomorrow` | Tomorrow only |
| `--raw` | Raw JSON |

### `city-forecast <city_id>`

| Argument | Description |
|----------|-------------|
| `city_id` | City ID from `city-search --id-only` |
| `--hours` / `--days` | Hourly forecast |
| `--daily` | Daily aggregates |
| `--today` / `--tomorrow` | Single day |
| `--raw` | Raw JSON |

### `city-search <city>`

| Argument | Description |
|----------|-------------|
| `city` | City name to search for |
| `--id-only` | Print only the first matching city ID |
| `--raw` | Raw JSON |

---

## NOTES

- Pure Python standard library — no extra dependencies.
- City names are normalised automatically: `aa` → `å`, `oe` → `ø`, `ae` → `æ`.
- English exonyms are translated to the Danish names DMI indexes (e.g.
  `Copenhagen` → `København`) for Danish locations, and IP auto-detection
  picks the city in the detected country so a foreign namesake (e.g. a US
  town called Copenhagen) is never used.
- Formatted output rounds all decimals to at most 2 places.
- `--today`/`--tomorrow` show a compact single-line format.
