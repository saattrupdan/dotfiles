#!/usr/bin/env python3
"""Thin CLI for the public read APIs behind https://www.dsb.dk/.

Standard library only. See ./SKILL.md for the full spec.
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

BASE = "https://www.dsb.dk"
UA = "Mozilla/5.0 (dsb-dk-api-cli)"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser(
        "stations",
        help="list all stations (optionally filter by name)",
    )
    p.add_argument(
        "--query",
        "-q",
        default="",
        help="filter stations by name",
    )
    p.add_argument(
        "--raw",
        action="store_true",
        help="print raw JSON response",
    )
    p.set_defaults(func=cmd_stations)

    p = sub.add_parser(
        "station-detail",
        help="fetch a station detail page",
    )
    p.add_argument(
        "station_url",
        help="full URL of a station page, e.g. "
        "/trafikinformation/stationer/kobenhavn-h/",
    )
    p.set_defaults(func=cmd_station_detail)

    p = sub.add_parser(
        "traffic-info",
        help="fetch the traffic information page",
    )
    p.set_defaults(func=cmd_traffic_info)

    p = sub.add_parser(
        "prices-zones",
        help="fetch the prices and zones page",
    )
    p.set_defaults(func=cmd_prices_zones)

    p = sub.add_parser(
        "sitemap",
        help="enumerate URLs from /sitemap.xml",
    )
    p.add_argument(
        "--prefix",
        help="filter to URLs whose path starts with this",
    )
    p.add_argument(
        "--limit",
        type=int,
        help="only print the first N URLs",
    )
    p.set_defaults(func=cmd_sitemap)

    args = parser.parse_args()
    args.func(args)


def _request(
    path: str,
    method: str = "GET",
    body: bytes | None = None,
    headers: dict[str, str] | None = None,
    timeout: float = 30.0,
) -> tuple[int, bytes]:
    url = path if path.startswith("http") else BASE + path
    h: dict[str, str] = {
        "User-Agent": UA,
        "Accept": "*/*",
    }
    if headers:
        h.update(headers)
    req = urllib.request.Request(url, data=body, method=method, headers=h)
    try:
        with urllib.request.urlopen(
            req,
            timeout=timeout,
        ) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        body_text = e.read() if e.fp else b""
        sys.stderr.write(f"HTTP {e.code} {e.reason} on {method} {path}\n")
        if body_text:
            sys.stderr.write(
                body_text.decode("utf-8", errors="replace").rstrip() + "\n"
            )
        sys.exit(2)


def _emit(obj: t.Any) -> None:
    if isinstance(obj, (dict, list)):
        print(json.dumps(obj, ensure_ascii=False, indent=2))
    else:
        print(obj)


def _normalize(s: str) -> str:
    """Fold Danish letters to ASCII for fuzzy matching."""
    return s.lower().replace("æ", "ae").replace("ø", "o").replace("å", "aa")


def cmd_stations(args: argparse.Namespace) -> None:
    q = args.query or ""
    _, raw = _request(f"{BASE}/api/stations/getstationlist")
    data = json.loads(raw.decode("utf-8", errors="replace"))
    if q:
        q_norm = _normalize(q)
        data = [s for s in data if q_norm in _normalize(s.get("stationName", ""))]
    if args.raw:
        _emit(data)
        return
    for s in data:
        name = s.get("stationName", "")
        station_url = s.get("stationUrl", "")
        tags = ", ".join(s.get("tags", []))
        print(f"{name}\t{station_url}\t[{tags}]")


def cmd_station_detail(
    args: argparse.Namespace,
) -> None:
    station_url = args.station_url
    _, raw = _request(station_url)
    html = raw.decode("utf-8", errors="replace")
    # Print first 2000 chars of the station detail page
    print(html[:2000])


def cmd_traffic_info(
    args: argparse.Namespace,
) -> None:
    # Traffic info is served via Next.js at
    # /trafikinformation/
    _, raw = _request("/trafikinformation/")
    html = raw.decode("utf-8", errors="replace")
    print(html[:2000])


def cmd_prices_zones(
    args: argparse.Namespace,
) -> None:
    _, raw = _request("/priser-og-zoner/")
    html = raw.decode("utf-8", errors="replace")
    print(html[:2000])


def cmd_sitemap(args: argparse.Namespace) -> None:
    _, raw = _request("/sitemap.xml")
    xml = raw.decode("utf-8", errors="replace")
    locs = re.findall(r"<loc>([^<]+)</loc>", xml)
    if args.prefix:
        locs = [
            u for u in locs if urllib.parse.urlparse(u).path.startswith(args.prefix)
        ]
    if args.limit:
        locs = locs[: args.limit]
    if not locs:
        sys.stderr.write("No <loc> entries matched\n")
        sys.exit(2)
    for u in locs:
        print(u)


if __name__ == "__main__":
    main()
