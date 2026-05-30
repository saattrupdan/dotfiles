#!/usr/bin/env python3
"""CLI for Danish public transport.

One command over several public/internal APIs, grouped as subcommands:

- ``transport route FROM TO``      -- journey planning  (Rejseplanen HAFAS)
- ``transport departures STATION`` -- live station board (Rejseplanen HAFAS)
- ``transport stations QUERY``     -- station/address lookup (Rejseplanen HAFAS)
- ``transport changes``            -- disruptions & schedule changes
                                      (HAFAS HIM + dinoffentligetransport.dk)
- ``transport tickets``            -- ticket-product reference (curated)
- ``transport search QUERY``       -- transport content Q&A (m.dk Ankiro index)

Buying tickets is intentionally **not** supported — that needs MitID and the
operators' own apps. Standard library only. See ./SKILL.md for the API specs.
"""

from __future__ import annotations

import argparse
import json
import sys
import typing as t
import urllib.error
import urllib.parse
import urllib.request

# --- Rejseplanen HAFAS (HaCon) — the journey-planning engine ---------------
HAFAS_ENDPOINT = "https://webapp.rejseplanen.dk/bin/iphone.exe"
HAFAS_AID = "j1sa92pcj72ksh0-web"
HAFAS_VER = "1.24"
HAFAS_EXT = "DK.11"

# --- dinoffentligetransport.dk — bus/regional disruptions & schedules ------
DIN_BASE = "https://dinoffentligetransport.dk"

# --- m.dk (Metro) Ankiro index — the only real transport content search ----
ANKIRO_URL = "https://m.ankiro.dk/Rest/Metro-Live/Search"

UA = "Mozilla/5.0 (transport-dk-cli)"

# Product-class bitmask (HAFAS `cls`). Combine bits to filter a journey search.
PRODUCTS: dict[str, int] = {
    "ic": 1,
    "lyn": 2,
    "re": 4,
    "train": 8,
    "stog": 16,
    "bus": 32,
    "expressbus": 64,
    "nightbus": 128,
    "otherbus": 256,
    "ferry": 512,
    "metro": 1024,
    "tram": 2048,
}
ALL_PRODUCTS = 4095  # every bit set

# Curated ticket-product reference, distilled from dsb.dk / m.dk /
# dinoffentligetransport.dk. Buying happens in the operators' apps; this is a
# pointer index only.
TICKETS: list[dict[str, str]] = [
    {
        "name": "Rejsekort",
        "operator": "all",
        "desc": "Tap-in/out travel card valid on all trains, buses, metro and "
        "ferries nationwide; cheapest pay-as-you-go fare.",
        "url": "https://www.rejsekort.dk/",
    },
    {
        "name": "Enkeltbillet (single ticket)",
        "operator": "all",
        "desc": "Zone-based single journey, valid across operators within the "
        "purchased zones for a time window.",
        "url": "https://dinoffentligetransport.dk/find-billetter",
    },
    {
        "name": "Pendlerkort (commuter card)",
        "operator": "all",
        "desc": "Period ticket (30 days+) between chosen zones; unlimited "
        "travel in those zones.",
        "url": "https://www.dsb.dk/find-produkter-og-services/dsb-pendlerkort/",
    },
    {
        "name": "Ungdomskort (youth card)",
        "operator": "all",
        "desc": "Discounted period ticket for 16-25 year-olds and students.",
        "url": "https://www.dsb.dk/find-produkter-og-services/ung/ungdomskort/",
    },
    {
        "name": "Pensionistkort (senior 67+)",
        "operator": "all",
        "desc": "Discounted commuter period ticket for travellers aged 67+.",
        "url": "https://dinoffentligetransport.dk/find-billetter",
    },
    {
        "name": "DSB Orange / Orange Fri",
        "operator": "dsb",
        "desc": "Cheap time-bound train tickets booked ahead; Orange Fri gives "
        "30 days of unlimited Orange-style travel.",
        "url": "https://www.dsb.dk/find-produkter-og-services/orange/",
    },
    {
        "name": "DSB Pendler20",
        "operator": "dsb",
        "desc": "Subsidised commuter ticket for 20 trips within a period.",
        "url": "https://www.dsb.dk/find-produkter-og-services/Pendler20/",
    },
    {
        "name": "Cykel-pladsbillet (bicycle ticket)",
        "operator": "dsb",
        "desc": "Reservation to bring a bicycle on trains.",
        "url": "https://www.dsb.dk/find-produkter-og-services/cykel-pladsbillet/",
    },
    {
        "name": "Gruppebillet (group ticket)",
        "operator": "dsb",
        "desc": "Discounted single ticket for groups of up to 9 travellers.",
        "url": "https://www.dsb.dk/find-produkter-og-services/dsb-gruppebillet/",
    },
    {
        "name": "Metro tickets via Rejsekort/DOT app",
        "operator": "metro",
        "desc": "Copenhagen Metro uses the shared zone system; buy via "
        "Rejsekort, the DOT Mobilbilletter app or station machines.",
        "url": "https://m.dk/rejs-med-metroen/",
    },
]


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------


