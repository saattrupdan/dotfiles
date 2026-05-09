#!/usr/bin/env python3
"""Thin CLI for the public HAL REST API behind https://www.boligsiden.dk/.

Standard library only. See ./SKILL.md for the full API specification.
"""
from __future__ import annotations

import argparse
import json
import sys
import typing as t
import urllib.error
import urllib.parse
import urllib.request

BASE = "https://www.boligsiden.dk/api"
UA = "Mozilla/5.0 (boligsiden-dk-api-cli)"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="cmd", required=True)

    def _add(
        name: str,
        help_text: str,
    ) -> argparse.ArgumentParser:
        p = sub.add_parser(name, help=help_text)
        return p

    def _add_common(p: argparse.ArgumentParser) -> None:
        p.add_argument(
            "--limit",
            type=int,
            default=20,
            help="items per page (default 20)",
        )
        p.add_argument(
            "--page",
            type=int,
            default=1,
            help="page number (default 1)",
        )
        p.add_argument("--sort", help="sort field")
        p.add_argument(
            "--order",
            choices=["asc", "desc"],
            help="sort order",
        )
        p.add_argument(
            "--raw",
            action="store_true",
            help="print raw JSON response",
        )

    # cases
    p = _add("cases", "search property listings")
    p.add_argument(
        "--min-price",
        dest="min_price",
        help="minimum price in DKK",
    )
    p.add_argument(
        "--max-price",
        dest="max_price",
        help="maximum price in DKK",
    )
    p.add_argument(
        "--min-area",
        dest="min_area",
        help="minimum area in m²",
    )
    p.add_argument(
        "--max-area",
        dest="max_area",
        help="maximum area in m²",
    )
    p.add_argument(
        "--min-rooms",
        dest="min_rooms",
        help="minimum rooms",
    )
    p.add_argument(
        "--max-rooms",
        dest="max_rooms",
        help="maximum rooms",
    )
    p.add_argument(
        "--municipality-code",
        dest="municipality_code",
        help="municipality code",
    )
    p.add_argument(
        "--zip-code",
        dest="zip_code",
        help="postal code",
    )
    p.add_argument(
        "--city",
        help="city name (approximate)",
    )
    p.add_argument(
        "--type",
        dest="address_type",
        help="property type (villa, lejlighed, etc.)",
    )
    _add_common(p)
    p.set_defaults(func=cmd_cases)

    # address
    p = _add("address", "look up an address")
    p.add_argument(
        "q",
        nargs="?",
        help="search term (street, city, zip)",
    )
    _add_common(p)
    p.set_defaults(func=cmd_address)

    # realtor
    p = _add("realtor", "search for real estate agencies")
    p.add_argument(
        "q",
        nargs="?",
        help="search term (agency name, city)",
    )
    _add_common(p)
    p.set_defaults(func=cmd_realtor)

    # municipalities
    p = _add("municipalities", "list all Danish municipalities")
    p.add_argument("--raw", action="store_true")
    p.set_defaults(func=cmd_municipalities)

    # raw
    p = _add(
        "raw",
        "POST a raw query body to an API endpoint",
    )
    p.add_argument(
        "endpoint",
        help="API path, e.g. 'cases' or 'realtors'",
    )
    p.add_argument(
        "file",
        help="file containing the JSON query body",
    )
    p.set_defaults(func=cmd_raw)

    args = parser.parse_args()
    args.func(args)


