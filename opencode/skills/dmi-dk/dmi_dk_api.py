#!/usr/bin/env python3
"""CLI helper for DMI (Danmarks Meteorologiske Institut) internal APIs.

Standard library only. See ./SKILL.md for endpoint specs.
"""
from __future__ import annotations

import argparse
import datetime
import json
import re
import sys
import typing as t
import urllib.error
import urllib.parse
import urllib.request

BASE = "https://www.dmi.dk"
API = BASE + "/dmidk_byvejrWS/rest"
UA = "Mozilla/5.0 (dmi-dk-api-cli)"

WEEKDAYS_DK = ["man", "tir", "ons", "tor", "fre", "lør", "søn"]

# Maps ASCII approximations to their proper Danish æ, ø, å equivalents.
DIACRITIC_MAP: dict[str, str] = {
    "aa": "\u00e5",
    "oe": "\u00f8",
    "ae": "\u00e6",
    "\u00e5": "\u00e5",
    "\u00f8": "\u00f8",
    "\u00e6": "\u00e6",
}


def _normalize_danish(text: str) -> str:
    """Normalize Danish city names so that æ/ø/å are in their proper form.

    The DMI Solr API indexes cities with their canonical names (æ, ø, å).
    Users often type ASCII approximations like "kobenhavn" or "aarhus".
    This function normalises the input so the Solr query matches.
    """
    lower = text.lower()
    # Apply known mappings in priority order (longer keys first)
    for ascii_form, danish_char in {
        "\u00e5": "\u00e5",
        "\u00f8": "\u00f8",
        "\u00e6": "\u00e6",
        "aa": "\u00e5",
        "oe": "\u00f8",
        "ae": "\u00e6",
    }.items():
        lower = lower.replace(ascii_form, danish_char)
    return lower


def _build_city_query(city: str) -> str:
    """Build the boosted ngram Solr query used by dmi.dk's front-end.

    The DMI Solr index uses ``name_ngram`` for partial matching. A plain
    ``"city"`` exact-match query fails for most Danish city names because
    the Solr schema does not store the ``name`` field as a single token.
    """
    norm = _normalize_danish(city)
    q = (
        f'name:"{urllib.parse.unquote(norm)}"^8 OR '
        f'(name_ngram:"{urllib.parse.unquote(norm)}" AND realm:1)^2 OR '
        f'(name_ngram:"{urllib.parse.unquote(norm)}" AND realm:1 AND '
        f'population:[1 TO *])^4 OR '
        f'(name_ngram:"{urllib.parse.unquote(norm)}")'
    )
    return q


def _city_solr_url(city: str, rows: int = 10) -> str:
    """Return a fully-encoded Solr search URL for a city name."""
    q = _build_city_query(city)
    params = urllib.parse.urlencode({
        "wt": "json",
        "q": q,
        "rows": str(rows),
        "sort": "score desc,realm desc,population desc",
    })
    return f"https://www.dmi.dk/solr/city_core/select?{params}"


def _ninjo_url(city_id: int) -> str:
    """Return a fully-encoded NinJo forecast URL."""
    return (
        f"https://www.dmi.dk/NinJo2DmiDk/ninjo2dmidk"
        f"?cmd=llj&id={city_id}"
    )


