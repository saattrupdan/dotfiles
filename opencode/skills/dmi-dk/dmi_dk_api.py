#!/usr/bin/env python3
"""CLI helper for DMI (Danmarks Meteorologiske Institut) internal APIs.

Standard library only. See ./SKILL.md for endpoint specs.
"""
from __future__ import annotations

import argparse
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

    args = parser.parse_args()
    args.func(args)


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
                f"20-år: {y20}cm "
                f"100-år: {y100}cm")
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
        "precipitation": "/image/png/Nedbør",
        "wind": "/image/png/Vind",
        "temperature": "/image/png/Temperatur",
        "waves": "/image/png/Bølgehøjde",
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


if __name__ == "__main__":
    main()
