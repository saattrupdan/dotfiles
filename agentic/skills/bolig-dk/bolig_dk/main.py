#!/usr/bin/env python3
"""CLI for Danish housing listings.

Two sources, grouped as subcommands:

- ``bolig rent ...`` -- boligportal.dk, Denmark's largest *rental* marketplace.
  Internal JSON API (POST-only). Some endpoints are session-bound.
- ``bolig buy ...``  -- boligsiden.dk, the *for-sale* listing aggregator.
  The www site/API are behind a Cloudflare managed challenge, so this talks
  to the ungated data host api.boligsiden.dk (HAL-style GET JSON).

Standard library only. See ./SKILL.md for the full API specification.
"""

from __future__ import annotations

import argparse
import html
import json
import os
import re
import sys
import time
import typing as t
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

# --- boligportal.dk (rentals) ---
RENT_BASE = "https://www.boligportal.dk"
RENT_API = f"{RENT_BASE}/api"

# --- boligsiden.dk (for-sale) ---
# The www.boligsiden.dk front-end and its /api/ HAL endpoints sit behind a
# Cloudflare managed challenge (cf-mitigated: challenge) that a non-browser
# client can't solve. The data-only host api.boligsiden.dk is NOT gated, so all
# `bolig buy` traffic goes there instead.
BUY_API = "https://api.boligsiden.dk"

UA = "Mozilla/5.0 (bolig-dk-api-cli)"
# boligportal's HTML pages gate non-browser User-Agents, so the hub/detail
# scraper (used for keyword/body search) presents a realistic browser UA.
BROWSER_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)

# boligportal property type -> URL category slug for hub pages.
RENT_CATEGORY_PATH: dict[str, str] = {
    "apartment": "lejligheder",
    "room": "værelser",
    "house": "huse",
    "townhouse": "rækkehuse",
}

