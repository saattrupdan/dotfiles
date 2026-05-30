#!/usr/bin/env python3
"""CLI helper for DMI (Danmarks Meteorologiske Institut) internal APIs.

Standard library only. See ./SKILL.md for endpoint specs.
"""

from __future__ import annotations

import argparse
import datetime
import json
import logging
import math
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

BASE = "https://www.dmi.dk"
API = BASE + "/dmidk_byvejrWS/rest"
UA = "Mozilla/5.0 (dmi-dk-api-cli)"

WEEKDAYS_DK = ["man", "tir", "ons", "tor", "fre", "lør", "søn"]

# Wind direction abbreviations (DMI style) -> full names in Danish
WIND_DIR_MAP: dict[str, str] = {
    "N": "Nord",
    "NØ": "Nord-Nordøst",
    "ØNØ": "Øst-Nordøst",
    "Ø": "Øst",
    "ØSØ": "Øst-Sydøst",
    "S": "Syd",
    "SSV": "Syd-Sydvest",
    "SV": "Sydvest",
    "V": "Vest",
    "VNV": "Vest-Nordvest",
    "NV": "Nordvest",
    "NNV": "Nord-Nordvest",
}

# UV index ranges -> human-readable descriptions in Danish
UV_DESCRIPTIONS: list[tuple[int, str]] = [
    (0, "Lav — ingen risiko"),
    (2, "Lav — ingen risiko"),
    (5, "Moderat — beskyttelse anbefales"),
    (6, "Høj — undgå solen kl. 11-15"),
    (7, "Meget høj — undgå solen kl. 11-15"),
    (10, "Ekstrem — undgå ophold i solen"),
]

logging.basicConfig(
    level=logging.INFO,
    format="%(message)s",
    stream=sys.stdout,
)
logger = logging.getLogger(__name__)

JsonValue = dict | list | str | int | float | bool | None


