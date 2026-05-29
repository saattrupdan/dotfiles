#!/usr/bin/env python3
"""Thin CLI for the verified anonymous endpoints on https://www.borger.dk/api/.

Standard library only. See ./SKILL.md for endpoint specs.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import typing as t
import urllib.error
import urllib.request

BASE = "https://www.borger.dk"
UA = "Mozilla/5.0 (borger-dk-api-cli)"

# Sitecore portal item ID for borger.dk. Published in the home-page HTML as
# data-portal-id; required by /api/search. If borger.dk re-keys it, refresh
# via the `portalid` subcommand below.
DEFAULT_PORTAL_ID = "ecfef56c-98e7-42f9-9e22-37d9268009ad"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="cmd", required=True)

    def _add(name: str, **kwargs: t.Any) -> argparse.ArgumentParser:
        p = sub.add_parser(name, **kwargs)
        p.add_argument(
            "--raw",
            action="store_true",
            help=("print raw JSON response (skip the human-readable formatter)"),
        )
        return p

    p = _add(
        "search",
        help="autocomplete suggestions for a search term",
    )
    p.add_argument("term")
    p.add_argument(
        "--portal-id",
        help="override the borger.dk Sitecore portal ID",
    )
    p.set_defaults(func=cmd_search)

    p = _add(
        "popular",
        help="popular search terms (empty-snippet response)",
    )
    p.add_argument(
        "--portal-id",
        help="override the borger.dk Sitecore portal ID",
    )
    p.set_defaults(func=cmd_popular)

    _add(
        "portalid",
        help="extract the current data-portal-id from the home page",
    ).set_defaults(func=cmd_portalid)
    _add(
        "endpoints",
        help="list /api/* paths referenced from the home page",
    ).set_defaults(func=cmd_endpoints)

    p = _add(
        "sitemap",
        help="list URLs from /sitemap.xml",
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
    body: dict | None = None,
    headers: dict[str, str] | None = None,
) -> tuple[int, bytes]:
    url = path if path.startswith("http") else BASE + path
    data: bytes | None = None
    h: dict[str, str] = {
        "User-Agent": UA,
        "Accept": "application/json",
    }
    if headers:
        h.update(headers)
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        h["Content-Type"] = "application/json"
    elif method == "POST":
        data = b""
        h["Content-Length"] = "0"
    req = urllib.request.Request(url, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        body_text = e.read() if e.fp else b""
        sys.stderr.write(f"HTTP {e.code} {e.reason} on {method} {path}\n")
        if body_text:
            sys.stderr.write(
                body_text.decode("utf-8", errors="replace").rstrip() + "\n"
            )
        sys.exit(2)


def _request_json(
    path: str,
    method: str = "GET",
    body: dict | None = None,
) -> t.Any:
    _, raw = _request(path, method=method, body=body)
    text = raw.decode("utf-8", errors="replace")
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return text


def _emit_json(obj: t.Any) -> None:
    print(json.dumps(obj, ensure_ascii=False, indent=2))


def _fetch_home_html() -> str:
    _, raw = _request(
        "/",
        headers={"Accept": "text/html"},
    )
    return raw.decode("utf-8", errors="replace")


def cmd_search(args: argparse.Namespace) -> None:
    portal_id = args.portal_id or DEFAULT_PORTAL_ID
    data = _request_json(
        "/api/search",
        method="POST",
        body={
            "portalId": portal_id,
            "snippet": args.term,
        },
    )
    if args.raw:
        _emit_json(data)
        return
    if not isinstance(data, list):
        _emit_json(data)
        sys.exit(2)
    for item in data:
        # item.Text is the bare suggestion; DisplayText
        # has <strong> markup.
        print(item.get("Text", ""))


def cmd_popular(args: argparse.Namespace) -> None:
    portal_id = args.portal_id or DEFAULT_PORTAL_ID
    data = _request_json(
        "/api/search",
        method="POST",
        body={
            "portalId": portal_id,
            "snippet": "",
        },
    )
    if args.raw:
        _emit_json(data)
        return
    if not isinstance(data, list):
        _emit_json(data)
        sys.exit(2)
    for item in data:
        print(item.get("Text", ""))


def cmd_portalid(args: argparse.Namespace) -> None:
    html = _fetch_home_html()
    m = re.search(r'data-portal-id="([0-9a-fA-F-]{36})"', html)
    if not m:
        sys.stderr.write("data-portal-id not found in home-page HTML\n")
        sys.exit(2)
    print(m.group(1))


def cmd_endpoints(args: argparse.Namespace) -> None:
    html = _fetch_home_html()
    paths = sorted(set(re.findall(r"/api/[A-Za-z0-9/_.{}-]+", html)))
    for p in paths:
        print(p)


def cmd_sitemap(args: argparse.Namespace) -> None:
    # IIS rejects "Accept: application/xml" with 406 on
    # sitemap.xml; use a broad Accept.
    _, raw = _request(
        "/sitemap.xml",
        headers={"Accept": "*/*"},
    )
    xml = raw.decode("utf-8", errors="replace")
    locs = re.findall(r"<loc>([^<]+)</loc>", xml)
    if args.limit:
        locs = locs[: args.limit]
    if not locs:
        sys.stderr.write("No <loc> entries found in /sitemap.xml\n")
        sys.exit(2)
    for url in locs:
        print(url)


if __name__ == "__main__":
    main()