# Danish (and English) property-type label -> boligsiden addressType. The
# /search/cases endpoint filters on the English addressType values; we accept
# the common Danish words too. Unknown values pass through unchanged.
BUY_ADDRESS_TYPES: dict[str, str] = {
    "lejlighed": "condo",
    "ejerlejlighed": "condo",
    "condo": "condo",
    "andelsbolig": "cooperative",
    "andelslejlighed": "cooperative",
    "cooperative": "cooperative",
    "villa": "villa",
    "hus": "villa",
    "parcelhus": "villa",
    "rækkehus": "terraced house",
    "raekkehus": "terraced house",
    "terraced house": "terraced house",
    "villalejlighed": "villa apartment",
    "villa apartment": "villa apartment",
    "landejendom": "farm",
    "gård": "farm",
    "farm": "farm",
    "nedlagt landbrug": "hobby farm",
    "hobby farm": "hobby farm",
    "fritidshus": "holiday house",
    "sommerhus": "holiday house",
    "holiday house": "holiday house",
    "fritidsgrund": "holiday plot",
    "holiday plot": "holiday plot",
    "grund": "full year plot",
    "helårsgrund": "full year plot",
    "full year plot": "full year plot",
    "husbåd": "houseboat",
    "houseboat": "houseboat",
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


def _num(val: t.Any) -> float | None:
    """Coerce a value like ``"8300.0"`` to a float, or None if not numeric."""
    if val is None or val == "":
        return None
    try:
        return float(val)
    except (ValueError, TypeError):
        return None


def _matches(text: str, keywords: list[str], mode: str) -> bool:
    """Test whether ``text`` contains the keywords (case-insensitive).

    Args:
        text: Haystack to search.
        keywords: Terms to look for.
        mode: ``"all"`` requires every keyword, ``"any"`` requires one.
    """
    low = text.lower()
    hits = [k.lower() in low for k in keywords]
    return all(hits) if mode == "all" else any(hits)


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


def _rent_get_html(url: str) -> str:
    """GET an HTML page from boligportal with a browser User-Agent."""
    req = urllib.request.Request(
        url, headers={"User-Agent": BROWSER_UA, "Accept": "text/html"}
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        sys.stderr.write(f"HTTP {e.code} {e.reason} on GET {url}\n")
        sys.exit(2)


def _app_json(html: str) -> dict | None:
    """Extract the embedded ``application/json`` app-state blob from a page.

    boligportal renders each page's data into a single ``<script
    type="application/json">`` tag (SearchResultApp on hub pages, AdDetailApp
    on listing pages). Returns the parsed object or None if absent/unparseable.
    """
    m = re.search(
        r'<script[^>]*type="application/json"[^>]*>(.*?)</script>', html, re.S
    )
    if not m:
        return None
    try:
        return json.loads(m.group(1))
    except json.JSONDecodeError:
        return None


def _rent_hub_url(args: argparse.Namespace, offset: int) -> str:
    """Build a boligportal hub (search-results) URL from search args.

    Category and city live in the path; only ``min_size_m2`` and
    ``max_monthly_rent`` are honoured server-side (the rest are filtered
    client-side from the result rows). Student housing uses a dedicated path.
    """
    if args.city:
        city_slug = urllib.parse.quote(
            urllib.parse.unquote(args.city), safe=""
        )
    else:
        city_slug = ""

    if args.type == "student":
        if not city_slug:
            sys.stderr.write("student housing search requires --city\n")
            sys.exit(2)
        base = f"{RENT_BASE}/studieboliger-{city_slug}/c/"
    else:
        category = RENT_CATEGORY_PATH.get(args.type, "lejeboliger")
        base = f"{RENT_BASE}/{category}/"
        if city_slug:
            base += f"{city_slug}/"

    params: dict[str, str] = {}
    if args.min_area:
        params["min_size_m2"] = str(args.min_area)
    if args.max_price:
        params["max_monthly_rent"] = str(args.max_price)
    if args.new_build:
        params["newbuild"] = "1"
    if offset:
        params["offset"] = str(offset)
    if params:
        base += "?" + urllib.parse.urlencode(params)
    return base


def _rent_passes(item: dict, args: argparse.Namespace) -> bool:
    """Apply the client-side rent filters not supported by the hub URL."""
    rent = _num(item.get("monthly_rent"))
    size = _num(item.get("size_m2"))
    rooms = _num(item.get("rooms"))
    if args.min_price and rent is not None and rent < float(args.min_price):
        return False
    if args.max_area and size is not None and size > float(args.max_area):
        return False
    if args.min_rooms and rooms is not None and rooms < float(args.min_rooms):
        return False
    if args.max_rooms and rooms is not None and rooms > float(args.max_rooms):
        return False
    return True


def _rent_print_item(item: dict) -> None:
    """Print one rental result row as tab-separated fields."""
    print(
        f"{item.get('id', '')}\t{item.get('title', '')}\t"
        f"{_num(item.get('rooms')) or item.get('rooms', '')} vær\t"
        f"{_num(item.get('size_m2')) or item.get('size_m2', '')} m²\t"
        f"{_num(item.get('monthly_rent')) or item.get('monthly_rent', '')} kr\t"
        f"{item.get('city', '')}\t{RENT_BASE}{item.get('url', '')}"
    )


def cmd_rent_search(args: argparse.Namespace) -> None:
    """Search rentals via the anonymous hub pages, with optional body search.

    Enumerates listings from the public search-results pages (no login
    required, unlike the JSON listings endpoint). With ``--keyword``, fetches
    each candidate's detail page and keeps only listings whose description body
    or title contains the term(s); detail fetches are capped by ``--max-scan``.
    """
    results: list[dict] = []
    scanned = 0
    offset = max(args.page, 0) * 18

    while len(results) < args.limit:
        app = _app_json(_rent_get_html(_rent_hub_url(args, offset)))
        page_props = (app or {}).get("props", {}).get("page_props", {})
        rows: list[dict] = page_props.get("results", [])
        if not rows:
            break

        for item in rows:
            if not _rent_passes(item, args):
                continue
            if args.keyword:
                if scanned >= args.max_scan:
                    break
                scanned += 1
                detail = _app_json(
                    _rent_get_html(RENT_BASE + item.get("url", ""))
                )
                ad = (detail or {}).get("props", {}).get("page_props", {}).get(
                    "ad", {}
                )
                haystack = " ".join(
                    [
                        ad.get("description") or "",
                        ad.get("title") or "",
                        item.get("title") or "",
                    ]
                )
                if not _matches(haystack, args.keyword, args.match):
                    continue
                item["_description"] = ad.get("description", "")
            results.append(item)
            if len(results) >= args.limit:
                break

        if args.keyword and scanned >= args.max_scan:
            break
        if not page_props.get("next_page_url"):
            break
        offset += 18

    if args.raw:
        _emit(results, raw=True)
        return

    if args.keyword:
        print(
            f"# {len(results)} match(es) for "
            f"{args.match}({', '.join(args.keyword)}) "
            f"after scanning {scanned} listing(s)"
        )
    else:
        print(f"# {len(results)} listing(s)")
    for item in results:
        _rent_print_item(item)


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
    params: list[tuple[str, str]] | None = None,
) -> tuple[int, bytes]:
    """GET from the boligsiden data API (api.boligsiden.dk).

    ``params`` is a list of ``(key, value)`` pairs so filters like ``cities``
    can repeat; values are URL-encoded here.
    """
    url = path if path.startswith("http") else BUY_API + path
    if params:
        sep = "&" if "?" in url else "?"
        url += sep + urllib.parse.urlencode(params)
    h = {"User-Agent": UA, "Accept": "application/json"}
    req = urllib.request.Request(url, method="GET", headers=h)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        body_text = e.read() if e.fp else b""
        sys.stderr.write(f"HTTP {e.code} {e.reason} on GET {url}\n")
        if body_text:
            sys.stderr.write(
                body_text.decode("utf-8", errors="replace").rstrip() + "\n"
            )
        sys.exit(2)


def _buy_get(path: str, params: list[tuple[str, str]] | None = None) -> t.Any:
    """GET and parse JSON from a boligsiden endpoint."""
    _, raw = _buy_request(path, params=params)
    text = raw.decode("utf-8", errors="replace")
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        sys.stderr.write(
            f"Could not parse API response as JSON from GET {path}.\n"
        )
        sys.stderr.write(text[:500] + "\n")
        sys.exit(2)


def _buy_case_params(args: argparse.Namespace) -> list[tuple[str, str]]:
    """Build the ``/search/cases`` query params from search args.

    Geography is filtered by ``cities`` / ``municipalities`` (place slugs, e.g.
    ``frederiksberg``, ``københavn``) and ``zipCodes`` — all repeatable. Note
    that whole big cities (København, Aarhus, …) are *municipalities*, while
    ``--city`` takes a place/district slug (``frederiksberg``, ``aarhus c``).
    """
    params: list[tuple[str, str]] = []
    if args.sort:
        params.append(("sort", args.sort))
    if args.order:
        params.append(("sortAscending", "true" if args.order == "asc" else "false"))
    if args.min_price:
        params.append(("priceMin", args.min_price))
    if args.max_price:
        params.append(("priceMax", args.max_price))
    if args.min_monthly_fee:
        params.append(("monthlyExpenseMin", args.min_monthly_fee))
    if args.max_monthly_fee:
        params.append(("monthlyExpenseMax", args.max_monthly_fee))
    if args.min_area:
        params.append(("areaMin", args.min_area))
    if args.max_area:
        params.append(("areaMax", args.max_area))
    if args.min_rooms:
        params.append(("numberOfRoomsMin", args.min_rooms))
    if args.max_rooms:
        params.append(("numberOfRoomsMax", args.max_rooms))
    # Floor (stueetage / ground floor == 0). Use `is not None` so floor 0 isn't
    # dropped as falsy. floorMax alone — especially =0 — 400s, so default
    # floorMin to 0 when only an upper bound is given (floors start at ground).
    min_floor, max_floor = args.min_floor, args.max_floor
    if max_floor is not None and min_floor is None:
        min_floor = "0"
    if min_floor is not None:
        params.append(("floorMin", min_floor))
    if max_floor is not None:
        params.append(("floorMax", max_floor))
    for city in args.city or []:
        params.append(("cities", city.strip().lower()))
    for muni in args.municipality or []:
        params.append(("municipalities", muni.strip().lower()))
    for zc in args.zip_code or []:
        params.append(("zipCodes", zc))
    for raw_type in args.type or []:
        params.append(
            ("addressTypes", BUY_ADDRESS_TYPES.get(raw_type.lower(), raw_type))
        )
    return params


def cmd_buy_cases(args: argparse.Namespace) -> None:
    """Search for-sale property listings."""
    base = _buy_case_params(args)

    if args.keyword:
        cases, scanned, fetched, cached = _buy_cases_by_keyword(args, base)
        if args.raw:
            _emit(cases, raw=True)
            return
        deep = (
            f", {fetched} deep fetch(es), {cached} cached" if args.deep else ""
        )
        print(
            f"# {len(cases)} match(es) for "
            f"{args.match}({', '.join(args.keyword)}) "
            f"after scanning {scanned} listing(s){deep}"
        )
        for case in cases:
            _buy_print_case(case)
        return

    params = base + [("page", str(args.page)), ("per_page", str(args.limit))]
    resp = _buy_get("/search/cases", params)
    if args.raw:
        _emit(resp, raw=True)
        return

    total = resp.get("totalHits", 0)
    total_pages = (total + args.limit - 1) // args.limit if args.limit else "?"
    print(f"# {total} total, page {args.page}/{total_pages}")
    for case in resp.get("cases") or []:
        _buy_print_case(case)


def _json_descriptions(obj: t.Any) -> list[str]:
    """Recursively collect every ``description`` string from a JSON-LD blob."""
    out: list[str] = []
    if isinstance(obj, dict):
        if isinstance(obj.get("description"), str):
            out.append(obj["description"])
        for v in obj.values():
            out.extend(_json_descriptions(v))
    elif isinstance(obj, list):
        for v in obj:
            out.extend(_json_descriptions(v))
    return out


# Caps for the deep agency-page fetch, so a stray huge/JS-heavy page can't
# blow up memory or the keyword haystack.
_DEEP_MAX_HTML = 3_000_000  # bytes of HTML to read per page
_DEEP_MAX_TEXT = 15_000  # chars of extracted description to keep

# On-disk cache for deep fetches, so repeat runs don't re-ping agency pages
# (descriptions rarely change). Keyed by caseUrl -> {"text", "ts"}.
_DEEP_CACHE_PATH = os.path.join(
    os.environ.get("XDG_CACHE_HOME") or os.path.expanduser("~/.cache"),
    "bolig-dk",
    "deep-text.json",
)


def _deep_cache_load() -> dict[str, dict]:
    """Load the deep-fetch cache, or return an empty dict if absent/corrupt."""
    try:
        with open(_DEEP_CACHE_PATH, encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def _deep_cache_save(cache: dict[str, dict]) -> None:
    """Persist the deep-fetch cache (best-effort; ignores write errors)."""
    try:
        os.makedirs(os.path.dirname(_DEEP_CACHE_PATH), exist_ok=True)
        with open(_DEEP_CACHE_PATH, "w", encoding="utf-8") as f:
            json.dump(cache, f, ensure_ascii=False)
    except OSError:
        pass


def _buy_fetch_full_text(url: str) -> str | None:
    """Fetch a listing's full description from the agency page behind ``caseUrl``.

    boligsiden's API caps ``descriptionBody`` at ~500 chars and its own site is
    Cloudflare-gated, but each case's ``caseUrl`` redirects to the realtor's own
    listing page, which carries the full text and is not gated. Rather than keep
    the whole page (agencies differ and new ones keep appearing), we pull only
    the standard description fields — JSON-LD ``description``, then
    ``og:``/``meta`` description — which are agency-agnostic. Only if neither
    exists do we fall back to the few longest visible text blocks. Both the
    download and the kept text are capped.

    Returns the extracted text (possibly ``""`` if the page has no usable
    server-side text — e.g. JS-rendered), or ``None`` on a fetch error so the
    caller can choose not to cache it and retry later.
    """
    req = urllib.request.Request(
        url, headers={"User-Agent": BROWSER_UA, "Accept": "text/html"}
    )
    try:
        with urllib.request.urlopen(req, timeout=25) as r:
            doc = r.read(_DEEP_MAX_HTML).decode("utf-8", errors="replace")
    except (urllib.error.URLError, TimeoutError, OSError):
        return None

    parts: list[str] = []
    for block in re.findall(
        r'<script[^>]*type="application/ld\+json"[^>]*>(.*?)</script>', doc, re.S
    ):
        try:
            parts.extend(_json_descriptions(json.loads(block)))
        except json.JSONDecodeError:
            continue
    m = re.search(
        r'<meta[^>]+(?:property|name)="(?:og:)?description"[^>]+'
        r'content="([^"]*)"',
        doc,
        re.I,
    )
    if m:
        parts.append(html.unescape(m.group(1)))
    if not parts:
        text = re.sub(r"<(script|style)[^>]*>.*?</\1>", " ", doc, flags=re.S | re.I)
        text = html.unescape(re.sub(r"<[^>]+>", " ", text))
        blocks = sorted(
            {ln.strip() for ln in re.split(r"[\n.]", text) if len(ln.strip()) > 200},
            key=len,
            reverse=True,
        )
        parts.extend(blocks[:3])
    return " ".join(parts)[:_DEEP_MAX_TEXT]


def _buy_cases_by_keyword(
    args: argparse.Namespace, base: list[tuple[str, str]]
) -> tuple[list[dict], int, int]:
    """Page through ``/search/cases`` keeping matches on the description body.

    boligsiden embeds ``descriptionTitle``/``descriptionBody`` on each case, so
    the body search is a client-side filter. The API truncates the body to ~500
    chars; with ``--deep`` we additionally fetch the full text from the agency
    page (only when the truncated text doesn't already match, to save requests).
    Those deep fetches run concurrently per page (``--deep-workers`` threads),
    but matches are assembled in listing order so results are deterministic.
    Full texts are cached on disk by ``caseUrl`` (TTL ``--cache-ttl-days``, off
    with ``--no-cache``), so repeat runs skip pages already fetched. Pages are
    fetched 50 at a time until ``--limit`` matches are collected or
    ``--max-scan`` cases are seen.

    Returns ``(matches, scanned_count, deep_fetch_count, cache_hit_count)``.
    """
    matches: list[dict] = []
    scanned = 0
    fetched = 0
    cache_hits = 0
    page = args.page

    use_cache = args.deep and not args.no_cache
    cache = _deep_cache_load() if use_cache else {}
    cache_dirty = False
    ttl = args.cache_ttl_days * 86400
    now = time.time()

    while len(matches) < args.limit and scanned < args.max_scan:
        params = base + [("page", str(page)), ("per_page", "50")]
        resp = _buy_get("/search/cases", params)
        cases = resp.get("cases") or []
        if not cases:
            break

        # Inspect this page (respecting --max-scan), recording for each case the
        # cheap haystack and whether the truncated text already matches.
        page_items: list[tuple[dict, str, bool]] = []
        for case in cases:
            if scanned >= args.max_scan:
                break
            scanned += 1
            haystack = " ".join(
                [
                    case.get("descriptionTitle") or "",
                    case.get("descriptionBody") or "",
                ]
            )
            page_items.append(
                (case, haystack, _matches(haystack, args.keyword, args.match))
            )

        # Resolve full text for the not-yet-matching candidates: serve from
        # cache where fresh, fetch the rest concurrently.
        full_texts: dict[int, str] = {}
        if args.deep:
            misses: list[tuple[int, str]] = []
            for i, (case, _, hit) in enumerate(page_items):
                url = case.get("caseUrl")
                if hit or not url:
                    continue
                entry = cache.get(url) if use_cache else None
                if entry and now - entry.get("ts", 0) < ttl:
                    full_texts[i] = entry.get("text", "")
                    cache_hits += 1
                else:
                    misses.append((i, url))
            if misses:
                fetched += len(misses)
                workers = min(max(args.deep_workers, 1), len(misses))
                with ThreadPoolExecutor(max_workers=workers) as pool:
                    results = pool.map(
                        _buy_fetch_full_text, (u for _, u in misses)
                    )
                    for (i, url), text in zip(misses, results):
                        full_texts[i] = text or ""
                        if use_cache and text is not None:
                            cache[url] = {"text": text, "ts": now}
                            cache_dirty = True

        # Assemble matches in listing order, applying deep results where present.
        for i, (case, haystack, hit) in enumerate(page_items):
            if not hit and full_texts.get(i):
                hit = _matches(
                    f"{haystack} {full_texts[i]}", args.keyword, args.match
                )
            if hit:
                matches.append(case)
                if len(matches) >= args.limit:
                    break

        if scanned >= resp.get("totalHits", scanned):
            break
        page += 1

    if cache_dirty:
        _deep_cache_save(cache)
    return matches, scanned, fetched, cache_hits


def _buy_print_case(case: dict) -> None:
    """Print one for-sale case as tab-separated fields."""
    addr = case.get("address", {})
    price = case.get("priceCash") or 0
    case_id = case.get("caseID", "")
    url = f"https://boligsiden.dk/viderestilling/{case_id}" if case_id else ""
    print(
        f"{addr.get('cityName', '?')} {addr.get('zipCode', '?')}\t"
        f"{case.get('addressType', '?')}\t"
        f"{case.get('numberOfRooms', '?')} værelser\t"
        f"{case.get('housingArea', '?')} m²\t"
        f"{price:,.0f} kr\t"
        f"{case.get('descriptionTitle') or 'Uden titel'}\t"
        f"{url}"
    )


def cmd_buy_address(args: argparse.Namespace) -> None:
    """Look up an address by (the start of) a road name.

    The API's ``text`` filter is a road-name prefix match, so pass a road name
    like ``strandvejen`` rather than a full street + city + number string.
    """
    params: list[tuple[str, str]] = [("per_page", str(args.limit))]
    if args.q:
        params.append(("text", args.q))
    resp = _buy_get("/search/addresses", params)
    if args.raw:
        _emit(resp, raw=True)
        return

    for addr in resp.get("addresses") or []:
        road = addr.get("roadName", "")
        number = addr.get("houseNumber", "")
        letter = addr.get("houseLetter") or ""
        print(
            f"{road} {number}{letter}\t"
            f"{addr.get('zipCode', '')} {addr.get('cityName', '')}\t"
            f"{addr.get('addressType', '?')}"
        )


def cmd_buy_realtor(args: argparse.Namespace) -> None:
    """List real estate agencies in a given location.

    The API searches realtors by location, not by name: it needs a
    ``locationType`` (``municipality`` or ``city``) plus a ``locationName``
    (place slug, e.g. ``københavn`` or ``frederiksberg``).
    """
    params: list[tuple[str, str]] = [
        ("locationType", args.location_type),
        ("locationName", args.location.strip().lower()),
    ]
    resp = _buy_get("/search/realtors", params)
    if args.raw:
        _emit(resp, raw=True)
        return

    for r in resp.get("realtors") or []:
        rating = r.get("rating", {})
        seller_score = rating.get("seller", {}).get("score", "?")
        buyer_score = rating.get("buyer", {}).get("score", "?")
        city = r.get("contactInformation", {}).get("cityName", "")
        print(
            f"{r.get('name', '')}\t{r.get('url', '')}\t{city}\t"
            f"seller:{seller_score}\tbuyer:{buyer_score}"
        )


def cmd_buy_municipalities(args: argparse.Namespace) -> None:
    """List all Danish municipalities with population and place slug."""
    resp = _buy_get("/municipalities")
    if args.raw:
        _emit(resp, raw=True)
        return

    for m in resp.get("municipalities") or []:
        print(
            f"{m.get('municipalityCode', '')}\t{m.get('slug', '')}\t"
            f"{m.get('name', '')}\t{m.get('population', '?')} indbyggere"
        )


def cmd_buy_raw(args: argparse.Namespace) -> None:
    """GET a raw boligsiden API path with an optional query string."""
    path = args.endpoint if args.endpoint.startswith("/") else f"/{args.endpoint}"
    if args.query:
        params = [
            (k, v)
            for k, _, v in (
                pair.partition("=") for pair in args.query.split("&") if pair
            )
        ]
    else:
        params = None
    _emit(_buy_get(path, params), raw=True)


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


def _add_keyword_opts(p: argparse.ArgumentParser, default_scan: int) -> None:
    """Add body-keyword search options to a search parser.

    Args:
        p: Parser to extend.
        default_scan: Default ``--max-scan`` cap (listings inspected).
    """
    p.add_argument(
        "-k",
        "--keyword",
        action="append",
        metavar="TERM",
        help="keyword to match in the listing description body "
        "(repeatable; e.g. -k badekar -k altan)",
    )
    p.add_argument(
        "--match",
        choices=["all", "any"],
        default="all",
        help="require all keywords (default) or any of them",
    )
    p.add_argument(
        "--max-scan",
        dest="max_scan",
        type=int,
        default=default_scan,
        help=f"max listings to inspect when keyword-searching "
        f"(default {default_scan})",
    )


def _build_rent_parser(sub: t.Any) -> None:
    """Register the ``rent`` (boligportal.dk) command group."""
    rent = sub.add_parser(
        "rent", help="boligportal.dk — rental housing marketplace"
    )
    rsub = rent.add_subparsers(dest="cmd", required=True)

    p = rsub.add_parser(
        "search",
        help="search rentals (anonymous); -k matches the description body",
    )
    _add_rent_filters(p)
    _add_keyword_opts(p, default_scan=100)
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
    p.add_argument(
        "--min-monthly-fee",
        dest="min_monthly_fee",
        help="minimum monthly owner expense (ejerudgift) in DKK",
    )
    p.add_argument(
        "--max-monthly-fee",
        dest="max_monthly_fee",
        help="maximum monthly owner expense (ejerudgift) in DKK",
    )
    p.add_argument("--min-area", dest="min_area", help="minimum area in m²")
    p.add_argument("--max-area", dest="max_area", help="maximum area in m²")
    p.add_argument("--min-rooms", dest="min_rooms", help="minimum rooms")
    p.add_argument("--max-rooms", dest="max_rooms", help="maximum rooms")
    p.add_argument(
        "--min-floor",
        dest="min_floor",
        help="minimum floor (ground floor / stueetage = 0)",
    )
    p.add_argument(
        "--max-floor",
        dest="max_floor",
        help="maximum floor; for ground floor only use --min-floor 0 "
        "--max-floor 0",
    )
    p.add_argument(
        "--municipality",
        action="append",
        help="municipality place slug, e.g. københavn (repeatable); use this "
        "for whole big cities",
    )
    p.add_argument(
        "--zip-code",
        dest="zip_code",
        action="append",
        help="postal code (repeatable)",
    )
    p.add_argument(
        "--city",
        action="append",
        help="city/district place slug, e.g. frederiksberg, 'aarhus c' "
        "(repeatable)",
    )
    p.add_argument(
        "--type",
        action="append",
        help="property type, Danish or English (repeatable): lejlighed, villa, "
        "rækkehus, andelsbolig, sommerhus, …",
    )
    _add_buy_common(p)
    _add_keyword_opts(p, default_scan=200)
    p.add_argument(
        "--deep",
        action="store_true",
        help="for -k: also fetch each candidate's full description from the "
        "agency page (the API body is capped at ~500 chars). Slower — one "
        "request per non-matching candidate, bounded by --max-scan.",
    )
    p.add_argument(
        "--deep-workers",
        dest="deep_workers",
        type=int,
        default=8,
        help="concurrent agency-page fetches in --deep mode (default 8)",
    )
    p.add_argument(
        "--no-cache",
        dest="no_cache",
        action="store_true",
        help="don't read/write the on-disk cache of --deep full texts",
    )
    p.add_argument(
        "--cache-ttl-days",
        dest="cache_ttl_days",
        type=float,
        default=7.0,
        help="how long cached --deep full texts stay fresh (default 7 days)",
    )
    p.set_defaults(func=cmd_buy_cases)

    p = bsub.add_parser("address", help="look up an address")
    p.add_argument("q", nargs="?", help="search term (street, city, zip)")
    _add_buy_common(p)
    p.set_defaults(func=cmd_buy_address)

    p = bsub.add_parser(
        "realtor", help="list real estate agencies in a location"
    )
    p.add_argument(
        "location", help="place slug, e.g. københavn or frederiksberg"
    )
    p.add_argument(
        "--location-type",
        dest="location_type",
        choices=["municipality", "city"],
        default="municipality",
        help="how to interpret the location (default municipality)",
    )
    p.add_argument("--raw", action="store_true", help="print raw JSON response")
    p.set_defaults(func=cmd_buy_realtor)

    p = bsub.add_parser("municipalities", help="list all Danish municipalities")
    p.add_argument("--raw", action="store_true")
    p.set_defaults(func=cmd_buy_municipalities)

    p = bsub.add_parser("raw", help="GET a raw API path with a query string")
    p.add_argument(
        "endpoint", help="API path, e.g. 'search/cases' or 'municipalities'"
    )
    p.add_argument(
        "query",
        nargs="?",
        help="optional query string, e.g. 'page=1&cities=frederiksberg'",
    )
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
