---
name: dmi-dk
description: DMI (Danmarks Meteorologiske Institut) weather data and forecasts. Use for querying Denmark/Greenland weather, radar-satellite images, sea conditions, warnings, and tide tables.
last-updated: 2026-05-09
---

# dmi-dk

DMI (Danmarks Meteorologiske Institut) weather data and forecasts.

## CLI SCRIPT

```bash
python3 dmi_dk_api.py <command> [options]
```

---

## ANSWERING WEATHER QUESTIONS — READ THIS FIRST

When the user asks about the weather, **always use `forecast-city`**. This command handles everything: city lookup, forecast fetching, and pretty-printed output. **Do NOT use `forecast` (national forecast) or `city-forecast` (requires a city ID) for weather questions.**

The `city` argument is **optional**. If the user does not name a city, run the command with **no city argument**. The script will auto-detect the user's city from their IP address (ip-api.com / ipinfo.io), trusting only Nordic countries (DK, NO, SE, FI). If detection fails, it falls back to København.

### The default command (user didn't specify a city)

```bash
# Auto-detect city from IP → daily forecast
python3 dmi_dk_api.py forecast-city

# This is the command you should use 90% of the time
```

### User specified a city

```bash
# Daily forecast for the named city
python3 dmi_dk_api.py forecast-city Aarhus
python3 dmi_dk_api.py forecast-city Odense
```

### Tomorrow or today

```bash
# Tomorrow's forecast (auto-detected city)
python3 dmi_dk_api.py forecast-city --tomorrow

# Today's forecast (auto-detected city)
python3 dmi_dk_api.py forecast-city --today

# Tomorrow for a specific city
python3 dmi_dk_api.py forecast-city Aarhus --tomorrow
```

### Hourly forecast

The default output is **daily aggregates**. Use `--hours N` or `--days N` for hourly data:

```bash
# Next 24 hours
python3 dmi_dk_api.py forecast-city --hours 24

# Next 3 days (hourly)
python3 dmi_dk_api.py forecast-city --days 3
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
python3 dmi_dk_api.py city-search København

# Get just the city ID
python3 dmi_dk_api.py city-search København --id-only
# → 2618425
```

### City Forecast by ID

```bash
python3 dmi_dk_api.py city-forecast 2618425
python3 dmi_dk_api.py city-forecast 2618425 --today
python3 dmi_dk_api.py city-forecast 2618425 --tomorrow
```

### National Forecast

```bash
python3 dmi_dk_api.py forecast
python3 dmi_dk_api.py forecast --days DK/land7
```

### Sea Area Forecast

```bash
python3 dmi_dk_api.py sea
```

### Weather Stations

```bash
python3 dmi_dk_api.py waters København
python3 dmi_dk_api.py texts <gid>
```

### Water Levels

```bash
python3 dmi_dk_api.py waterlevels
```

### Weather Images

```bash
python3 dmi_dk_api.py images
python3 dmi_dk_api.py images --type radar
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

- Pure Python standard library — no pip install needed.
- City names are normalised automatically: `aa` → `å`, `oe` → `ø`, `ae` → `æ`.
- Formatted output rounds all decimals to at most 2 places.
- `--today`/`--tomorrow` show a compact single-line format.
