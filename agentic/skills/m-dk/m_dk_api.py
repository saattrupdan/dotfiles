#!/usr/bin/env python3
"""CLI helper for the internal Ankiro search API used by m.dk (Metroen).

Standard library only. See ./SKILL.md for full API specification.
"""
from __future__ import annotations

import argparse
import json
import sys
import typing as t
import urllib.error
import urllib.request

BASE = "https://m.ankiro.dk/Rest/Metro-Live/Search"
UA = "Mozilla/5.0 (m-dk-api-cli)"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser(
        "search",
        help="Search m.dk content via the Ankiro API",
    )
    p.add_argument(
        "query",
        help="Search query string",
    )
    p.add_argument(
        "--culture",
        default="da",
        help="Language code (default: da)",
    )
    p.add_argument(
        "--start",
        type=int,
        default=0,
        help="Pagination offset",
    )
    p.add_argument(
        "--max",
        type=int,
        default=10,
        help="Max results per page",
    )
    p.add_argument(
        "--raw",
        action="store_true",
        help="Print raw JSON response",
    )
    p.set_defaults(func=cmd_search)

    p = sub.add_parser(
        "facets",
        help="Show available facet definitions and "
        "counts",
    )
    p.add_argument(
        "query",
        help="Search query to scope facets",
    )
    p.add_argument(
        "--max",
        type=int,
        default=10,
        help="Max results for facet context",
    )
    p.set_defaults(func=cmd_facets)

    args = parser.parse_args()
    args.func(args)


def _get(params: dict[str, str]) -> tuple[int, bytes]:
    qs = "&".join(
        f"{k}={v}" for k, v in params.items())
    url = f"{BASE}?{qs}"
    req = urllib.request.Request(
        url,
        headers={"User-Agent": UA},
    )
    try:
        with urllib.request.urlopen(
            req, timeout=30,
        ) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        body = e.read() if e.fp else b""
        sys.stderr.write(
            f"HTTP {e.code} {e.reason} on {url}\n")
        if body:
            sys.stderr.write(
                body.decode("utf-8", errors="replace")
                .rstrip() + "\n")
        sys.exit(2)


def _emit_json(obj: t.Any) -> None:
    print(
        json.dumps(obj, ensure_ascii=False, indent=2))


def cmd_search(args: argparse.Namespace) -> None:
    params: dict[str, str] = {
        "q": args.query,
    }
    if args.culture:
        params["culture"] = args.culture
    if args.start:
        params["startIndex"] = str(args.start)
    if args.max:
        params["maxResults"] = str(args.max)
    status, raw = _get(params)
    data = json.loads(raw.decode("utf-8"))
    if args.raw:
        _emit_json(data)
        return
    total = data.get("TotalResults", 0)
    docs = data.get("Documents", [])
    if not docs:
        print(
            f"No results for '{args.query}' "
            f"(total: {total})")
        return
    print(f"Total results: {total}")
    for i, doc in enumerate(docs, 1):
        title = ""
        uri = ""
        page_type = ""
        metro_line = ""
        culture = ""
        for prop in doc.get("Properties", []):
            if prop["Name"] == "Title":
                title = prop["Value"]
            elif prop["Name"] == "Uri":
                uri = prop["Value"]
            elif prop["Name"] == "pageType":
                page_type = prop["Value"]
            elif prop["Name"] == "metroLine":
                metro_line = prop["Value"]
            elif prop["Name"] == "Culture":
                culture = prop["Value"]
        meta: list[str] = []
        if metro_line:
            meta.append(f"line:{metro_line}")
        if page_type:
            meta.append(page_type)
        if culture:
            meta.append(culture)
        meta_str = (
            f" [{', '.join(meta)}]"
            if meta else "")
        print(f"  {i}. {title}{meta_str}")
        print(f"     {uri}")


def cmd_facets(args: argparse.Namespace) -> None:
    params: dict[str, str] = {
        "q": args.query,
        "culture": "da",
    }
    if args.max:
        params["maxResults"] = str(args.max)
    status, raw = _get(params)
    data = json.loads(raw.decode("utf-8"))
    defs = [
        {
            "id": p["Id"],
            "name": p["Name"],
            "type": p.get("Type"),
        }
        for p in data.get(
            "Decorations", {})
        .get("Properties", [])
    ]
    _emit_json({
        "total": data.get("TotalResults", 0),
        "facets": data.get("Facets", []),
        "property_definitions": defs,
    })


if __name__ == "__main__":
    main()