def _request_with_referer(url: str) -> t.Any:
    """Fetch JSON from a URL that requires a Referer header."""
    h: dict[str, str] = {
        "User-Agent": UA,
        "Accept": "application/json",
    }
    req = urllib.request.Request(url, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            text = r.read().decode("utf-8", errors="replace")
            if not text.strip():
                return None
            return json.loads(text)
    except urllib.error.HTTPError as e:
        body_text = e.read() if e.fp else b""
        sys.stderr.write(
            f"HTTP {e.code} {e.reason} on GET {url}\n")
        if body_text:
            sys.stderr.write(
                body_text.decode("utf-8", errors="replace").rstrip()
                + "\n")
        return None


def _geo_locate() -> str | None:
    """Try to determine the user's city from their IP address.

    Tries several free geolocation services. Returns the city name
    or None if detection fails.
    """
    candidates: list[str] = []
    for url in [
        "https://ip-api.com/json/?fields=query,city,countryCode",
        "https://ipinfo.io/json",
    ]:
        try:
            h: dict[str, str] = {"User-Agent": UA}
            req = urllib.request.Request(url, headers=h)
            with urllib.request.urlopen(req, timeout=5) as r:
                data = json.loads(r.read().decode("utf-8"))
        except Exception:  # noqa: BLE001
            continue

        # ip-api.com returns {"query": "...", "city": "...", "countryCode": "..."}
        if "city" in data and data["city"]:
            city = data["city"].lower()
            cc = data.get("countryCode", "")
            # Only trust Danish/Nordic cities
            if cc in ("DK", "NO", "SE", "FI"):
                return city
            candidates.append(city)

        # ipinfo.io returns {"ip": "...", "city": "...", "loc": "...", ...}
        if "city" in data and data["city"]:
            city = data["city"].lower()
            loc = data.get("loc", "")
            if loc:
                _, lat, lon = loc.split(",", 2)
                lat_f = float(lat)
                # Denmark roughly 54-58N
                if 54 <= lat_f <= 58:
                    return city
            candidates.append(city)

    # Fallback: pick the first candidate anyway
    if candidates:
        return candidates[0]

    return None


def _request(
    path: str,
    method: str = "GET",
    body: bytes | None = None,
    extra_headers: dict[str, str] | None = None,
) -> tuple[int, bytes]:
    url = path if path.startswith("http") else API + path
    # Percent-encode non-ASCII in path for urllib
    parsed = urllib.parse.urlparse(url)
    encoded_path = urllib.parse.quote(
        parsed.path, safe="/?=&-.")
    url = urllib.parse.urlunparse((
        parsed.scheme,
        parsed.netloc,
        encoded_path,
        parsed.params,
        parsed.query,
        parsed.fragment,
    ))
    h: dict[str, str] = {
        "User-Agent": UA,
        "Accept": "application/json",
    }
    if extra_headers:
        h.update(extra_headers)
    req = urllib.request.Request(
        url, method=method, headers=h, data=body)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        body_text = e.read() if e.fp else b""
        sys.stderr.write(
            f"HTTP {e.code} {e.reason} on "
            f"{method} {path}\n")
        if body_text:
            sys.stderr.write(
                body_text.decode("utf-8", errors="replace")
                .rstrip() + "\n")
        sys.exit(2)


def _request_json(
    path: str,
    method: str = "GET",
    body: bytes | None = None,
) -> t.Any:
    _, raw = _request(path, method=method, body=body)
    text = raw.decode("utf-8", errors="replace")
    if not text.strip():
        return None
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return text


def _emit_json(obj: t.Any) -> None:
    print(json.dumps(obj, ensure_ascii=False, indent=2))


def _emit_text(text: str) -> None:
    print(text)


def _format_date(date_str: str) -> str:
    """Format a YYYYMMDD string as DD-MM (e.g. '09-05')."""
    if not date_str or len(date_str) < 8:
        return date_str
    return f"{date_str[6:8]}-{date_str[4:6]}"


def _format_weekday(date_str: str) -> str:
    """Return the Danish weekday abbreviation for a YYYYMMDD string."""
    if not date_str or len(date_str) < 8:
        return ""
    try:
        dt = datetime.date(
            int(date_str[0:4]),
            int(date_str[4:6]),
            int(date_str[6:8]),
        )
        return WEEKDAYS_DK[dt.weekday()]
    except (ValueError, IndexError):
        return ""


def _nice_precip(val: t.Any) -> str:
    """Format precipitation value nicely, rounded to 2 decimals."""
    if val == "" or val is None:
        return "-"
    try:
        f = float(val)
        if f < 0.05:
            return "0.0"
        return f"{f:.2f}".rstrip("0").rstrip(".")
    except (ValueError, TypeError):
        return str(val)


def _print_daily_table(
    agg_data: list[dict],
    only_today: bool = False,
    only_tomorrow: bool = False,
) -> None:
    """Print a formatted daily weather table.

    Args:
        agg_data:
            List of daily aggregate dicts from the forecast API.
        only_today:
            If True, show only today's row.
        only_tomorrow:
            If True, show only tomorrow's row.
    """
    today = datetime.date.today()
    tomorrow = today + datetime.timedelta(days=1)

    filtered: list[dict] = []
    for day in agg_data:
        # The DMI API uses "time" for the date in aggData, not "date"
        raw_date = day.get("date", day.get("time", ""))
        if not raw_date or len(raw_date) < 8:
            continue
        try:
            day_date = datetime.date(
                int(raw_date[0:4]),
                int(raw_date[4:6]),
                int(raw_date[6:8]),
            )
        except (ValueError, IndexError):
            continue

        if only_today and day_date != today:
            continue
        if only_tomorrow and day_date != tomorrow:
            continue

        filtered.append(day)

    # Show header only if we have rows to display
    if not filtered:
        print("(no forecast data for this period)")
        return

    if only_today or only_tomorrow:
        # Single-day compact format
        day = filtered[0]
        raw_date = day.get("date", day.get("time", ""))
        wd = _format_weekday(raw_date)
        fmt = _format_date(raw_date)
        min_t = day.get("minTemp", "")
        max_t = day.get("maxTemp", "")
        precip = _nice_precip(day.get("precipSum", ""))
        uv = day.get("uvRadiation", "")

        label = "I dag" if only_today else "I morgen"
        print(f"\n{label} ({wd} {fmt}):")
        print(f"  Temperatur: {min_t}\u2013{max_t} \u00b0C  "
              f"Nedb\u00f8r: {precip} mm  "
              f"UV: {uv}")
    else:
        # Multi-day table
        print(
            f"{'Uge':>4} {'Dato':>8} "
            f"{'Min':>5} {'Max':>5} "
            f"{'Nedb\u00f8r':>8} {'UV':>4}")
        print("-" * 40)
        for day in filtered:
            raw_date = day.get("date", day.get("time", ""))
            wd = _format_weekday(raw_date)
            fmt = _format_date(raw_date)
            min_t = day.get("minTemp", "")
            max_t = day.get("maxTemp", "")
            precip = _nice_precip(day.get("precipSum", ""))
            uv = day.get("uvRadiation", "")
            print(
                f"{wd:>4} {fmt:>8} "
                f"{str(min_t):>5} {str(max_t):>5} "
                f"{precip:>8} {str(uv):>4}")


def _fmt(val: t.Any, fmt: str = ".2f") -> str:
    """Round a numeric value to the given format (default 2 decimals).

    Returns '-' for missing/empty values. Strips trailing zeros and
    the trailing dot so that '0' stays '0', '1.5' stays '1.5', and
    '3.14' stays '3.14'.
    """
    if val is None or val == "":
        return "-"
    try:
        result = f"{float(val):{fmt}}"
        # Strip trailing zeros
        if "." in result:
            result = result.rstrip("0").rstrip(".")
        return result
    except (ValueError, TypeError):
        return str(val)


def _format_temp(val: t.Any) -> str:
    """Format temperature as integer (no decimals needed for °C)."""
    if val is None or val == "":
        return "-"
    try:
        return f"{round(float(val))}"
    except (ValueError, TypeError):
        return str(val)


def _format_wind(val: t.Any) -> str:
    """Format wind speed to 1 decimal place."""
    return _fmt(val, ".1f")


def _format_humid(val: t.Any) -> str:
    """Format humidity as integer (percentage)."""
    if val is None or val == "":
        return "-"
    try:
        return f"{round(float(val))}"
    except (ValueError, TypeError):
        return str(val)


def _format_vis(val: t.Any) -> str:
    """Format visibility in km, rounded to nearest whole km."""
    if val is None or val == "":
        return "-"
    try:
        km = float(val) / 1000
        if km >= 100:
            return ">100"
        return f"{round(km)}"
    except (ValueError, TypeError):
        return str(val)


def _print_hourly_table(
    timeseries: list[dict],
    hours: int | None = None,
) -> None:
    """Print a formatted hourly weather table.

    Args:
        timeseries:
            Hourly forecast entries from the API.
        hours:
            Number of hours to display, or None for all.
    """
    sample = timeseries[:hours] if hours else timeseries
    if not sample:
        print("(no hourly forecast data)")
        return

    print(
        f"{'Tid':>16} {'Temp':>6} {'Vind':>6} "
        f"{'Kast':>6} {'Luftfugt.':>9} {'Nedb\u00f8r':>7} "
        f"{'Sigthed':>8}")
    print("-" * 72)
    for entry in sample:
        iso_time = entry.get("localTimeIso", "")
        temp = _format_temp(entry.get("temp", ""))
        wind_speed = _format_wind(entry.get("windSpeed", ""))
        wind_gust = _format_wind(entry.get("windGust", ""))
        humidity = _format_humid(entry.get("humidity", ""))
        precip = _nice_precip(entry.get("precip1", ""))
        vis = _format_vis(entry.get("visibility", ""))

        if iso_time:
            try:
                time_part = iso_time[11:16]
            except (IndexError, TypeError):
                time_part = iso_time
        else:
            time_part = ""

        print(
            f"{time_part:>16} {temp:>6} "
            f"{wind_speed:>6} {wind_gust:>6} "
            f"{humidity:>9} {precip:>7} "
            f"{vis:>8}")


def _print_header(
    city: str,
    country: str,
    last_update: str,
    sunrise: str,
    sunset: str,
) -> None:
    """Print the forecast header block."""
    print(f"Wejrprognose for {city} ({country})")
    if last_update:
        print(
            f"Opdateret: {last_update[:4]}-"
            f"{last_update[4:6]}-{last_update[6:8]} "
            f"{last_update[8:10]}:{last_update[10:12]}:"
            f"{last_update[12:14]}")
    if sunrise or sunset:
        print(
            f"Solopgang: {sunrise[:2]}:{sunrise[2:]}  "
            f"Solnedgang: {sunset[:2]}:{sunset[2:]}")
    print()


def cmd_forecast(args: argparse.Namespace) -> None:
    """Get national weather forecast for Denmark."""
    region_map = {
        "Danmark": "Danmark",
        "Gronland": "Gr\u00f8nland",
    }
    region = (
        region_map.get(args.region, args.region)
        or "Danmark")
    days = args.days or "DK/land"
    path = f"/json/{region}/{days}"
    data = _request_json(path)
    if data is None:
        sys.stderr.write(f"No data from {path}\n")
        sys.exit(2)
    if args.raw:
        _emit_json(data)
    else:
        if isinstance(data, dict):
            for k in (
                "date",
                "valid",
                "headline",
                "synopsis",
            ):
                if k in data and data[k]:
                    print(f"{k}: {data[k]}")
            print()
            if ("weatherForecast" in data
                    and data["weatherForecast"]):
                print(data["weatherForecast"])
            if "sections" in data and data["sections"]:
                for sec in data["sections"]:
                    hl = sec.get("headline", "")
                    wf = sec.get("weatherForecast", "")
                    if hl or wf:
                        if hl:
                            print(f"\n{hl}")
                        if wf:
                            print(wf)
        elif isinstance(data, list):
            _emit_json(data)


def cmd_waters(args: argparse.Namespace) -> None:
    """Search weather/water stations by name."""
    path = f"/waters/{args.term}"
    data = _request_json(path)
    if data is None:
        sys.stderr.write(f"No data from {path}\n")
        sys.exit(2)
    if isinstance(data, list):
        for item in data:
            name = item.get("name", "")
            lat = item.get("latitude", "")
            lon = item.get("longitude", "")
            country = item.get("country", "")
            print(
                f"{name} ({country}) "
                f"lat={lat} lon={lon}")
    elif args.raw:
        _emit_json(data)
    else:
        _emit_text(str(data))


def cmd_sea(args: argparse.Namespace) -> None:
    """Get sea area forecast."""
    area = args.area or "Danmark"
    path = f"/json/Farvandsudsigter/{area}"
    data = _request_json(path)
    if data is None:
        sys.stderr.write(f"No data from {path}\n")
        sys.exit(2)
    if args.raw:
        _emit_json(data)
    else:
        _emit_text(str(data))


def cmd_waterlevels(
    args: argparse.Namespace,
) -> None:
    """List active water level stations with statistics."""
    path = "/vandstand/active"
    data = _request_json(path)
    if data is None:
        sys.stderr.write(f"No data from {path}\n")
        sys.exit(2)
    if isinstance(data, list):
        for item in data:
            name = item.get("name", "")
            loc = item.get("location", "")
            y20 = item.get("year20event", "")
            y100 = item.get("year100event", "")
            print(
                f"{name} ({loc}) "
                f"20-\u00e5r: {y20}cm "
                f"100-\u00e5r: {y100}cm")
    elif args.raw:
        _emit_json(data)
    else:
        _emit_text(str(data))


def cmd_images(args: argparse.Namespace) -> None:
    """Print direct image URLs."""
    images: dict[str, str] = {
        "radar": "/image/gif/Radar/",
        "satellite": "/image/png/polarsat",
        "pressure": "/image/png/Lufttryk",
        "precipitation": "/image/png/Nedb\u00f8r",
        "wind": "/image/png/Vind",
        "temperature": "/image/png/Temperatur",
        "waves": "/image/png/B\u00f8leh\u00f8jde",
        "ice": "/image/png/Iskoncentration",
    }
    if args.type_:
        key = args.type_
        if key in images:
            print(f"{BASE}{images[key]}")
        else:
            sys.stderr.write(
                f"Unknown image type. Available: "
                f"{', '.join(images.keys())}\n")
            sys.exit(2)
    else:
        for name, url in images.items():
            print(f"{name}: {BASE}{url}")


def cmd_endpoints(args: argparse.Namespace) -> None:
    """Discover all /dmidk_byvejrWS/rest/* paths from
    the home page or React bundle."""
    if args.bundle:
        _, raw = _request(
            BASE
            + "/typo3conf/ext/dmi_sitepackage"
            + "/Resources/Public/JavaScript/"
            + "ReactBundle/index.bundle.js",
        )
        text = raw.decode("utf-8", errors="replace")
        # Extract paths from both single-quoted and
        # double-quoted fetch calls
        paths = sorted(set(
            re.findall(
                r'''["'](/dmidk_byvejrWS/rest/'
                r'[A-Za-z0-9/_.{}\-]+)''',
                text,
            )))
    else:
        _, raw = _request(
            BASE + "/",
            extra_headers={
                "Accept": "text/html",
            },
        )
        html = raw.decode("utf-8", errors="replace")
        paths = sorted(set(
            re.findall(
                r'/dmidk_byvejrWS/rest/'
                r'[A-Za-z0-9/_.{}\-]+',
                html,
            )))
    for p in paths:
        print(p)


def cmd_texts(args: argparse.Namespace) -> None:
    """Get shore station text forecast by gid."""
    path = f"/texts/{args.gid}"
    data = _request_json(path)
    if data is None:
        sys.stderr.write(f"No data from {path}\n")
        sys.exit(2)
    if args.raw:
        _emit_json(data)
    else:
        _emit_text(str(data))


def cmd_city_search(args: argparse.Namespace) -> None:
    """Search for a city by name."""
    city = args.city
    url = _city_solr_url(city, rows=10)
    data = _request_with_referer(url)
    if data is None:
        sys.stderr.write(f"No data from city search for '{city}'\n")
        sys.exit(2)

    docs = data.get("response", {}).get("docs", [])
    if not docs:
        sys.stderr.write(f"No cities found matching '{city}'\n")
        sys.exit(2)

    if args.id_only:
        print(docs[0]["id"])
    elif args.raw:
        _emit_json({"numFound": len(docs), "results": docs})
    else:
        print(f"Found {len(docs)} city(s) matching '{city}':")
        print(
            f"{'ID':>10} {'Name':<25} {'Pop':>8} "
            f"{'Country':<5} {'Region/Municipality'}")
        print("-" * 80)
        for doc in docs:
            city_id = doc.get("id", "")
            name = (
                doc.get("name") or [""]
            )[0] if isinstance(doc.get("name"), list) else doc.get(
                "name", "")
            pop = doc.get("population", "")
            country = doc.get("country", "")
            locality = ""
            if isinstance(doc.get("municipality"), str):
                locality = doc["municipality"]
            elif isinstance(doc.get("region"), list) and doc["region"]:
                locality = doc["region"][0]
            print(
                f"{city_id:>10} {name:<25} "
                f"{str(pop):>8} {country:<5} {locality}")


def _city_name_from_doc(
    doc: dict,
) -> str:
    """Extract the human-readable city name from a Solr result doc."""
    name = doc.get("name") or ""
    if isinstance(name, list):
        return name[0] if name else ""
    return name


def cmd_city_forecast(args: argparse.Namespace) -> None:
    """Get NinJo weather forecast for a city by ID."""
    url = _ninjo_url(args.city_id)
    data = _request_with_referer(url)
    if data is None:
        sys.stderr.write(
            f"No forecast data for city ID {args.city_id}\n")
        sys.exit(2)

    if args.raw:
        _emit_json(data)
        return

    city = data.get("city", "Unknown")
    country = data.get("country", "")
    sunrise = data.get("sunrise", "")
    sunset = data.get("sunset", "")
    last_update = data.get("lastupdate", "")

    _print_header(city, country, last_update, sunrise, sunset)

    timeseries = data.get("timeserie", [])
    agg_data = data.get("aggData", [])

    if args.daily:
        _print_daily_table(
            agg_data,
            only_today=args.today,
            only_tomorrow=args.tomorrow,
        )
    elif args.today or args.tomorrow:
        # --today/--tomorrow without --daily still shows daily
        _print_daily_table(
            agg_data,
            only_today=args.today,
            only_tomorrow=args.tomorrow,
        )
    else:
        hours = args.hours
        if args.days:
            hours = args.days * 24
        _print_hourly_table(timeseries, hours=hours)


def cmd_forecast_city(args: argparse.Namespace) -> None:
    """Search for a city by name and get its weather forecast.

    If no city is given and --auto is used, tries to detect the
    user's location from their IP address. Falls back to K\u00f8benhavn.
    """
    city = args.city if args.city else None

    # Auto-detect city from IP if no city specified
    if not city:
        detected = _geo_locate()
        if detected:
            city = detected
            print(f"(Detected location from IP: {city})")
        else:
            city = "k\u00f8benhavn"
            print("(Could not detect location, defaulting to K\u00f8benhavn)")

    url = _city_solr_url(city, rows=1)
    search_data = _request_with_referer(url)
    if search_data is None:
        sys.stderr.write(
            f"No data from city search for '{city}'\n")
        sys.exit(2)

    docs = search_data.get("response", {}).get("docs", [])
    if not docs:
        sys.stderr.write(
            f"No cities found matching '{city}'\n")
        sys.exit(2)

    city_id = docs[0]["id"]
    city_name = _city_name_from_doc(docs[0])

    forecast_data = _request_with_referer(_ninjo_url(city_id))
    if forecast_data is None:
        sys.stderr.write(
            f"No forecast data for city '{city_name}' "
            f"(ID: {city_id})\n")
        sys.exit(2)

    if args.raw:
        _emit_json({
            "city_found": docs[0],
            "forecast": forecast_data,
        })
        return

    fname = forecast_data.get("city", city_name)
    country = forecast_data.get("country", "")
    sunrise = forecast_data.get("sunrise", "")
    sunset = forecast_data.get("sunset", "")
    last_update = forecast_data.get("lastupdate", "")

    _print_header(fname, country, last_update, sunrise, sunset)

    timeseries = forecast_data.get("timeserie", [])
    agg_data = forecast_data.get("aggData", [])

    # Default to daily output; --hours or --days overrides to hourly
    use_daily = args.daily or not args.hours and not args.days

    if use_daily or args.today or args.tomorrow:
        _print_daily_table(
            agg_data,
            only_today=args.today,
            only_tomorrow=args.tomorrow,
        )
    else:
        hours = args.hours
        if args.days:
            hours = args.days * 24
        _print_hourly_table(timeseries, hours=hours)


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__.strip())
    sub = parser.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser(
        "forecast",
        help="national weather forecast",
    )
    p.add_argument(
        "--region",
        choices=["Danmark", "Gronland"],
        default="Danmark",
        help="region (default: Danmark)",
    )
    p.add_argument(
        "--days",
        choices=["DK/land", "DK/land7"],
        default="DK/land",
        help="forecast length (default: DK/land)",
    )
    p.add_argument(
        "--raw",
        action="store_true",
        help="print raw JSON",
    )
    p.set_defaults(func=cmd_forecast)

    p = sub.add_parser(
        "waters",
        help="search weather/water stations",
    )
    p.add_argument(
        "term",
        help="search term (city name, area, etc.)",
    )
    p.add_argument(
        "--raw",
        action="store_true",
        help="print raw JSON",
    )
    p.set_defaults(func=cmd_waters)

    p = sub.add_parser(
        "sea",
        help="sea area forecast",
    )
    p.add_argument(
        "--area",
        default="Danmark",
        help="sea area (default: Danmark)",
    )
    p.add_argument(
        "--raw",
        action="store_true",
        help="print raw JSON",
    )
    p.set_defaults(func=cmd_sea)

    p = sub.add_parser(
        "waterlevels",
        help="active water level stations",
    )
    p.add_argument(
        "--raw",
        action="store_true",
        help="print raw JSON",
    )
    p.set_defaults(func=cmd_waterlevels)

    p = sub.add_parser(
        "images",
        help="print direct image URLs",
    )
    p.add_argument(
        "--type",
        dest="type_",
        choices=[
            "radar",
            "satellite",
            "pressure",
            "precipitation",
            "wind",
            "temperature",
            "waves",
            "ice",
        ],
        help="specific image type",
    )
    p.set_defaults(func=cmd_images)

    p = sub.add_parser(
        "endpoints",
        help="discover API paths from home page or "
        "React bundle",
    )
    p.add_argument(
        "--bundle",
        action="store_true",
        help="scan the React bundle instead of the "
        "home page (more endpoints)",
    )
    p.set_defaults(func=cmd_endpoints)

    p = sub.add_parser(
        "texts",
        help="shore station text forecast",
    )
    p.add_argument(
        "gid",
        help="station gid",
    )
    p.add_argument(
        "--raw",
        action="store_true",
        help="print raw JSON",
    )
    p.set_defaults(func=cmd_texts)

    p = sub.add_parser(
        "city-search",
        help="search for a city by name",
    )
    p.add_argument(
        "city",
        help="city name to search for",
    )
    p.add_argument(
        "--id-only",
        action="store_true",
        help="print only the city ID (for piping to city-forecast)",
    )
    p.add_argument(
        "--raw",
        action="store_true",
        help="print raw JSON",
    )
    p.set_defaults(func=cmd_city_search)

    p = sub.add_parser(
        "city-forecast",
        help="get weather forecast for a city by ID",
    )
    p.add_argument(
        "city_id",
        help="city ID (from city-search)",
    )
    p.add_argument(
        "--hours",
        type=int,
        default=None,
        help="number of hours to display (default: all)",
    )
    p.add_argument(
        "--days",
        type=int,
        default=None,
        help="number of days to display (each day = 24 hours)",
    )
    p.add_argument(
        "--daily",
        action="store_true",
        help="show daily aggregates instead of hourly",
    )
    p.add_argument(
        "--today",
        action="store_true",
        help="show only today's forecast (implies daily)",
    )
    p.add_argument(
        "--tomorrow",
        action="store_true",
        help="show only tomorrow's forecast (implies daily)",
    )
    p.add_argument(
        "--raw",
        action="store_true",
        help="print raw JSON",
    )
    p.set_defaults(func=cmd_city_forecast)

    p = sub.add_parser(
        "forecast-city",
        help="search for a city and get its weather forecast",
    )
    p.add_argument(
        "city",
        nargs="?",
        default=None,
        help="city name to search for (auto-detect from IP if omitted)",
    )
    p.add_argument(
        "--hours",
        type=int,
        default=None,
        help="number of hours to display (default: daily)",
    )
    p.add_argument(
        "--days",
        type=int,
        default=None,
        help="number of days to display (each day = 24 hours)",
    )
    p.add_argument(
        "--daily",
        action="store_true",
        help="show daily aggregates (default)",
    )
    p.add_argument(
        "--today",
        action="store_true",
        help="show only today's forecast",
    )
    p.add_argument(
        "--tomorrow",
        action="store_true",
        help="show only tomorrow's forecast",
    )
    p.add_argument(
        "--raw",
        action="store_true",
        help="print raw JSON (includes city search results)",
    )
    p.set_defaults(func=cmd_forecast_city)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