def main() -> None:
    """Entry point: parse arguments and dispatch to the selected command."""
    parser = argparse.ArgumentParser(description=__doc__.strip())
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
        help="discover API paths from home page or React bundle",
    )
    p.add_argument(
        "--bundle",
        action="store_true",
        help="scan the React bundle instead of the home page (more endpoints)",
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
        help=("print only the city ID (for piping to city-forecast)"),
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
        help=("number of days to display (each day = 24 hours)"),
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
        help=("city name to search for (auto-detect from IP if omitted)"),
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
        help=("number of days to display (each day = 24 hours)"),
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


# ---- Command handlers ----


def cmd_forecast(args: argparse.Namespace) -> None:
    """Get national weather forecast for Denmark."""
    region_map: dict[str, str] = {
        "Danmark": "Danmark",
        "Gronland": "Gr\u00f8nland",
    }
    region: str = region_map.get(args.region, args.region) or "Danmark"
    days: str = args.days or "DK/land"
    path: str = f"/json/{region}/{days}"
    data: JsonValue = _request_json(path=path)
    if data is None:
        logger.error(f"No data from {path}")
        sys.exit(2)
    if args.raw:
        _emit_json(obj=data)
    else:
        if isinstance(data, dict):
            for k in (
                "date",
                "valid",
                "headline",
                "synopsis",
            ):
                if k in data and data[k]:
                    logger.info(f"{k}: {data[k]}")
            logger.info("")
            if "weatherForecast" in data and data["weatherForecast"]:
                logger.info(data["weatherForecast"])
            if "sections" in data and data["sections"]:
                for sec in data["sections"]:
                    hl: str = sec.get("headline", "")
                    wf: str = sec.get("weatherForecast", "")
                    if hl or wf:
                        if hl:
                            logger.info(f"\n{hl}")
                        if wf:
                            logger.info(wf)
        elif isinstance(data, list):
            _emit_json(obj=data)


def cmd_waters(args: argparse.Namespace) -> None:
    """Search weather/water stations by name."""
    path: str = f"/waters/{args.term}"
    data: JsonValue = _request_json(path=path)
    if data is None:
        logger.info(f"No stations found for '{args.term}'")
        return
    if args.raw:
        _emit_json(obj=data)
    elif isinstance(data, list):
        for item in data:
            name: str = item.get("name", "")
            lat: str = item.get("latitude", "")
            lon: str = item.get("longitude", "")
            country: str = item.get("country", "")
            logger.info(f"{name} ({country}) lat={lat} lon={lon}")
    else:
        _emit_text(text=str(data))


def cmd_sea(args: argparse.Namespace) -> None:
    """Get sea area forecast."""
    area: str = args.area or "Danmark"
    path: str = f"/json/Farvandsudsigter/{area}"
    data: JsonValue = _request_json(path=path)
    if data is None:
        logger.error(f"No data from {path}")
        sys.exit(2)
    if args.raw:
        _emit_json(obj=data)
    else:
        _emit_text(text=str(data))


def cmd_waterlevels(args: argparse.Namespace) -> None:
    """List active water level stations with statistics."""
    path: str = "/vandstand/active"
    data: JsonValue = _request_json(path=path)
    if data is None:
        logger.error(f"No data from {path}")
        sys.exit(2)
    if isinstance(data, list):
        for item in data:
            name: str = item.get("name", "")
            loc: str = item.get("location", "")
            y20: str = item.get("year20event", "")
            y100: str = item.get("year100event", "")
            logger.info(f"{name} ({loc}) 20-\u00e5r: {y20}cm 100-\u00e5r: {y100}cm")
    elif args.raw:
        _emit_json(obj=data)
    else:
        _emit_text(text=str(data))


def cmd_images(args: argparse.Namespace) -> None:
    """Print direct image URLs."""
    images: dict[str, str] = {
        "radar": "/image/gif/Radar/",
        "satellite": "/image/png/polarsat",
        "pressure": "/image/png/Lufttryk",
        "precipitation": "/image/png/Nedb\u00f8r",
        "wind": "/image/png/Vind",
        "temperature": "/image/png/Temperatur",
        "waves": "/image/png/B\u00f8lgeh\u00f8jde",
        "ice": "/image/png/Iskoncentration",
    }
    if args.type_:
        key: str = args.type_
        if key in images:
            logger.info(f"{BASE}{images[key]}")
        else:
            logger.error(f"Unknown image type. Available: {', '.join(images.keys())}")
            sys.exit(2)
    else:
        for name, url in images.items():
            logger.info(f"{name}: {BASE}{url}")


def cmd_endpoints(args: argparse.Namespace) -> None:
    """Discover all /dmidk_byvejrWS/rest/* paths from
    the home page or React bundle."""
    if args.bundle:
        _, raw = _request(
            url=(
                BASE
                + "/typo3conf/ext/dmi_sitepackage"
                + "/Resources/Public/JavaScript/"
                + "ReactBundle/index.bundle.js"
            ),
        )
        text: str = raw.decode("utf-8", errors="replace")
        # Extract paths from both single-quoted and
        # double-quoted fetch calls
        paths: list[str] = sorted(
            set(
                re.findall(
                    r"""["'](/dmidk_byvejrWS/rest/[A-Za-z0-9/_.{}\-]+)""",
                    text,
                )
            )
        )
    else:
        _, raw = _request(
            url=BASE + "/",
            extra_headers={
                "Accept": "text/html",
            },
        )
        html: str = raw.decode("utf-8", errors="replace")
        paths: list[str] = sorted(
            set(
                re.findall(
                    (
                        r"/dmidk_byvejrWS/rest/"
                        r"[A-Za-z0-9/_.{}\-]+"
                    ),
                    html,
                )
            )
        )
    for p in paths:
        logger.info(p)


def cmd_texts(args: argparse.Namespace) -> None:
    """Get shore station text forecast by gid."""
    path: str = f"/texts/{args.gid}"
    data: JsonValue = _request_json(path=path)
    if data is None:
        logger.error(f"No data from {path}")
        sys.exit(2)
    if args.raw:
        _emit_json(obj=data)
    else:
        _emit_text(text=str(data))


def cmd_city_search(args: argparse.Namespace) -> None:
    """Search for a city by name."""
    city: str = args.city
    url: str = _city_solr_url(city=city, rows=10)
    data: JsonValue = _request_with_referer(url=url)
    if data is None:
        logger.error(f"No data from city search for '{city}'")
        sys.exit(2)

    docs: list[dict] = data.get("response", {}).get("docs", [])
    if not docs:
        logger.error(f"No cities found matching '{city}'")
        sys.exit(2)

    if args.id_only:
        logger.info(docs[0]["id"])
    elif args.raw:
        _emit_json(
            obj={
                "numFound": len(docs),
                "results": docs,
            }
        )
    else:
        logger.info(f"Found {len(docs)} city(s) matching '{city}':")
        logger.info(
            f"{'ID':>10} {'Name':<25} {'Pop':>8} {'Country':<5} {'Region/Municipality'}"
        )
        logger.info("-" * 80)
        for doc in docs:
            city_id: str = doc.get("id", "")
            raw_name: str | list[str] = doc.get("name") or ""
            if isinstance(raw_name, list):
                name: str = raw_name[0] if raw_name else ""
            else:
                name: str = raw_name
            pop: str = doc.get("population", "")
            country: str = doc.get("country", "")
            locality: str = ""
            if isinstance(doc.get("municipality"), str):
                locality: str = doc["municipality"]
            elif isinstance(doc.get("region"), list) and doc["region"]:
                locality: str = doc["region"][0]
            logger.info(
                f"{city_id:>10} {name:<25} {str(pop):>8} {country:<5} {locality}"
            )


def cmd_city_forecast(args: argparse.Namespace) -> None:
    """Get NinJo weather forecast for a city by ID."""
    url: str = _ninjo_url(city_id=args.city_id)
    data: JsonValue = _request_with_referer(url=url)
    if data is None:
        logger.error(f"No forecast data for city ID {args.city_id}")
        sys.exit(2)

    if args.raw:
        _emit_json(obj=data)
        return

    city: str = data.get("city", "Unknown")
    country: str = data.get("country", "")
    sunrise: str = data.get("sunrise", "")
    sunset: str = data.get("sunset", "")
    last_update: str = data.get("lastupdate", "")

    _print_header(
        city=city,
        country=country,
        last_update=last_update,
        sunrise=sunrise,
        sunset=sunset,
    )

    timeseries: list[dict] = data.get("timeserie", [])
    agg_data: list[dict] = data.get("aggData", [])

    if args.daily:
        _print_daily_table(
            agg_data=agg_data,
            timeseries=timeseries,
            only_today=args.today,
            only_tomorrow=args.tomorrow,
        )
    elif args.today or args.tomorrow:
        _print_daily_table(
            agg_data=agg_data,
            timeseries=timeseries,
            only_today=args.today,
            only_tomorrow=args.tomorrow,
        )
    else:
        hours: int | None = args.hours
        _print_hourly_table(
            timeseries=timeseries,
            hours=hours,
        )


def cmd_forecast_city(args: argparse.Namespace) -> None:
    """Search for a city by name and get its weather forecast.

    If no city is given, tries to detect the user's location from
    their IP address. Falls back to K\u00f8benhavn.
    """
    city: str | None = args.city if args.city else None

    if not city:
        detected: str | None = _geo_locate()
        if detected:
            city = detected
            logger.info(f"(Detected location from IP: {city})")
        else:
            city = "k\u00f8benhavn"
            logger.info("(Could not detect location, defaulting to K\u00f8benhavn)")

    url: str = _city_solr_url(city=city, rows=1)
    search_data: JsonValue = _request_with_referer(url=url)
    if search_data is None:
        logger.error(f"No data from city search for '{city}'")
        sys.exit(2)

    docs: list[dict] = search_data.get("response", {}).get("docs", [])
    if not docs:
        logger.error(f"No cities found matching '{city}'")
        sys.exit(2)

    city_id: str = docs[0]["id"]
    # Inline _city_name_from_doc logic
    raw_name: str | list[str] = docs[0].get("name") or ""
    if isinstance(raw_name, list):
        city_name: str = raw_name[0] if raw_name else ""
    else:
        city_name: str = raw_name

    forecast_data: JsonValue = _request_with_referer(url=_ninjo_url(city_id=city_id))
    if forecast_data is None:
        logger.error(f"No forecast data for city '{city_name}' (ID: {city_id})")
        sys.exit(2)

    if args.raw:
        _emit_json(
            obj={
                "city_found": docs[0],
                "forecast": forecast_data,
            }
        )
        return

    fname: str = forecast_data.get("city", city_name)
    country: str = forecast_data.get("country", "")
    sunrise: str = forecast_data.get("sunrise", "")
    sunset: str = forecast_data.get("sunset", "")
    last_update: str = forecast_data.get("lastupdate", "")

    _print_header(
        city=fname,
        country=country,
        last_update=last_update,
        sunrise=sunrise,
        sunset=sunset,
    )

    timeseries: list[dict] = forecast_data.get("timeserie", [])
    agg_data: list[dict] = forecast_data.get("aggData", [])

    # Default to daily output; --hours or --days
    # overrides to hourly
    use_daily: bool = args.daily or not args.hours and not args.days

    if use_daily or args.today or args.tomorrow:
        _print_daily_table(
            agg_data=agg_data,
            timeseries=timeseries,
            only_today=args.today,
            only_tomorrow=args.tomorrow,
        )
    else:
        hours: int | None = args.hours
        if args.days:
            hours = args.days * 24
        _print_hourly_table(
            timeseries=timeseries,
            hours=hours,
        )


# ---- Display functions ----


def _print_daily_table(
    agg_data: list[dict],
    timeseries: list[dict] | None = None,
    only_today: bool = False,
    only_tomorrow: bool = False,
) -> None:
    """Print a formatted daily weather table.

    Args:
        agg_data:
            List of daily aggregate dicts from the
            forecast API.
        timeseries:
            Hourly entries used to compute daily wind
            stats.
        only_today:
            If True, show only today's row.
        only_tomorrow:
            If True, show only tomorrow's row.
    """
    today: datetime.date = datetime.date.today()
    tomorrow: datetime.date = today + datetime.timedelta(days=1)

    filtered: list[dict] = []
    for day in agg_data:
        raw_date: str = day.get("date", day.get("time", ""))
        if not raw_date or len(raw_date) < 8:
            continue
        try:
            day_date: datetime.date = datetime.date(
                year=int(raw_date[0:4]),
                month=int(raw_date[4:6]),
                day=int(raw_date[6:8]),
            )
        except (ValueError, IndexError):
            continue

        if only_today and day_date != today:
            continue
        if only_tomorrow and day_date != tomorrow:
            continue

        filtered.append(day)

    if not filtered:
        logger.info("(no forecast data for this period)")
        return

    if only_today or only_tomorrow:
        # Single-day compact format
        day: dict = filtered[0]
        raw_date: str = day.get("date", day.get("time", ""))
        wd: str = _format_weekday(date_str=raw_date)
        fmt: str = _format_date(date_str=raw_date)
        min_t: str = day.get("minTemp", "")
        max_t: str = day.get("maxTemp", "")
        precip: str = _nice_precip(val=day.get("precipSum", ""))
        uv_val: str = day.get("uvRadiation", "")
        uv_desc: str = _uv_description(uv=uv_val)

        wind_info: str = "-"
        if timeseries:
            avg_spd: float
            dir_str: str
            avg_spd, dir_str = _daily_wind_from_timeseries(
                timeseries=timeseries,
                target_date=raw_date,
            )
            wind_info = f"{avg_spd:.1f} m/s {dir_str}"

        label: str = "I dag" if only_today else "I morgen"
        logger.info(f"\n{label} ({wd} {fmt}):")
        logger.info(
            f"  Temperatur: "
            f"{min_t}\u2013{max_t} \u00b0C  "
            f"Nedb\u00f8r: {precip} mm  "
            f"Vind: {wind_info}  "
            f"UV: {uv_val} ({uv_desc})"
        )
    else:
        # Multi-day table
        logger.info(
            f"{'Uge':>4} {'Dato':>8} "
            f"{'Min':>5} {'Max':>5} "
            f"{'Nedb\u00f8r':>8} "
            f"{'Vind':>10} "
            f"{'UV':>4}"
        )
        logger.info("-" * 52)
        for day in filtered:
            raw_date: str = day.get("date", day.get("time", ""))
            wd: str = _format_weekday(date_str=raw_date)
            fmt: str = _format_date(date_str=raw_date)
            min_t: str = day.get("minTemp", "")
            max_t: str = day.get("maxTemp", "")
            precip: str = _nice_precip(val=day.get("precipSum", ""))
            uv_val: str = day.get("uvRadiation", "")
            uv_desc: str = _uv_description(uv=uv_val)

            wind_info: str = "-"
            if timeseries:
                avg_spd: float
                dir_str: str
                avg_spd, dir_str = _daily_wind_from_timeseries(
                    timeseries=timeseries,
                    target_date=raw_date,
                )
                wind_info = f"{avg_spd:.1f} m/s {dir_str}"

            logger.info(
                f"{wd:>4} {fmt:>8} "
                f"{str(min_t):>5} "
                f"{str(max_t):>5} "
                f"{precip:>8} "
                f"{wind_info:>10} "
                f"{str(uv_val):>4}"
            )


def _print_hourly_table(
    timeseries: list[dict],
    hours: int | None = None,
) -> None:
    """Print a formatted hourly weather table.

    Args:
        timeseries:
            Hourly forecast entries from the API.
        hours:
            Number of hours to display, or None for
            all.
    """
    sample: list[dict] = timeseries[:hours] if hours else timeseries
    if not sample:
        logger.info("(no hourly forecast data)")
        return

    logger.info(
        f"{'Tid':>16} {'Temp':>6} "
        f"{'Vind':>10} "
        f"{'Kast':>6} "
        f"{'Luftfugt.':>9} "
        f"{'Nedb\u00f8r':>7} "
        f"{'Sigthed':>8}"
    )
    logger.info("-" * 78)
    for entry in sample:
        iso_time: str = entry.get("localTimeIso", "")
        temp: str = _format_temp(val=entry.get("temp", ""))
        wind_speed: str = _format_wind(val=entry.get("windSpeed", ""))
        wind_dir: str = _wind_direction(degrees=entry.get("windDegree", ""))
        wind_gust: str = _format_wind(val=entry.get("windGust", ""))
        humidity: str = _format_humid(val=entry.get("humidity", ""))
        precip: str = _nice_precip(val=entry.get("precip1", ""))
        vis: str = _format_vis(val=entry.get("visibility", ""))

        if iso_time:
            try:
                time_part: str = iso_time[11:16]
            except (IndexError, TypeError):
                time_part: str = iso_time
        else:
            time_part = ""

        logger.info(
            f"{time_part:>16} {temp:>6} "
            f"{wind_speed:>5} "
            f"{wind_dir:>5} "
            f"{wind_gust:>6} "
            f"{humidity:>9} "
            f"{precip:>7} {vis:>8}"
        )


def _print_header(
    city: str,
    country: str,
    last_update: str,
    sunrise: str,
    sunset: str,
) -> None:
    """Print the forecast header block.

    Args:
        city:
            City name.
        country:
            Country name.
        last_update:
            Timestamp of the last update.
        sunrise:
            Sunrise time string.
        sunset:
            Sunset time string.
    """
    logger.info(f"Vejrprognose for {city} ({country})")
    if last_update:
        logger.info(
            f"Opdateret: "
            f"{last_update[:4]}-"
            f"{last_update[4:6]}-"
            f"{last_update[6:8]} "
            f"{last_update[8:10]}:"
            f"{last_update[10:12]}:"
            f"{last_update[12:14]}"
        )
    if sunrise or sunset:
        sr = sunrise.zfill(4) if sunrise else ""
        ss = sunset.zfill(4) if sunset else ""
        logger.info(f"Solopgang: {sr[:2]}:{sr[2:]}  Solnedgang: {ss[:2]}:{ss[2:]}")
    logger.info("")


# ---- Formatting helpers ----


def _fmt(
    val: str | float | int | None,
    fmt: str = ".2f",
) -> str:
    """Round a numeric value to the given format.

    Returns '-' for missing/empty values. Strips
    trailing zeros and the trailing dot so that '0'
    stays '0', '1.5' stays '1.5', and '3.14' stays
    '3.14'.

    Args:
        val:
            Numeric value to format.
        fmt:
            Format string for rounding (default:
            '.2f').

    Returns:
        Formatted string representation.
    """
    if val is None or val == "":
        return "-"
    try:
        result: str = f"{float(val):{fmt}}"
        if "." in result:
            result = result.rstrip("0").rstrip(".")
        return result
    except (ValueError, TypeError):
        return str(val)


def _format_date(date_str: str) -> str:
    """Format a YYYYMMDD string as DD-MM.

    Args:
        date_str:
            Date string in YYYYMMDD format.

    Returns:
        Formatted date as DD-MM, or the original
        string if invalid.
    """
    if not date_str or len(date_str) < 8:
        return date_str
    return f"{date_str[6:8]}-{date_str[4:6]}"


def _format_weekday(date_str: str) -> str:
    """Return the Danish weekday abbreviation.

    Args:
        date_str:
            Date string in YYYYMMDD format.

    Returns:
        Abbreviated weekday name, or empty
        string if invalid.
    """
    if not date_str or len(date_str) < 8:
        return ""
    try:
        dt: datetime.date = datetime.date(
            year=int(date_str[0:4]),
            month=int(date_str[4:6]),
            day=int(date_str[6:8]),
        )
        return WEEKDAYS_DK[dt.weekday()]
    except (ValueError, IndexError):
        return ""


def _nice_precip(
    val: str | float | int | None,
) -> str:
    """Format precipitation value nicely.

    Rounds to 2 decimals, treating values below
    0.05 as zero.

    Args:
        val:
            Precipitation value.

    Returns:
        Formatted string or '-' for missing values.
    """
    if val == "" or val is None:
        return "-"
    try:
        f: float = float(val)
        if f < 0.05:
            return "0.0"
        return f"{f:.2f}".rstrip("0").rstrip(".")
    except (ValueError, TypeError):
        return str(val)


def _format_temp(
    val: str | float | int | None,
) -> str:
    """Format temperature as integer.

    Args:
        val:
            Temperature value in Celsius.

    Returns:
        Rounded integer string or '-'.
    """
    if val is None or val == "":
        return "-"
    try:
        return f"{round(float(val))}"
    except (ValueError, TypeError):
        return str(val)


def _format_wind(
    val: str | float | int | None,
) -> str:
    """Format wind speed to 1 decimal place.

    Args:
        val:
            Wind speed value.

    Returns:
        Formatted string or '-'.
    """
    return _fmt(val=val, fmt=".1f")


def _format_humid(
    val: str | float | int | None,
) -> str:
    """Format humidity as integer percentage.

    Args:
        val:
            Humidity percentage value.

    Returns:
        Rounded integer string or '-'.
    """
    if val is None or val == "":
        return "-"
    try:
        return f"{round(float(val))}"
    except (ValueError, TypeError):
        return str(val)


def _format_vis(
    val: str | float | int | None,
) -> str:
    """Format visibility in km.

    Rounds to nearest whole km; values above 100 km
    render as '>100'.

    Args:
        val:
            Visibility in metres.

    Returns:
        String representation or '-'.
    """
    if val is None or val == "":
        return "-"
    try:
        km: float = float(val) / 1000
        if km >= 100:
            return ">100"
        return f"{round(km)}"
    except (ValueError, TypeError):
        return str(val)


def _wind_direction(
    degrees: str | float | int | None,
) -> str:
    """Convert wind degrees to a Danish direction.

    Args:
        degrees:
            Wind direction in degrees.

    Returns:
        Full Danish direction name or '-'.
    """
    if degrees is None or degrees == "":
        return "-"
    try:
        d: float = float(degrees)
    except (ValueError, TypeError):
        return "-"
    # 8 directions: each spans 45 degrees,
    # centred at 22.5, 67.5, ...
    dirs: list[str] = [
        "N",
        "NØ",
        "Ø",
        "SØ",
        "S",
        "SV",
        "V",
        "NV",
    ]
    idx: int = round(d / 45) % 8
    abbr: str = dirs[idx]
    return WIND_DIR_MAP.get(abbr, abbr)


def _uv_description(
    uv: str | float | int | None,
) -> str:
    """Return a human-readable UV index description.

    Args:
        uv:
            UV index value.

    Returns:
        Description string or '-'.
    """
    if uv is None or uv == "":
        return "-"
    try:
        val: float = float(uv)
    except (ValueError, TypeError):
        return "-"
    for threshold, desc in UV_DESCRIPTIONS:
        if val <= threshold:
            return desc
    return "Ekstrem — undgå ophold i solen"


def _daily_wind_from_timeseries(
    timeseries: list[dict],
    target_date: str,
) -> tuple[float, str]:
    """Compute average wind speed and dominant direction.

    Args:
        timeseries:
            Hourly forecast entries.
        target_date:
            Date string in YYYYMMDD format.

    Returns:
        Tuple of (average_speed_m_s, direction_string).
    """
    speeds: list[float] = []
    directions: list[float] = []
    for entry in timeseries:
        iso: str = entry.get("localTimeIso", "")
        if not iso or len(iso) < 10:
            continue
        entry_date: str = iso[:10].replace("-", "")
        if entry_date == target_date:
            spd: str | None = entry.get("windSpeed")
            deg: str | None = entry.get("windDegree")
            if spd is not None:
                try:
                    speeds.append(float(spd))
                except (ValueError, TypeError):
                    pass
            if deg is not None:
                try:
                    directions.append(float(deg))
                except (ValueError, TypeError):
                    pass

    if not speeds:
        return 0.0, "-"
    avg_speed: float = sum(speeds) / len(speeds)

    if directions:
        # Circular mean for directions
        sin_sum: float = sum(math.sin(math.radians(d)) for d in directions)
        cos_sum: float = sum(math.cos(math.radians(d)) for d in directions)
        mean_deg: float = math.degrees(
            math.atan2(
                sin_sum / len(directions),
                cos_sum / len(directions),
            )
        )
        if mean_deg < 0:
            mean_deg += 360
        return avg_speed, _wind_direction(degrees=mean_deg)
    return avg_speed, "-"


# ---- Utility helpers ----


def _emit_json(obj: JsonValue) -> None:
    """Print a JSON-serialised object with indentation."""
    logger.info(
        json.dumps(
            obj=obj,
            ensure_ascii=False,
            indent=2,
        )
    )


def _emit_text(text: str) -> None:
    """Print a plain text string."""
    logger.info(text)


# ---- Network functions ----


def _request_with_referer(url: str) -> JsonValue | None:
    """Fetch JSON from a URL that requires a Referer header.

    Used for Solr and NinJo endpoints that reject
    requests without a Referer.

    Args:
        url:
            Target URL to fetch.

    Returns:
        Parsed JSON structure or None on failure.
    """
    h: dict[str, str] = {
        "User-Agent": UA,
        "Accept": "application/json",
    }
    req: urllib.request.Request = urllib.request.Request(
        url=url,
        headers=h,
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            text: str = r.read().decode(encoding="utf-8", errors="replace")
            if not text.strip():
                return None
            return json.loads(text)
    except urllib.error.HTTPError as e:
        body_text: bytes = e.read() if e.fp else b""
        logger.error(f"HTTP {e.code} {e.reason} on GET {url}")
        if body_text:
            logger.error(
                body_text.decode(
                    encoding="utf-8",
                    errors="replace",
                ).rstrip()
            )
        return None


def _geo_locate() -> str | None:
    """Determine user's city from their IP address.

    Prefers ip-api.com (has a country code field) over
    ipinfo.io. Only returns a city from a Nordic country
    (DK, NO, SE, FI). Falls back to None if detection
    fails entirely.

    Returns:
        Lowercase city name or None.
    """
    # --- ip-api.com: has countryCode field ---
    try:
        h: dict[str, str] = {"User-Agent": UA}
        req: urllib.request.Request = urllib.request.Request(
            url=("https://ip-api.com/json/?fields=query,city,countryCode"),
            headers=h,
        )
        with urllib.request.urlopen(req, timeout=5) as r:
            data: dict = json.loads(s=r.read().decode("utf-8"))
        city: str = data.get("city", "")
        cc: str = data.get("countryCode", "")
        if city and cc in ("DK", "NO", "SE", "FI"):
            return city.lower()
    except Exception:  # noqa: BLE001
        pass

    # --- ipinfo.io: uses lat/lon coordinates ---
    try:
        h: dict[str, str] = {"User-Agent": UA}
        req: urllib.request.Request = urllib.request.Request(
            url="https://ipinfo.io/json",
            headers=h,
        )
        with urllib.request.urlopen(req, timeout=5) as r:
            data: dict = json.loads(s=r.read().decode("utf-8"))
        city = data.get("city", "")
        loc: str = data.get("loc", "")
        if city and loc:
            parts: list[str] = loc.split(",")
            if len(parts) >= 2:
                try:
                    lat_f: float = float(parts[0])
                    lon_f: float = float(parts[1])
                    # Denmark roughly 54-58N, 8-15E
                    if 54 <= lat_f <= 58 and 8 <= lon_f <= 15:
                        return city.lower()
                except ValueError:
                    pass
    except Exception:  # noqa: BLE001
        pass

    return None


def _request(
    url: str,
    method: str = "GET",
    body: bytes | None = None,
    extra_headers: dict[str, str] | None = None,
) -> tuple[int, bytes]:
    """Send an HTTP request and return status + body.

    Handles percent-encoding of non-ASCII characters
    in the path for urllib compatibility.

    Args:
        url:
            Request URL (may be absolute or a path
            relative to API base).
        method:
            HTTP method (default: GET).
        body:
            Optional request body bytes.
        extra_headers:
            Additional headers to include.

    Returns:
        Tuple of (status_code, response_body_bytes).
    """
    full_url: str = url if url.startswith("http") else API + url
    # Percent-encode non-ASCII in path for urllib
    parsed: urllib.parse.ParseResult = urllib.parse.urlparse(full_url)
    encoded_path: str = urllib.parse.quote(parsed.path, safe="/?=&-.")
    full_url = urllib.parse.urlunparse(
        (
            parsed.scheme,
            parsed.netloc,
            encoded_path,
            parsed.params,
            parsed.query,
            parsed.fragment,
        )
    )
    h: dict[str, str] = {
        "User-Agent": UA,
        "Accept": "application/json",
    }
    if extra_headers:
        h.update(extra_headers)
    req: urllib.request.Request = urllib.request.Request(
        url=full_url,
        method=method,
        headers=h,
        data=body,
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        err_body: bytes = e.read() if e.fp else b""
        logger.error(f"HTTP {e.code} {e.reason} on {method} {url}")
        if err_body:
            logger.error(
                err_body.decode(
                    encoding="utf-8",
                    errors="replace",
                ).rstrip()
            )
        sys.exit(2)


def _request_json(
    path: str,
    method: str = "GET",
    body: bytes | None = None,
) -> JsonValue | None:
    """Send an HTTP request and return parsed JSON.

    Falls back to returning the raw text body if
    JSON parsing fails.

    Args:
        path:
            Request path.
        method:
            HTTP method (default: GET).
        body:
            Optional request body bytes.

    Returns:
        Parsed JSON structure or raw text on decode
        failure.
    """
    res: tuple[int, bytes] = _request(
        url=path,
        method=method,
        body=body,
    )
    text: str = res[1].decode(encoding="utf-8", errors="replace")
    if not text.strip():
        return None
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return text


def _normalize_danish(text: str) -> str:
    """Normalise Danish city names for Solr queries.

    The DMI Solr API indexes cities with their
    canonical names (æ, ø, å). Users often type ASCII
    approximations like "kobenhavn" or "aarhus". This
    function normalises the input so the Solr query
    matches.

    Args:
        text:
            City name to normalise.

    Returns:
        Normalised lowercase string.
    """
    lower: str = text.lower()
    for ascii_form, danish_char in {
        "aa": "\u00e5",
        "oe": "\u00f8",
        "ae": "\u00e6",
    }.items():
        lower = lower.replace(ascii_form, danish_char)
    return lower


def _build_city_query(city: str) -> str:
    """Build the boosted ngram Solr query for a city.

    The DMI Solr index uses ``name_ngram`` for partial
    matching. A plain ``"city"`` exact-match query
    fails for most Danish city names because the Solr
    schema does not store the ``name`` field as a
    single token.

    Args:
        city:
            City name to query.

    Returns:
        Solr query string.
    """
    norm: str = _normalize_danish(text=city)
    q: str = (
        f'name:"{urllib.parse.unquote(norm)}"^8 OR '
        f"(name_ngram:"
        f'"{urllib.parse.unquote(norm)}"'
        f" AND realm:1)^2 OR "
        f"(name_ngram:"
        f'"{urllib.parse.unquote(norm)}"'
        f" AND realm:1 AND "
        f"population:[1 TO *])^4 OR "
        f"(name_ngram:"
        f'"{urllib.parse.unquote(norm)}")'
    )
    return q


def _city_solr_url(city: str, rows: int = 10) -> str:
    """Return a fully-encoded Solr search URL.

    Args:
        city:
            City name to search for.
        rows:
            Maximum number of results (default: 10).

    Returns:
        Complete Solr query URL string.
    """
    q: str = _build_city_query(city=city)
    params: str = urllib.parse.urlencode(
        {
            "wt": "json",
            "q": q,
            "rows": str(rows),
            "sort": ("score desc,realm desc,population desc"),
        }
    )
    return f"https://www.dmi.dk/solr/city_core/select?{params}"


def _ninjo_url(city_id: int) -> str:
    """Return a fully-encoded NinJo forecast URL.

    Args:
        city_id:
            DMI city identifier.

    Returns:
        NinJo API URL string.
    """
    return f"https://www.dmi.dk/NinJo2DmiDk/ninjo2dmidk?cmd=llj&id={city_id}"


if __name__ == "__main__":
    main()
