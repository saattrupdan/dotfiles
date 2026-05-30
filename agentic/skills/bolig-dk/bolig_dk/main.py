#!/usr/bin/env python3
"""CLI for Danish housing listings.

Two sources, grouped as subcommands:

- ``bolig rent ...`` -- boligportal.dk, Denmark's largest *rental* marketplace.
  Internal JSON API (POST-only). Some endpoints are session-bound.
- ``bolig buy ...``  -- boligsiden.dk, the *for-sale* listing aggregator.
  Public HAL REST API (GET), behind Cloudflare Turnstile.

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

# --- boligportal.dk (rentals) ---
RENT_BASE = "https://www.boligportal.dk"
RENT_API = f"{RENT_BASE}/api"

# --- boligsiden.dk (for-sale) ---
BUY_API = "https://www.boligsiden.dk/api"

UA = "Mozilla/5.0 (bolig-dk-api-cli)"

# Danish city -> zip code, used to translate a free-text --city for the
# boligsiden /cases endpoint (which filters by zipCode, not city name).
CITY_ZIP_MAP: dict[str, str] = {
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
    "hillerod": "2800",
    "frederiksberg": "1800",
    "viborg": "8800",
    "soenderborg": "6400",
    "holte": "2840",
    "gentofte": "2820",
    "lyngby": "2800",
    "ballerup": "2750",
    "farum": "3520",
    "rodovre": "2610",
    "gladsaxe": "2860",
    "herlev": "2730",
    "alleroed": "3650",
}


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------


def _emit(obj: t.Any, raw: bool = False) -> None:
    """Print a JSON object, indented when ``raw`` is set."""
    if raw:
        print(json.dumps(obj, ensure_ascii=False, indent=2))
    else:
        print(json.dumps(obj, ensure_ascii=False))


# ---------------------------------------------------------------------------
# boligportal.dk (rentals) -- internal POST JSON API
# ---------------------------------------------------------------------------


class _NoRedirectHandler(urllib.request.HTTPErrorProcessor):
    """Prevent urllib from silently following 3xx redirects.

    boligportal redirects session-bound endpoints to ``/login`` instead of
    returning 401/403; we want to surface that rather than follow it.
    """

    def http_response(
        self, request: urllib.request.Request, response: t.Any
    ) -> t.Any:
        return response

    https_response = http_response


_rent_opener = urllib.request.build_opener(_NoRedirectHandler)


def _rent_request(
    path: str,
    method: str = "GET",
    body: bytes | None = None,
    headers: dict[str, str] | None = None,
    timeout: float = 30.0,
) -> tuple[int, bytes]:
    """Send a request to boligportal, surfacing login redirects as errors."""
    url = path if path.startswith("http") else RENT_BASE + path
    h: dict[str, str] = {"User-Agent": UA, "Accept": "*/*"}
    if headers:
        h.update(headers)
    req = urllib.request.Request(url, data=body, method=method, headers=h)
    try:
        with _rent_opener.open(req, timeout=timeout) as r:
            status: int = r.status
            raw: bytes = r.read()
            if status in (301, 302, 303, 307, 308):
                location = r.headers.get("location", "")
                if "/login" in location:
                    sys.stderr.write(
                        f"HTTP {status} -- endpoint requires authentication "
                        f"({method} {path} -> {location})\n"
                    )
                    sys.exit(2)
                sys.stderr.write(
                    f"HTTP {status} redirect to {location} on {method} {path}\n"
                )
                sys.exit(2)
            return status, raw
    except urllib.error.HTTPError as e:
        body_text = e.read() if e.fp else b""
        sys.stderr.write(f"HTTP {e.code} {e.reason} on {method} {path}\n")
        if body_text:
            sys.stderr.write(
                body_text.decode("utf-8", errors="replace").rstrip() + "\n"
            )
        sys.exit(2)


def _rent_post(endpoint: str, body: dict) -> t.Any:
    """POST a JSON body to a boligportal API endpoint and parse the result."""
    payload = json.dumps(body).encode("utf-8")
    status, raw = _rent_request(
        f"{RENT_API}/{endpoint}",
        method="POST",
        body=payload,
        headers={"Content-Type": "application/json"},
    )
    text = raw.decode("utf-8", errors="replace")
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        sys.stderr.write(
            f"HTTP {status} -- non-JSON response from POST {endpoint} "
            f"(endpoint may be unavailable or require authentication)\n"
        )
        sys.exit(2)


def _rent_filter(args: argparse.Namespace) -> dict[str, t.Any]:
    """Build the boligportal ``filter`` object from common search args."""
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
    return filt


def cmd_rent_search(args: argparse.Namespace) -> None:
    """Search rental listings by filter criteria (session-bound endpoint)."""
    resp = _rent_post(
        "listing/listings/",
        {"page": args.page, "pageSize": args.limit, "filter": _rent_filter(args)},
    )
    if args.raw:
        _emit(resp, raw=True)
        return

    print(f"# {resp.get('total', '?')} total")
    for item in resp.get("items", []):
        print(
            f"{item.get('id', '')}\t{item.get('title', '')}\t"
            f"{item.get('price', '')}\t{item.get('area', '')}\t"
            f"{item.get('rooms', '')}\t{item.get('city', '')}\t"
            f"{item.get('url', '')}\t({item.get('isNew', False)})"
        )


def cmd_rent_map(args: argparse.Namespace) -> None:
    """Map-view rental listings with lat/lng (HTTP 500 as of 2026-05)."""
    resp = _rent_post(
        "search/map",
        {"page": args.page, "pageSize": args.limit, "filter": _rent_filter(args)},
    )
    if args.raw:
        _emit(resp, raw=True)
        return

    for item in resp.get("items", []):
        print(
            f"{item.get('id', '')}\t{item.get('lat', '')}\t"
            f"{item.get('lng', '')}\t{item.get('title', '')}\t"
            f"{item.get('price', '')}\t{item.get('url', '')}"
        )


def cmd_rent_promoted(args: argparse.Namespace) -> None:
    """Sponsored / promoted rental listings (anonymous)."""
    filt: dict[str, t.Any] = {}
    if args.city:
        filt["cityCode"] = args.city
    resp = _rent_post("search/promoted-ads", {"filter": filt})
    if args.raw:
        _emit(resp, raw=True)
        return

    for item in resp.get("ads", []):
        print(
            f"{item.get('id', '')}\t{item.get('title', '')}\t"
            f"{item.get('monthly_rent', '')}\t{item.get('city', '')}\t"
            f"{item.get('url', '')}"
        )


def cmd_rent_top_favorites(args: argparse.Namespace) -> None:
    """Most-favorited rental listings across all users (session-bound)."""
    resp = _rent_post("listing/top-favorite-ads/", {"limit": args.limit})
    if args.raw:
        _emit(resp, raw=True)
        return

    for rank, item in enumerate(resp.get("items", []), start=1):
        print(
            f"{rank}\t{item.get('id', '')}\t{item.get('title', '')}\t"
            f"{item.get('price', '')}\t{item.get('area', '')}\t"
            f"{item.get('rooms', '')}\t{item.get('city', '')}\t"
            f"{item.get('url', '')}"
        )


def cmd_rent_raw(args: argparse.Namespace) -> None:
    """POST a raw JSON body to any boligportal API endpoint."""
    if args.body == "-":
        payload = sys.stdin.buffer.read()
    else:
        payload = args.body.encode("utf-8")
    _, raw = _rent_request(
        f"{RENT_API}/{args.endpoint}",
        method="POST",
        body=payload,
        headers={"Content-Type": "application/json"},
    )
    _emit(json.loads(raw.decode("utf-8", errors="replace")), raw=True)


# ---------------------------------------------------------------------------
# boligsiden.dk (for-sale) -- public HAL REST API
# ---------------------------------------------------------------------------


def _buy_request(
    path: str,
    method: str = "GET",
    params: dict[str, str] | None = None,
    body: bytes | None = None,
    headers: dict[str, str] | None = None,
) -> tuple[int, bytes]:
    """Send a request to the boligsiden HAL API."""
    url = path if path.startswith("http") else BUY_API + path
    if params:
        sep = "&" if "?" in url else "?"
        url += sep + urllib.parse.urlencode(params)
    h: dict[str, str] = {"User-Agent": UA, "Accept": "application/json"}
    if headers:
        h.update(headers)
    req = urllib.request.Request(url, data=body, method=method, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        body_text = e.read() if e.fp else b""
        sys.stderr.write(f"HTTP {e.code} {e.reason} on {method} {url}\n")
        if body_text:
            sys.stderr.write(
                body_text.decode("utf-8", errors="replace").rstrip() + "\n"
            )
        sys.exit(2)


def _buy_get(path: str, params: dict[str, str] | None = None) -> t.Any:
    """GET JSON from a boligsiden endpoint, handling Cloudflare challenges."""
    _, raw = _buy_request(path, method="GET", params=params)
    text = raw.decode("utf-8", errors="replace")
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        sys.stderr.write(
            "Could not parse API response as JSON (the server may be "
            "returning a Cloudflare challenge page).\n"
        )
        sys.stderr.write(text[:500] + "\n")
        sys.exit(2)


def cmd_buy_cases(args: argparse.Namespace) -> None:
    """Search for-sale property listings."""
    params: dict[str, str] = {"_page": str(args.page), "_limit": str(args.limit)}
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
    if args.type:
        params["addressType"] = args.type
    if args.city:
        city_lower = (
            args.city.lower()
            .strip()
            .replace("ø", "o")
            .replace("å", "a")
            .replace("æ", "ae")
        )
        if city_lower.isdigit():
            params["zipCode"] = city_lower
        else:
            mapped = False
            for key, val in CITY_ZIP_MAP.items():
                if key in city_lower or city_lower in key:
                    params["zipCode"] = val
                    mapped = True
                    break
            if not mapped:
                sys.stderr.write(
                    f"City {args.city!r} not in built-in map. Use "
                    "--municipality-code or --zip-code for precise filtering.\n"
                )

    resp = _buy_get("/cases", params)
    if args.raw:
        _emit(resp, raw=True)
        return

    page = resp.get("page", {})
    print(
        f"# {page.get('totalElements', '?')} total, "
        f"page {page.get('number', '?')}/{page.get('totalPages', '?')}"
    )
    for case in resp.get("_embedded", {}).get("cases", []):
        addr = case.get("address", {})
        price = case.get("priceCash", 0)
        print(
            f"{case.get('slugAddress', '')}\t"
            f"{addr.get('addressType', '?')}\t"
            f"{addr.get('cityName', '?')} {addr.get('zipCode', '?')}\t"
            f"{case.get('numberOfRooms', '?')} værelser\t"
            f"{case.get('housingArea', '?')} m²\t"
            f"{price:,.0f} kr\t"
            f"{case.get('descriptionTitle', 'Uden titel')}"
        )


def cmd_buy_address(args: argparse.Namespace) -> None:
    """Look up an address by street, city, or zip."""
    params: dict[str, str] = {"_limit": str(args.limit)}
    if args.q:
        params["q"] = args.q
    resp = _buy_get("/addresses", params)
    if args.raw:
        _emit(resp, raw=True)
        return

    for addr in resp.get("_embedded", {}).get("addresses", []):
        road = addr.get("roadName", "")
        number = addr.get("houseNumber", "")
        letter = addr.get("houseLetter", "")
        print(
            f"{road} {number}{letter}\t"
            f"{addr.get('zipCode', '')} {addr.get('cityName', '')}\t"
            f"{addr.get('addressType', '?')}"
        )


def cmd_buy_realtor(args: argparse.Namespace) -> None:
    """Search for real estate agencies by name or city."""
    params: dict[str, str] = {"_limit": str(args.limit)}
    if args.q:
        params["q"] = args.q
    resp = _buy_get("/realtors", params)
    if args.raw:
        _emit(resp, raw=True)
        return

    for r in resp.get("_embedded", {}).get("realtors", []):
        rating = r.get("rating", {})
        seller_score = rating.get("seller", {}).get("score", "?")
        buyer_score = rating.get("buyer", {}).get("score", "?")
        print(
            f"{r.get('name', '')}\t{r.get('url', '')}\t"
            f"seller:{seller_score}\tbuyer:{buyer_score}"
        )


def cmd_buy_municipalities(args: argparse.Namespace) -> None:
    """List all Danish municipalities with population."""
    resp = _buy_get("/municipalities", {"_limit": "200"})
    if args.raw:
        _emit(resp, raw=True)
        return

    for m in resp.get("_embedded", {}).get("municipalities", []):
        print(
            f"{m.get('municipalityCode', '')}\t{m.get('name', '')}\t"
            f"{m.get('population', '?')} indbyggere"
        )


def cmd_buy_raw(args: argparse.Namespace) -> None:
    """POST a raw query body (from a file) to a boligsiden API endpoint."""
    with open(args.file, "r", encoding="utf-8") as f:
        query = f.read()
    _, raw = _buy_request(
        f"/{args.endpoint}",
        method="POST",
        body=query.encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )
    text = raw.decode("utf-8", errors="replace")
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        sys.stderr.write(
            "Could not parse API response as JSON (the server may be "
            "returning a Cloudflare challenge page).\n"
        )
        sys.stderr.write(text[:500] + "\n")
        sys.exit(2)
    _emit(data, raw=True)


# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------


def _add_rent_filters(p: argparse.ArgumentParser) -> None:
    """Add the shared boligportal search filters to a parser."""
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
    p.add_argument("--page", type=int, default=0, help="page number (default 0)")
    p.add_argument(
        "--limit", type=int, default=18, help="items per page (default 18)"
    )
    p.add_argument("--raw", action="store_true", help="print raw JSON")


def _build_rent_parser(sub: t.Any) -> None:
    """Register the ``rent`` (boligportal.dk) command group."""
    rent = sub.add_parser(
        "rent", help="boligportal.dk — rental housing marketplace"
    )
    rsub = rent.add_subparsers(dest="cmd", required=True)

    p = rsub.add_parser("search", help="search rentals by filter criteria")
    _add_rent_filters(p)
    p.set_defaults(func=cmd_rent_search)

    p = rsub.add_parser("map", help="map-view rentals with lat/lng")
    _add_rent_filters(p)
    p.set_defaults(func=cmd_rent_map)

    p = rsub.add_parser("promoted", help="sponsored / promoted rentals")
    p.add_argument("--city", help="city code URL slug")
    p.add_argument("--raw", action="store_true")
    p.set_defaults(func=cmd_rent_promoted)

    p = rsub.add_parser(
        "top-favorites", help="most-favorited rentals across all users"
    )
    p.add_argument(
        "--limit", type=int, default=10, help="number of results (default 10)"
    )
    p.add_argument("--raw", action="store_true")
    p.set_defaults(func=cmd_rent_top_favorites)

    p = rsub.add_parser("raw", help="POST a raw JSON body to any endpoint")
    p.add_argument(
        "endpoint", help="API path, e.g. 'listing/listings' (under /api/)"
    )
    p.add_argument("body", help="inline JSON string, or '-' to read from stdin")
    p.set_defaults(func=cmd_rent_raw)


def _add_buy_common(p: argparse.ArgumentParser) -> None:
    """Add the shared boligsiden pagination/sort/raw options to a parser."""
    p.add_argument(
        "--limit", type=int, default=20, help="items per page (default 20)"
    )
    p.add_argument("--page", type=int, default=1, help="page number (default 1)")
    p.add_argument("--sort", help="sort field")
    p.add_argument("--order", choices=["asc", "desc"], help="sort order")
    p.add_argument("--raw", action="store_true", help="print raw JSON response")


def _build_buy_parser(sub: t.Any) -> None:
    """Register the ``buy`` (boligsiden.dk) command group."""
    buy = sub.add_parser("buy", help="boligsiden.dk — for-sale listing aggregator")
    bsub = buy.add_subparsers(dest="cmd", required=True)

    p = bsub.add_parser("cases", help="search for-sale property listings")
    p.add_argument("--min-price", dest="min_price", help="minimum price in DKK")
    p.add_argument("--max-price", dest="max_price", help="maximum price in DKK")
    p.add_argument("--min-area", dest="min_area", help="minimum area in m²")
    p.add_argument("--max-area", dest="max_area", help="maximum area in m²")
    p.add_argument("--min-rooms", dest="min_rooms", help="minimum rooms")
    p.add_argument("--max-rooms", dest="max_rooms", help="maximum rooms")
    p.add_argument(
        "--municipality-code",
        dest="municipality_code",
        help="municipality code",
    )
    p.add_argument("--zip-code", dest="zip_code", help="postal code")
    p.add_argument("--city", help="city name (approximate)")
    p.add_argument(
        "--type", help="property type (villa, lejlighed, rækkehus, etc.)"
    )
    _add_buy_common(p)
    p.set_defaults(func=cmd_buy_cases)

    p = bsub.add_parser("address", help="look up an address")
    p.add_argument("q", nargs="?", help="search term (street, city, zip)")
    _add_buy_common(p)
    p.set_defaults(func=cmd_buy_address)

    p = bsub.add_parser("realtor", help="search for real estate agencies")
    p.add_argument("q", nargs="?", help="search term (agency name, city)")
    _add_buy_common(p)
    p.set_defaults(func=cmd_buy_realtor)

    p = bsub.add_parser("municipalities", help="list all Danish municipalities")
    p.add_argument("--raw", action="store_true")
    p.set_defaults(func=cmd_buy_municipalities)

    p = bsub.add_parser("raw", help="POST a raw query body to an API endpoint")
    p.add_argument("endpoint", help="API path, e.g. 'cases' or 'realtors'")
    p.add_argument("file", help="file containing the JSON query body")
    p.set_defaults(func=cmd_buy_raw)


def main() -> None:
    """Entry point: parse arguments and dispatch to the selected command."""
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="source", required=True)
    _build_rent_parser(sub)
    _build_buy_parser(sub)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
