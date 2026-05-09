#!/usr/bin/env python3
"""Thin CLI for the internal JSON API behind https://www.boligportal.dk/.

Standard library only. See ./SKILL.md for the full API specification.
"""
from __future__ import annotations

import argparse
import json
import sys
import typing as t
import urllib.error
import urllib.request

BASE = "https://www.boligportal.dk"
API = f"{BASE}/api"
UA = "Mozilla/5.0 (boligportal-dk-api-cli)"


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
    req = urllib.request.Request(
        url, data=body, method=method, headers=h)
    try:
        with urllib.request.urlopen(
            req, timeout=timeout,
        ) as r:
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


def _post(endpoint: str, body: dict) -> t.Any:
    payload = json.dumps(body).encode("utf-8")
    _, raw = _request(
        f"{API}/{endpoint}",
        method="POST",
        body=payload,
        headers={"Content-Type": "application/json"},
    )
    return json.loads(raw.decode("utf-8", errors="replace"))


def _emit(obj: t.Any, raw: bool = False) -> None:
    if raw:
        print(json.dumps(obj, ensure_ascii=False, indent=2))
    else:
        print(json.dumps(obj, ensure_ascii=False))


# ---------------------------------------------------------------------------
# Subcommand implementations
# ---------------------------------------------------------------------------


def cmd_search(args: argparse.Namespace) -> None:
    filt: dict[str, t.Any] = {}
    if args.city:
        filt["cityCode"] = args.city
    if args.type:
        filt["propertyType"] = args.type
    if args.min_area:
        filt["minArea"] = int(args.min_area)
    if args.max_area:
        filt["maxArea"] = int(args.max_area)
    if args.min_rooms:
        filt["minRooms"] = int(args.min_rooms)
    if args.max_rooms:
        filt["maxRooms"] = int(args.max_rooms)
    if args.min_price:
        filt["minPrice"] = int(args.min_price)
    if args.max_price:
        filt["maxPrice"] = int(args.max_price)
    if args.new_build:
        filt["newBuild"] = True
    if args.student_housing:
        filt["studentHousing"] = True

    resp = _post(
        "listing/listings/",
        {
            "page": args.page,
            "pageSize": args.limit,
            "filter": filt or {},
        },
    )
    if args.raw:
        _emit(resp, raw=True)
        return

    total = resp.get("total", "?")
    print(f"# {total} total")
    for item in resp.get("items", []):
        id_ = item.get("id", "")
        title = item.get("title", "")
        price = item.get("price", "")
        area = item.get("area", "")
        rooms = item.get("rooms", "")
        city = item.get("city", "")
        url = item.get("url", "")
        is_new = item.get("isNew", False)
        print(f"{id_}\t{title}\t{price}\t{area}\t{rooms}\t{city}\t{url}\t({is_new})")


def cmd_map(args: argparse.Namespace) -> None:
    filt: dict[str, t.Any] = {}
    if args.city:
        filt["cityCode"] = args.city
    if args.type:
        filt["propertyType"] = args.type
    if args.min_area:
        filt["minArea"] = int(args.min_area)
    if args.max_area:
        filt["maxArea"] = int(args.max_area)
    if args.min_rooms:
        filt["minRooms"] = int(args.min_rooms)
    if args.max_rooms:
        filt["maxRooms"] = int(args.max_rooms)
    if args.min_price:
        filt["minPrice"] = int(args.min_price)
    if args.max_price:
        filt["maxPrice"] = int(args.max_price)
    if args.new_build:
        filt["newBuild"] = True
    if args.student_housing:
        filt["studentHousing"] = True

    resp = _post(
        "search/map",
        {
            "page": args.page,
            "pageSize": args.limit,
            "filter": filt or {},
        },
    )
    if args.raw:
        _emit(resp, raw=True)
        return

    for item in resp.get("items", []):
        id_ = item.get("id", "")
        lat = item.get("lat", "")
        lng = item.get("lng", "")
        title = item.get("title", "")
        price = item.get("price", "")
        url = item.get("url", "")
        print(f"{id_}\t{lat}\t{lng}\t{title}\t{price}\t{url}")


def cmd_promoted(args: argparse.Namespace) -> None:
    filt: dict[str, t.Any] = {}
    if args.city:
        filt["cityCode"] = args.city

    resp = _post(
        "search/promoted-ads",
        {"filter": filt},
    )
    if args.raw:
        _emit(resp, raw=True)
        return

    for item in resp.get("items", []):
        id_ = item.get("id", "")
        title = item.get("title", "")
        price = item.get("price", "")
        city = item.get("city", "")
        url = item.get("url", "")
        print(f"{id_}\t{title}\t{price}\t{city}\t{url}")


