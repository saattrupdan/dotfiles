---
name: dmi-dk
description: DMI (Danmarks Meteorologiske Institut) weather data and forecasts. Use for querying Denmark/Greenland weather, radar/satellite images, sea conditions, warnings, and tide tables.
last-updated: 2026-05-09
---

# dmi-dk

DMI (Danmarks Meteorologiske Institut) weather data and forecasts. Use for querying Denmark/Greenland weather, radar/satellite images, sea conditions, warnings, and tide tables.

## Quick Start

The easiest way to use DMI data is via the bundled CLI script:

```bash
python3 dmi_dk_api.py <command> [options]
```

### Weather Forecast for a City

The `forecast-city` command searches for a city by name and fetches its forecast in one step. **Daily output is the default** — use `--hours` or `--days` for hourly data.

```bash
# Daily forecast (default)
python3 dmi_dk_api.py forecast-city København

# Tomorrow only
python3 dmi_dk_api.py forecast-city København --tomorrow

# Today only
python3 dmi-dk_api.py forecast-city København --today

# Hourly for the next 24 hours
python3 dmi_dk_api.py forecast-city København --hours 24

# Hourly for the next 3 days
python3 dmi_dk_api.py forecast-city København --days 3

# Raw JSON
python3 dmi_dk_api.py forecast-city København --raw
```

**Auto-detect location.** If you omit the city name, the script tries to detect your city from your IP address (via ip-api.com or ipinfo.io). It only trusts results from Nordic countries (DK, NO, SE, FI).

```bash
# Try to detect your city from IP
python3 dmi_dk_api.py forecast-city

# Override auto-detected city
python3 dmi_dk_api.py forecast-city Aarhus
```

### City Search

Search for a city and get its ID (useful for scripting or debugging):

```bash
# List matching cities
python3 dmi_dk_api.py city-search København

# Get just the city ID
python3 dmi_dk_api.py city-search København --id-only
# → 2618425

# Raw JSON
python3 dmi_dk_api.py city-search København --raw
```

### City Forecast by ID

If you already have a city ID, fetch the forecast directly:

```bash
python3 dmi_dk_api.py city-forecast 2618425
python3 dmi_dk_api.py city-forecast 2618425 --daily
python3 dmi_dk_api.py city-forecast 2618425 --today
python3 dmi_dk_api.py city-forecast 2618425 --tomorrow
python3 dmi_dk_api.py city-forecast 2618425 --hours 24
python3 dmi_dk_api.py city-forecast 2618425 --raw
```

### National Forecast

```bash
# 3-day national forecast (default)
python3 dmi_dk_api.py forecast

# 7-day national forecast
python3 dmi_dk_api.py forecast --days DK/land7

# Greenland forecast
python3 dmi_dk_api.py forecast --region Grønland

# Raw JSON
python3 dmi_dk_api.py forecast --raw
```

### Sea Area Forecast

```bash
python3 dmi_dk_api.py sea
python3 dmi_dk_api.py sea --area Danmark
python3 dmi_dk_api.py sea --raw
```

### Weather Stations

```bash
# Search weather/water stations
python3 dmi_dk_api.py waters København

# Shore station text forecast (needs station gid)
python3 dmi_dk_api.py texts <gid>
python3 dmi_dk_api.py texts <gid> --raw
```

### Water Levels

```bash
# Active water level stations
python3 dmi_dk_api.py waterlevels
python3 dmi_dk_api.py waterlevels --raw
```

### Weather Images

```bash
# List available image types
python3 dmi_dk_api.py images

# Print direct URL for a specific type
python3 dmi_dk_api.py images --type radar
python3 dmi_dk_api.py images --type satellite
python3 dmi_dk_api.py images --type pressure
python3 dmi_dk_api.py images --type precipitation
python3 dmi_dk_api.py images --type wind
python3 dmi_dk_api.py images --type temperature
python3 dmi_dk_api.py images --type waves
python3 dmi_dk_api.py images --type ice
```

### Discover Endpoints

```bash
# List all API paths from the home page
python3 dmi_dk_api.py endpoints

# List all API paths from the React bundle (more endpoints)
python3 dmi_dk_api.py endpoints --bundle
```

## Arguments

### `forecast-city <city>`

Search for a city by name and get its weather forecast.

| Argument | Description |
|----------|-------------|
| `city` | City name (optional — auto-detects from IP if omitted). Accepts ASCII approximations like `kobenhavn`, `aarhu`, `aalbu` — these are normalised to æ/ø/å automatically. |
| `--hours` | Show hourly forecast for N hours (overrides daily default). |
| `--days` | Show hourly forecast for N days (each day = 24 hours). |
| `--daily` | Show daily aggregates (this is the default). |
| `--today` | Show only today's forecast. |
| `--tomorrow` | Show only tomorrow's forecast. |
| `--raw` | Print raw JSON output. |

### `city-forecast <city_id>`

Get a weather forecast for a city by its numeric ID.

| Argument | Description |
|----------|-------------|
| `city_id` | City ID (from `city-search --id-only`). |
| `--hours` | Show hourly forecast for N hours. |
| `--days` | Show hourly forecast for N days. |
| `--daily` | Show daily aggregates. |
| `--today` | Show only today's forecast. |
| `--tomorrow` | Show only tomorrow's forecast. |
| `--raw` | Print raw JSON output. |

### `city-search <city>`

Search for a city by name and list matching results.

| Argument | Description |
|----------|-------------|
| `city` | City name to search for. |
| `--id-only` | Print only the first matching city ID. |
| `--raw` | Print raw JSON output. |

## Notes

- The script uses only the Python standard library — no external dependencies.
- City names are normalised automatically: `aa` → `å`, `oe` → `ø`, `ae` → `æ`.
- All numeric values in the formatted output are rounded to at most 2 decimal places.
- The `--today`/`--tomorrow` flags filter the daily table to show only the matching day, using a compact single-line format.