def _request(
    path: str,
    method: str = "GET",
    params: dict[str, str] | None = None,
    body: bytes | None = None,
    headers: dict[str, str] | None = None,
) -> tuple[int, bytes]:
    url = path if path.startswith("http") else BASE + path
    if params:
        sep = "&" if "?" in url else "?"
        url += sep + urllib.parse.urlencode(params)
    h: dict[str, str] = {
        "User-Agent": UA,
        "Accept": "application/json",
    }
    if headers:
        h.update(headers)
    req = urllib.request.Request(
        url, data=body, method=method, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        body_text = e.read() if e.fp else b""
        sys.stderr.write(
            f"HTTP {e.code} {e.reason} on "
            f"{method} {url}\n")
        if body_text:
            sys.stderr.write(
                body_text.decode("utf-8", errors="replace")
                .rstrip() + "\n")
        sys.exit(2)


def _get(
    path: str,
    params: dict[str, str] | None = None,
) -> t.Any:
    _, raw = _request(path, method="GET", params=params)
    return json.loads(
        raw.decode("utf-8", errors="replace"),
    )


def _emit(obj: t.Any, raw: bool = False) -> None:
    if raw:
        print(json.dumps(obj, ensure_ascii=False, indent=2))
    else:
        print(json.dumps(obj, ensure_ascii=False))


def _check_errors(resp: t.Any) -> t.Any:
    if isinstance(resp, dict) and "errors" in resp:
        sys.stderr.write("API errors:\n")
        json.dump(
            resp["errors"],
            sys.stderr,
            ensure_ascii=False,
            indent=2,
        )
        sys.stderr.write("\n")
    return resp


def cmd_cases(args: argparse.Namespace) -> None:
    params: dict[str, str] = {
        "_page": str(args.page),
        "_limit": str(args.limit),
    }
    if args.sort:
        params["_sort"] = args.sort
    if args.order:
        params["_order"] = args.order
    if args.min_price:
        params["priceCash_min"] = args.min_price
    if args.max_price:
        params["priceCash_max"] = args.max_price
    if args.min_area:
        params["housingArea_min"] = args.min_area
    if args.max_area:
        params["housingArea_max"] = args.max_area
    if args.min_rooms:
        params["numberOfRooms_min"] = args.min_rooms
    if args.max_rooms:
        params["numberOfRooms_max"] = args.max_rooms
    if args.municipality_code:
        params["municipalityCode"] = args.municipality_code
    if args.zip_code:
        params["zipCode"] = args.zip_code
    if args.city:
        city_lower = (
            args.city.lower().strip()
            .replace("ø", "o")
            .replace("å", "a")
            .replace("æ", "ae"))
        # Direct zip code input
        if city_lower.isdigit():
            params["zipCode"] = city_lower
        else:
            # Common Danish city to zip code mapping
            city_zip_map: dict[str, str] = {
                "kobenhavn": "1000",
                "københavn": "1000",
                "aarhus": "8000",
                "arhus": "8000",
                "odense": "5000",
                "aalborg": "9000",
                "esbjerg": "6700",
                "randers": "8900",
                "vejle": "7100",
                "roskilde": "4000",
                "holstebro": "7500",
                "kobing": "6500",
                "soder": "2700",
                "sodert": "2700",
                "hillerod": "2800",
                "frederiksberg": "1800",
                "viborg": "8800",
                "soenderborg": "6400",
                "nag": "4000",
                "kou": "6000",
                "soroe": "4000",
                "holte": "2840",
                "gentofte": "2820",
                "lyngby": "2800",
                "ballerup": "2750",
                "farum": "3520",
                "rodovre": "2610",
                "gladsaxe": "2860",
                "herlev": "2730",
                "alleroed": "3650",
                "nordsjaelland": "3650",
            }
            # Try exact match first, then substring
            mapped = False
            for key, val in city_zip_map.items():
                if key in city_lower or city_lower in key:
                    params["zipCode"] = val
                    mapped = True
                    break
            if not mapped:
                # No mapping found - use explicit filters
                sys.stderr.write(
                    f"City {args.city!r} not in built-in "
                    "map. Use --municipality-code or "
                    "--zip-code for precise filtering.\n")

    resp = _get("/cases", params)
    if args.raw:
        _emit(resp, raw=True)
        return

    # Pretty-print summary
    page = resp.get("page", {})
    print(
        f"# {page.get('totalElements', '?')} total, "
        f"page "
        f"{page.get('number', '?')}"
        f"/{page.get('totalPages', '?')}")
    cases = (
        resp.get("_embedded", {})
        .get("cases", []))
    for case in cases:
        addr = case.get("address", {})
        title = case.get(
            "descriptionTitle",
            "Uden titel")
        price = case.get("priceCash", 0)
        area = case.get("housingArea", "?")
        rooms = case.get("numberOfRooms", "?")
        city = addr.get("cityName", "?")
        zip_code = addr.get("zipCode", "?")
        prop_type = addr.get("addressType", "?")
        print(
            f"{case.get('slugAddress', '')}\t"
            f"{prop_type}\t"
            f"{city} {zip_code}\t"
            f"{rooms} værelser\t"
            f"{area} m²\t"
            f"{price:,.0f} kr\t"
            f"{title}")


def cmd_address(args: argparse.Namespace) -> None:
    params: dict[str, str] = {"_limit": str(args.limit)}
    if args.q:
        params["q"] = args.q
    resp = _get("/addresses", params)
    if args.raw:
        _emit(resp, raw=True)
        return

    addresses = (
        resp.get("_embedded", {})
        .get("addresses", []))
    for addr in addresses:
        road = addr.get("roadName", "")
        number = addr.get("houseNumber", "")
        letter = addr.get("houseLetter", "")
        zip_c = addr.get("zipCode", "")
        city = addr.get("cityName", "")
        print(
            f"{road} {number}{letter}\t"
            f"{zip_c} {city}\t"
            f"{addr.get('addressType', '?')}")


def cmd_realtor(args: argparse.Namespace) -> None:
    params: dict[str, str] = {"_limit": str(args.limit)}
    if args.q:
        params["q"] = args.q
    resp = _get("/realtors", params)
    if args.raw:
        _emit(resp, raw=True)
        return

    realtors = (
        resp.get("_embedded", {})
        .get("realtors", []))
    for r in realtors:
        name = r.get("name", "")
        url = r.get("url", "")
        rating = r.get("rating", {})
        seller_score = (
            rating.get("seller", {})
            .get("score", "?"))
        buyer_score = (
            rating.get("buyer", {})
            .get("score", "?"))
        print(
            f"{name}\t{url}\t"
            f"seller:{seller_score}\t"
            f"buyer:{buyer_score}")


def cmd_municipalities(
    args: argparse.Namespace,
) -> None:
    resp = _get("/municipalities", {"_limit": "200"})
    if args.raw:
        _emit(resp, raw=True)
        return

    items = (
        resp.get("_embedded", {})
        .get("municipalities", []))
    for m in items:
        name = m.get("name", "")
        code = m.get("municipalityCode", "")
        pop = m.get("population", "?")
        print(f"{code}\t{name}\t{pop} indbyggere")


def cmd_raw(args: argparse.Namespace) -> None:
    with open(args.file, "r", encoding="utf-8") as f:
        query = f.read()
    _, raw = _request(
        "/cases",
        method="POST",
        body=query.encode("utf-8"),
        headers={
            "Content-Type": "application/json",
        },
    )
    data = json.loads(
        raw.decode("utf-8", errors="replace"))
    _emit(data, raw=True)


if __name__ == "__main__":
    main()