def cmd_top_favorites(args: argparse.Namespace) -> None:
    resp = _post(
        "listing/top-favorite-ads/",
        {"limit": args.limit},
    )
    if args.raw:
        _emit(resp, raw=True)
        return

    for rank, item in enumerate(resp.get("items", []), start=1):
        id_ = item.get("id", "")
        title = item.get("title", "")
        price = item.get("price", "")
        area = item.get("area", "")
        rooms = item.get("rooms", "")
        city = item.get("city", "")
        url = item.get("url", "")
        print(f"{rank}\t{id_}\t{title}\t{price}\t{area}\t{rooms}\t{city}\t{url}")


def cmd_raw(args: argparse.Namespace) -> None:
    if args.body == "-":
        payload = sys.stdin.buffer.read()
    else:
        payload = args.body.encode("utf-8")
    _, raw = _request(
        f"{API}/{args.endpoint}",
        method="POST",
        body=payload,
        headers={"Content-Type": "application/json"},
    )
    data = json.loads(raw.decode("utf-8", errors="replace"))
    _emit(data, raw=True)


# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="cmd", required=True)

    # -- search -----------------------------------------------------------
    p = sub.add_parser("search", help="search listings by filter criteria")
    p.add_argument("--city", help="city code URL slug (e.g. kobenhavn)")
    p.add_argument(
        "--type",
        choices=["apartment", "room", "house", "townhouse", "student"],
        help="property type",
    )
    p.add_argument("--min-area", dest="min_area", help="minimum area in m²")
    p.add_argument("--max-area", dest="max_area", help="maximum area in m²")
    p.add_argument("--min-rooms", dest="min_rooms", help="minimum rooms")
    p.add_argument("--max-rooms", dest="max_rooms", help="maximum rooms")
    p.add_argument("--min-price", dest="min_price", help="minimum price DKK")
    p.add_argument("--max-price", dest="max_price", help="maximum price DKK")
    p.add_argument(
        "--new-build",
        dest="new_build",
        action="store_true",
        help="new construction only",
    )
    p.add_argument(
        "--student-housing",
        dest="student_housing",
        action="store_true",
        help="student housing only",
    )
    p.add_argument(
        "--page",
        type=int,
        default=0,
        help="page number (default 0)",
    )
    p.add_argument(
        "--limit",
        type=int,
        default=18,
        help="items per page (default 18)",
    )
    p.add_argument("--raw", action="store_true", help="print raw JSON")
    p.set_defaults(func=cmd_search)

    # -- map --------------------------------------------------------------
    p = sub.add_parser("map", help="map-view listings with lat/lng")
    p.add_argument("--city", help="city code URL slug")
    p.add_argument(
        "--type",
        choices=["apartment", "room", "house", "townhouse", "student"],
    )
    p.add_argument("--min-area", dest="min_area")
    p.add_argument("--max-area", dest="max_area")
    p.add_argument("--min-rooms", dest="min_rooms")
    p.add_argument("--max-rooms", dest="max_rooms")
    p.add_argument("--min-price", dest="min_price")
    p.add_argument("--max-price", dest="max_price")
    p.add_argument(
        "--new-build",
        dest="new_build",
        action="store_true",
    )
    p.add_argument(
        "--student-housing",
        dest="student_housing",
        action="store_true",
    )
    p.add_argument("--page", type=int, default=0)
    p.add_argument("--limit", type=int, default=18)
    p.add_argument("--raw", action="store_true")
    p.set_defaults(func=cmd_map)

    # -- promoted ---------------------------------------------------------
    p = sub.add_parser("promoted", help="sponsored / promoted listings")
    p.add_argument("--city", help="city code URL slug")
    p.add_argument("--raw", action="store_true")
    p.set_defaults(func=cmd_promoted)

    # -- top-favorites ----------------------------------------------------
    p = sub.add_parser(
        "top-favorites",
        help="most favorited listings across all users",
    )
    p.add_argument(
        "--limit",
        type=int,
        default=10,
        help="number of results (default 10)",
    )
    p.add_argument("--raw", action="store_true")
    p.set_defaults(func=cmd_top_favorites)

    # -- raw --------------------------------------------------------------
    p = sub.add_parser(
        "raw",
        help="POST a raw JSON body to any API endpoint",
    )
    p.add_argument(
        "endpoint",
        help="API path, e.g. 'listing/listings' (prefixed with /api/)",
    )
    p.add_argument(
        "body",
        help="inline JSON string, or '-' to read from stdin",
    )
    p.add_argument("--raw", action="store_true")
    p.set_defaults(func=cmd_raw)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