def _emit(obj: t.Any) -> None:
    """Pretty-print a JSON value (UTF-8 preserved)."""
    print(json.dumps(obj, ensure_ascii=False, indent=2))


def _get(url: str, accept: str = "*/*", timeout: float = 30.0) -> bytes:
    """GET a URL with a browser-ish UA, exiting non-zero on HTTP error."""
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": accept})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.read()
    except urllib.error.HTTPError as e:
        body = e.read() if e.fp else b""
        sys.stderr.write(f"HTTP {e.code} {e.reason} on GET {url}\n")
        if body:
            sys.stderr.write(body.decode("utf-8", errors="replace").rstrip() + "\n")
        sys.exit(2)
    except urllib.error.URLError as e:
        sys.stderr.write(f"Network error on GET {url}: {e.reason}\n")
        sys.exit(2)


def _get_json(url: str) -> t.Any:
    """GET a URL and parse JSON, exiting non-zero on a non-JSON body."""
    raw = _get(url, accept="application/json")
    try:
        return json.loads(raw.decode("utf-8", errors="replace"))
    except json.JSONDecodeError:
        sys.stderr.write(f"Non-JSON response from {url}\n")
        sys.exit(2)


def _fmt_time(value: str | None) -> str:
    """Format a HAFAS time string ``HHMMSS`` (or ``DHHMMSS``) as ``HH:MM``.

    HAFAS prefixes a day offset when a time rolls past midnight, e.g.
    ``1000300`` = next day 00:03. The offset is surfaced as ``+1d``.
    """
    if not value:
        return "--:--"
    day = 0
    if len(value) > 6:
        day = int(value[:-6])
        value = value[-6:]
    value = value.zfill(6)
    out = f"{value[0:2]}:{value[2:4]}"
    return f"{out} (+{day}d)" if day else out


def _fmt_dur(value: str | None) -> str:
    """Format a HAFAS duration ``HHMMSS`` as ``Hh MMm``."""
    if not value:
        return "?"
    value = value.zfill(6)
    h, m = int(value[:-4]), int(value[-4:-2])
    return f"{h}h {m:02d}m" if h else f"{m}m"


# ---------------------------------------------------------------------------
# Rejseplanen HAFAS RPC
# ---------------------------------------------------------------------------


