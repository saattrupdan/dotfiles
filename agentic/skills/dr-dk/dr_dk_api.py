#!/usr/bin/env python3
"""Thin CLI for the verified anonymous endpoints on https://www.dr.dk/.

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
from xml.etree import ElementTree as ET

BASE = "https://www.dr.dk"
UA = "Mozilla/5.0 (compatible; dr-dk-api-cli)"
SITEMAP_NS = {"sm": "http://www.sitemaps.org/schemas/sitemap/0.9"}


def main() -> None:
    parser = argparse.ArgumentParser(description="Anonymous dr.dk endpoints (CLI).")
    sub = parser.add_subparsers(dest="cmd", required=True)

    fp = sub.add_parser(
        "frontpage",
        help="Extract latest news from /nyheder via __NEXT_DATA__",
    )
    fp.add_argument(
        "--limit",
        type=int,
        default=5,
        help="Max articles to show (default 5)",
    )
    fp.add_argument(
        "--urn",
        action="store_true",
        dest="show_urn",
        help="Show article URNs",
    )
    fp.add_argument(
        "--raw",
        action="store_true",
        help="Print raw JSON",
    )
    fp.set_defaults(func=cmd_frontpage)

    ar = sub.add_parser(
        "article",
        help="Extract article data from __NEXT_DATA__ of any page",
    )
    ar.add_argument(
        "path",
        help="Article path, e.g. nyheder/indland/example-article",
    )
    ar.add_argument(
        "--raw",
        action="store_true",
        help="Print raw JSON",
    )
    ar.set_defaults(func=cmd_article)

    img = sub.add_parser(
        "image",
        help="Download thumbnail image for a clip publication",
    )
    img.add_argument(
        "urn",
        help="Clip URN, e.g. urn:dr:od3:clippublication:69fb396d045c210b584ecffc",
    )
    img.add_argument(
        "image_id",
        help="Image UUID, e.g. ab9644f8-f95b-41e6-83c4-db4b009bdb24",
    )
    img.set_defaults(func=cmd_image)

    sm = sub.add_parser(
        "sitemap",
        help="List sitemap files from sitemapindex.xml",
    )
    sm.add_argument(
        "--raw",
        action="store_true",
        help="Print as JSON list",
    )
    sm.set_defaults(func=cmd_sitemap)

    tg = sub.add_parser(
        "tvguide",
        help="List URLs from the TV guide sitemap",
    )
    tg.add_argument(
        "--limit",
        type=int,
        help="Limit output to N URLs",
    )
    tg.add_argument(
        "--raw",
        action="store_true",
        help="Print as JSON list",
    )
    tg.set_defaults(func=cmd_tvguide_sitemap)

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
        "Accept": "text/html",
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


def _parse_next_data(html: str, page: str = "") -> dict:
    """Extract and parse __NEXT_DATA__ JSON from page HTML."""
    m = re.search(
        r'<script id="__NEXT_DATA__"' r"[^>]*>(.*?)</script>",
        html,
        re.DOTALL,
    )
    if not m:
        label = f" on {page}" if page else ""
        sys.stderr.write(f"__NEXT_DATA__ not found{label}\n")
        sys.exit(2)
    return json.loads(m.group(1))


def cmd_frontpage(args: argparse.Namespace) -> None:
    """GET /nyheder - latest news from site.publications[] in __NEXT_DATA__."""
    _, raw = _request(
        "/nyheder",
        headers={"Accept": "text/html"},
    )
    html = raw.decode("utf-8", errors="replace")
    data = _parse_next_data(html, "/nyheder")
    page_props = data.get("props", {}).get("pageProps", {})
    view_props = page_props.get("viewProps", {})
    if args.raw:
        _emit_json(view_props)
        return
    publications = view_props.get("site", {}).get("publications", [])
    print(f"Found {len(publications)} articles on /nyheder")
    for pub in publications[: args.limit]:
        art = pub.get("content", {})
        title = art.get("title", "(no title)")
        url = art.get("urlPathId", "?")
        fmt = art.get("format", "")
        date = art.get("startDate", "")[:10] if art.get("startDate") else ""
        print(f"\n  [{date}] {title}")
        print(f"  {url}")
        if fmt:
            print(f"  format: {fmt}")
        if args.show_urn:
            urn = art.get("urn", "")
            if urn:
                print(f"  URN: {urn}")


def cmd_article(args: argparse.Namespace) -> None:
    """GET /<path> - article JSON from __NEXT_DATA__."""
    path = "/" + urllib.parse.quote(args.path.lstrip("/"), safe="/-")
    _, raw = _request(
        path,
        headers={"Accept": "text/html"},
    )
    html = raw.decode("utf-8", errors="replace")
    data = _parse_next_data(html, path)
    page_props = data.get("props", {}).get("pageProps", {})
    view_props = page_props.get("viewProps", {})
    if args.raw:
        _emit_json(view_props)
        return
    article = view_props.get("article", {})
    print(f"title:    {article.get('title', '?')}")
    print(f"urn:      {article.get('urn', '?')}")
    print(f"url:      {article.get('urlPathId', '?')}")
    print(f"type:     {article.get('format', '?')}")
    start = article.get("startDate", "")
    if start:
        print(f"published: {start[:19]}")
    site = article.get("site", {})
    if site:
        print(f"section:  {site.get('title', '')} ({site.get('url', '')})")
    # contributions moved from viewProps to article in 2026 restructure
    contributions = article.get("contributions", []) or view_props.get(
        "contributions", []
    )
    if contributions:
        print("authors:")
        for c in contributions:
            agent = c.get("agent", {})
            print(f"  - {agent.get('name', '?')} ({agent.get('email', '')})")
    head = article.get("head", [])
    for comp in head:
        if comp.get("type") == "MediaComponent":
            res = comp.get("resource", {})
            print(f"media:    {res.get('title', '?')} ({res.get('mediaType', '')})")
            dur = res.get("durationInMilliseconds", 0)
            if dur:
                sec = dur / 1000
                print(f"          duration: {sec:.0f}s")


def cmd_image(args: argparse.Namespace) -> None:
    """GET image from api.dr.dk/odacache for a clip URN."""
    urn = urllib.parse.quote(args.urn, safe=":/")
    url = (
        f"https://api.dr.dk/odacache/"
        f"api/Publication/Image/{urn}"
        f"?imageId={args.image_id}"
    )
    _, raw = _request(
        url,
        headers={"Accept": "image/*"},
    )
    sys.stdout.buffer.write(raw)


def cmd_sitemap(args: argparse.Namespace) -> None:
    """List URLs from DR's sitemap index."""
    _, raw = _request(
        "/sitemapindex.xml",
        headers={"Accept": "application/xml"},
    )
    xml = raw.decode("utf-8", errors="replace")
    root = ET.fromstring(xml)
    sitemaps = [
        loc.text
        for loc in root.findall(
            "sm:sitemap/sm:loc",
            SITEMAP_NS,
        )
        if loc.text
    ]
    if args.raw:
        _emit_json(sitemaps)
        return
    print(f"Found {len(sitemaps)} sitemap files")
    for s in sitemaps:
        print(s)


def cmd_tvguide_sitemap(
    args: argparse.Namespace,
) -> None:
    """List URLs from the TV guide sitemap."""
    _, raw = _request(
        "/sitemap.tvguide.xml",
        headers={"Accept": "application/xml"},
    )
    xml = raw.decode("utf-8", errors="replace")
    root = ET.fromstring(xml)
    urls = [
        loc.text
        for loc in root.findall(
            "sm:url/sm:loc",
            SITEMAP_NS,
        )
        if loc.text
    ]
    if args.raw:
        _emit_json(urls)
        return
    if not urls:
        sys.stderr.write("No URLs found\n")
        sys.exit(2)
    print(f"Found {len(urls)} TV guide URLs")
    for u in urls[: args.limit or len(urls)]:
        print(u)


if __name__ == "__main__":
    main()