def _hafas(method: str, req: dict) -> dict:
    """Call one HAFAS service method and return its ``res`` object.

    Exits non-zero (with the HAFAS ``errTxt``) on a service-level error.
    """
    envelope = {
        "ver": HAFAS_VER,
        "ext": HAFAS_EXT,
        "auth": {"type": "AID", "aid": HAFAS_AID},
        "lang": "dan",
        "client": {"id": "DK", "type": "WEB", "name": "rejseplanwebapp"},
        "formatted": False,
        "svcReqL": [{"meth": method, "req": req}],
    }
    body = json.dumps(envelope).encode("utf-8")
    request = urllib.request.Request(
        HAFAS_ENDPOINT,
        data=body,
        method="POST",
        headers={"User-Agent": UA, "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as r:
            payload = json.loads(r.read().decode("utf-8", errors="replace"))
    except urllib.error.HTTPError as e:  # pragma: no cover - network path
        sys.stderr.write(f"HTTP {e.code} {e.reason} calling HAFAS {method}\n")
        sys.exit(2)
    except urllib.error.URLError as e:  # pragma: no cover - network path
        sys.stderr.write(f"Network error calling HAFAS {method}: {e.reason}\n")
        sys.exit(2)

    if payload.get("err") and payload["err"] != "OK":
        sys.stderr.write(
            f"HAFAS error: {payload.get('err')} {payload.get('errTxt', '')}\n"
        )
        sys.exit(2)
    svc = payload.get("svcResL", [{}])[0]
    if svc.get("err") and svc["err"] != "OK":
        sys.stderr.write(
            f"HAFAS {method} error: {svc.get('err')} {svc.get('errTxt', '')}\n"
        )
        sys.exit(2)
    return svc.get("res", {})


def _locmatch(name: str, max_loc: int = 7) -> list[dict]:
    """Resolve a free-text place name to HAFAS locations (best match first)."""
    res = _hafas(
        "LocMatch",
        {
            "input": {
                "field": "S",
                "loc": {"name": name, "type": "ALL"},
                "maxLoc": max_loc,
            }
        },
    )
    return res.get("match", {}).get("locL", [])


def _resolve_one(name: str, role: str) -> dict:
    """Resolve a place name to a single location or exit with guidance."""
    locs = _locmatch(name, max_loc=1)
    if not locs:
        sys.stderr.write(
            f"No match for {role} {name!r}. Try `transport stations {name!r}`.\n"
        )
        sys.exit(2)
    return locs[0]


def _product_mask(only: list[str] | None) -> int:
    """Translate ``--only`` product names into a HAFAS product bitmask."""
    if not only:
        return ALL_PRODUCTS
    mask = 0
    for name in only:
        key = name.lower()
        if key not in PRODUCTS:
            sys.stderr.write(
                f"Unknown product {name!r}. Choose from: {', '.join(PRODUCTS)}\n"
            )
            sys.exit(2)
        mask |= PRODUCTS[key]
    return mask


def cmd_stations(args: argparse.Namespace) -> None:
    """Look up stations / addresses / POIs by name."""
    locs = _locmatch(args.query, max_loc=args.limit)
    if args.json:
        _emit(locs)
        return
    if not locs:
        print(f"# no matches for {args.query!r}")
        return
    type_label = {"S": "station", "ADR": "address", "POI": "poi", "A": "address"}
    for loc in locs:
        kind = type_label.get(loc.get("type", ""), loc.get("type", "?"))
        print(f"{loc.get('name', '')}\t[{kind}]\textId={loc.get('extId', '')}")


def cmd_route(args: argparse.Namespace) -> None:
    """Plan a journey between two places via Rejseplanen."""
    origin = _resolve_one(args.origin, "origin")
    dest = _resolve_one(args.destination, "destination")

    req: dict[str, t.Any] = {
        "depLocL": [{"lid": origin["lid"]}],
        "arrLocL": [{"lid": dest["lid"]}],
        "jnyFltrL": [
            {"type": "PROD", "mode": "INC", "value": _product_mask(args.only)}
        ],
        "outFrwd": not args.arrive,
        "numF": args.limit,
        "getTariff": False,
    }
    if args.date:
        req["outDate"] = args.date.replace("-", "")
    if args.time:
        req["outTime"] = args.time.replace(":", "").ljust(6, "0")[:6]

    res = _hafas("TripSearch", req)
    common = res.get("common", {})
    loc_list = common.get("locL", [])
    prod_list = common.get("prodL", [])
    conns = res.get("outConL", [])

    if args.json:
        _emit(res)
        return

    print(f"# {origin['name']} -> {dest['name']}  ({len(conns)} connections)")
    for c in conns:
        dep, arr = c.get("dep", {}), c.get("arr", {})
        print(
            f"\n{_fmt_time(dep.get('dTimeS'))} -> {_fmt_time(arr.get('aTimeS'))}"
            f"   {_fmt_dur(c.get('dur'))}   {c.get('chg', 0)} change(s)"
        )
        for sec in c.get("secL", []):
            _print_leg(sec, loc_list, prod_list)


def _loc_name(loc_list: list[dict], idx: t.Any) -> str:
    """Resolve a ``locX`` index into a station name."""
    if isinstance(idx, int) and 0 <= idx < len(loc_list):
        return loc_list[idx].get("name", "?")
    return "?"


def _print_leg(sec: dict, loc_list: list[dict], prod_list: list[dict]) -> None:
    """Print one journey section (a ride, walk or transfer)."""
    dep, arr = sec.get("dep", {}), sec.get("arr", {})
    dep_name = _loc_name(loc_list, dep.get("locX"))
    arr_name = _loc_name(loc_list, arr.get("locX"))
    kind = sec.get("type", "")
    if kind == "JNY":
        jny = sec.get("jny", {})
        prod_idx = jny.get("prodX")
        line = "?"
        if isinstance(prod_idx, int) and 0 <= prod_idx < len(prod_list):
            line = prod_list[prod_idx].get("name", "?")
        direction = jny.get("dirTxt", "")
        plat = dep.get("dPlatfS", "")
        plat_str = f" (plat {plat})" if plat else ""
        print(
            f"  {_fmt_time(dep.get('dTimeS'))} {dep_name}{plat_str} "
            f"-> {line} mod {direction}"
        )
        print(f"           {_fmt_time(arr.get('aTimeS'))} {arr_name}")
    elif kind in ("WALK", "TRSF", "GIS_WALK", "TRANSFER"):
        dur = _fmt_dur(sec.get("gis", {}).get("durS") or sec.get("dur"))
        print(f"  walk/transfer {dep_name} -> {arr_name} ({dur})")
    else:
        print(f"  {kind}: {dep_name} -> {arr_name}")


def cmd_departures(args: argparse.Namespace) -> None:
    """Show the live departure (or arrival) board for a station."""
    station = _resolve_one(args.station, "station")
    req: dict[str, t.Any] = {
        "type": "ARR" if args.arrivals else "DEP",
        "stbLoc": {"lid": station["lid"]},
        "maxJny": args.limit,
    }
    if args.date:
        req["date"] = args.date.replace("-", "")
    if args.time:
        req["time"] = args.time.replace(":", "").ljust(6, "0")[:6]

    res = _hafas("StationBoard", req)
    prod_list = res.get("common", {}).get("prodL", [])
    journeys = res.get("jnyL", [])

    if args.json:
        _emit(res)
        return

    verb = "Arrivals at" if args.arrivals else "Departures from"
    print(f"# {verb} {station['name']}  ({len(journeys)})")
    for j in journeys:
        stop = j.get("stbStop", {})
        time_s = stop.get("aTimeS" if args.arrivals else "dTimeS")
        time_r = stop.get("aTimeR" if args.arrivals else "dTimeR")
        prod_idx = j.get("prodX")
        line = "?"
        if isinstance(prod_idx, int) and 0 <= prod_idx < len(prod_list):
            line = prod_list[prod_idx].get("name", "?")
        plat = stop.get("dPlatfS") or stop.get("aPlatfS") or ""
        delay = ""
        if time_r and time_r != time_s:
            delay = f"  (real {_fmt_time(time_r)})"
        plat_str = f"  plat {plat}" if plat else ""
        print(
            f"{_fmt_time(time_s)}\t{line}\tmod {j.get('dirTxt', '')}{plat_str}{delay}"
        )


# ---------------------------------------------------------------------------
# Disruptions / schedule changes
# ---------------------------------------------------------------------------


def _him_messages(max_num: int) -> list[dict]:
    """Fetch current HAFAS HIM disruption messages (all operators)."""
    res = _hafas(
        "HimSearch",
        {
            "himFltrL": [{"type": "HIMCAT", "mode": "INC", "value": "0"}],
            "maxNum": max_num,
        },
    )
    return res.get("msgL", [])


def cmd_changes(args: argparse.Namespace) -> None:
    """Show live disruptions and planned schedule changes.

    Combines Rejseplanen's HIM feed (nationwide, all operators) with
    dinoffentligetransport.dk's bus schedule-change list.
    """
    him = _him_messages(args.limit)
    out: dict[str, t.Any] = {"him": him}

    if not args.no_bus:
        out["transportationChanges"] = _get_json(
            f"{DIN_BASE}/api/transportationChanges"
        )
        out["scheduleChanges"] = _get_json(f"{DIN_BASE}/api/BusLines/schedulechanges")

    if args.json:
        _emit(out)
        return

    print(f"# Rejseplanen disruptions (HIM): {len(him)}")
    for m in him:
        head = m.get("head") or m.get("text") or ""
        print(f"  - {head.strip()}")

    if not args.no_bus:
        sched = out["scheduleChanges"]
        if isinstance(sched, list):
            print(f"\n# Bus schedule changes (dinoffentligetransport): {len(sched)}")
            for s in sched[: args.limit]:
                msg = s.get("message") or {}
                title = (msg.get("title") if isinstance(msg, dict) else "") or ""
                when = s.get("begin", "")[:10]
                when_str = f" [{when}]" if when else ""
                print(f"  - {title.strip()}{when_str}")


# ---------------------------------------------------------------------------
# Tickets (curated reference) and content search
# ---------------------------------------------------------------------------


def cmd_tickets(args: argparse.Namespace) -> None:
    """List ticket products with descriptions and official links.

    Buying is out of scope (needs MitID + operator apps); this is a reference.
    """
    items = TICKETS
    if args.operator:
        op = args.operator.lower()
        items = [t_ for t_ in TICKETS if t_["operator"] in (op, "all")]
    if args.json:
        _emit(items)
        return
    for it in items:
        print(f"{it['name']}  [{it['operator']}]")
        print(f"  {it['desc']}")
        print(f"  {it['url']}")
        print()


def cmd_search(args: argparse.Namespace) -> None:
    """Search transport content / Q&A via the m.dk (Metro) Ankiro index.

    This is the only public, structured transport content-search API; results
    are Metro-focused. For journeys use ``route``; for stops use ``departures``.
    """
    params = urllib.parse.urlencode(
        {"q": args.query, "culture": "da", "maxResults": args.limit}
    )
    data = _get_json(f"{ANKIRO_URL}?{params}")
    docs = data.get("Documents", [])
    if args.json:
        _emit(data)
        return
    total = data.get("TotalResults", 0)
    print(f"# {total} result(s) for {args.query!r} (m.dk metro index)")
    for doc in docs:
        props = {p["Name"]: p.get("Value") for p in doc.get("Properties", [])}
        title = props.get("Title", "")
        uri = props.get("Uri", "")
        ptype = props.get("pageType", "")
        tag = f" [{ptype}]" if ptype else ""
        print(f"  {title}{tag}")
        if uri:
            print(f"    {uri}")


# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------


def main() -> None:
    """Entry point: parse arguments and dispatch to the selected command."""
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("route", help="plan a journey A -> B (Rejseplanen)")
    p.add_argument("origin", help="origin place name, e.g. 'København H'")
    p.add_argument("destination", help="destination place name, e.g. 'Aarhus H'")
    p.add_argument("--date", help="departure date YYYY-MM-DD (default: today)")
    p.add_argument("--time", help="time HH:MM (default: now)")
    p.add_argument(
        "--arrive",
        action="store_true",
        help="treat --time as the desired arrival time",
    )
    p.add_argument(
        "--only",
        nargs="+",
        metavar="PRODUCT",
        help=f"restrict to product types ({', '.join(PRODUCTS)})",
    )
    p.add_argument("-n", "--limit", type=int, default=4, help="connections (default 4)")
    p.add_argument("--json", action="store_true", help="raw HAFAS JSON")
    p.set_defaults(func=cmd_route)

    p = sub.add_parser("departures", help="live station board (Rejseplanen)")
    p.add_argument("station", help="station name, e.g. 'Nørreport'")
    p.add_argument(
        "--arrivals", action="store_true", help="show arrivals not departures"
    )
    p.add_argument("--date", help="date YYYY-MM-DD (default: today)")
    p.add_argument("--time", help="time HH:MM (default: now)")
    p.add_argument("-n", "--limit", type=int, default=15, help="rows (default 15)")
    p.add_argument("--json", action="store_true", help="raw HAFAS JSON")
    p.set_defaults(func=cmd_departures)

    p = sub.add_parser("stations", help="look up stations/addresses by name")
    p.add_argument("query", help="search text")
    p.add_argument("-n", "--limit", type=int, default=7, help="results (default 7)")
    p.add_argument("--json", action="store_true", help="raw HAFAS JSON")
    p.set_defaults(func=cmd_stations)

    p = sub.add_parser("changes", help="disruptions & planned schedule changes")
    p.add_argument(
        "--no-bus",
        action="store_true",
        help="skip the dinoffentligetransport bus schedule-change feed",
    )
    p.add_argument(
        "-n", "--limit", type=int, default=20, help="rows per feed (default 20)"
    )
    p.add_argument("--json", action="store_true", help="raw JSON")
    p.set_defaults(func=cmd_changes)

    p = sub.add_parser("tickets", help="ticket-product reference (no buying)")
    p.add_argument(
        "--operator",
        choices=["dsb", "metro", "movia", "all"],
        help="filter to one operator's products",
    )
    p.add_argument("--json", action="store_true", help="raw JSON")
    p.set_defaults(func=cmd_tickets)

    p = sub.add_parser("search", help="transport content Q&A (m.dk metro index)")
    p.add_argument("query", help="search text")
    p.add_argument("-n", "--limit", type=int, default=10, help="results (default 10)")
    p.add_argument("--json", action="store_true", help="raw JSON")
    p.set_defaults(func=cmd_search)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
