#!/usr/bin/env python3
"""Thin CLI for the public read APIs behind https://nyidanmark.dk/.

Wraps the verified internal endpoints:
  - GET  /api/search/getsearchresults?query=<term>
    - site search
  - GET  /api/news/getTags
    - news category taxonomy
  - GET  /api/news/getNews?newsTypeTag=<tag>
    - news articles (optional tag filter)

Standard library only. See ./SKILL.md for the underlying spec.
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

BASE = "https://nyidanmark.dk"
UA = "Mozilla/5.0 (nyidanmark-dk-api-cli)"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser(
        "search",
        help="search the site",
    )
    p.add_argument("query")
    p.add_argument(
        "--page",
        type=int,
        default=1,
        help="page number (default 1)",
    )
    p.add_argument(
        "--raw",
        action="store_true",
        help="print raw JSON",
    )
    p.set_defaults(func=cmd_search)

    p = sub.add_parser(
        "news-tags",
        help="list news category tags",
    )
    p.add_argument(
        "--raw",
        action="store_true",
        help="print raw JSON",
    )
    p.set_defaults(func=cmd_news_tags)

    p = sub.add_parser(
        "news",
        help="list news articles, optionally filtered by tag",
    )
    p.add_argument(
        "tag",
        nargs="?",
        default=None,
        help="news category tag, e.g. 'Arbejde'",
    )
    p.add_argument(
        "--raw",
        action="store_true",
        help="print raw JSON",
    )
    p.set_defaults(func=cmd_news)

    p = sub.add_parser(
        "endpoints",
        help="list all /api/* paths referenced on the home page",
    )
    p.set_defaults(func=cmd_endpoints)

    args = parser.parse_args()
    args.func(args)


def _request(
    url: str,
    method: str = "GET",
    body: bytes | None = None,
    headers: dict[str, str] | None = None,
    timeout: float = 30.0,
) -> tuple[int, bytes]:
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
        sys.stderr.write(f"HTTP {e.code} {e.reason} on {method} {url}\n")
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


def cmd_search(args: argparse.Namespace) -> None:
    params = urllib.parse.urlencode(
        {
            "query": args.query,
            "page": args.page,
        }
    )
    url = f"{BASE}/api/search/getsearchresults?{params}"
    _, raw = _request(url)
    data = json.loads(raw.decode("utf-8", errors="replace"))
    if args.raw:
        _emit(data)
        return
    results = data.get("Results", []) or []
    for r in results:
        title = r.get("Title", "")
        link = r.get("Link", "")
        rtype = r.get("ResultType", "")
        date = r.get("ResultDate", "")
        print(f"{title}")
        if link:
            print(f"  {link}")
        if rtype:
            print(f"  [{rtype}]")
        if date:
            print(f"  {date}")
        print()


def cmd_news_tags(args: argparse.Namespace) -> None:
    url = f"{BASE}/api/news/getTags"
    _, raw = _request(url)
    data = json.loads(raw.decode("utf-8", errors="replace"))
    # result field is a JSON-encoded string - parse twice
    inner = json.loads(data.get("result", "[]"))
    if args.raw:
        _emit(inner)
        return
    for tag in inner:
        name = tag.get("TagName", "")
        subs = tag.get("SubTags", [])
        if subs:
            print(f"{name}:")
            for s in subs:
                # SubTags have extra quotes like
                # "'Børn'" - strip them
                clean = s.strip("'\"")
                print(f"  - {clean}")
        else:
            print(f"{name}")


def cmd_news(args: argparse.Namespace) -> None:
    params = urllib.parse.urlencode({"newsTypeTag": args.tag}) if args.tag else ""
    url = f"{BASE}/api/news/getNews"
    if params:
        url = f"{url}?{params}"
    _, raw = _request(url)
    data = json.loads(raw.decode("utf-8", errors="replace"))
    # newsArticles field is a JSON-encoded string - parse twice
    articles_raw = data.get("newsArticles", "[]")
    if isinstance(articles_raw, str):
        articles = json.loads(articles_raw)
    else:
        articles = articles_raw or []
    if args.raw:
        _emit(articles)
        return
    if not articles:
        sys.stderr.write("No news articles found\n")
        sys.exit(2)
    for a in articles:
        title = a.get("ArticleTitle", "")
        link = a.get("Url", "")
        date = a.get("PublishingDateTime", "")
        print(f"{title}")
        if link:
            print(f"  {link}")
        if date:
            print(f"  {date}")
        print()


def cmd_endpoints(args: argparse.Namespace) -> None:
    apis: set[str] = set()
    # Scan rendered HTML
    _, raw = _request(
        BASE,
        headers={"Accept": "text/html"},
    )
    html = raw.decode("utf-8", errors="replace")
    apis.update(
        re.findall(
            r"/api/[a-zA-Z0-9/_.-]+",
            html,
        )
    )
    # Also scan the main JS bundle (contains
    # form/sbs API paths)
    # Remove Accept header to avoid 406 on .js files
    h: dict[str, str] = {"User-Agent": UA}
    req = urllib.request.Request(
        f"{BASE}/Assets/js/main.js",
        headers=h,
    )
    with urllib.request.urlopen(
        req,
        timeout=30.0,
    ) as r:
        js = r.read().decode("utf-8", errors="replace")
    apis.update(
        re.findall(
            r"/api/[a-zA-Z0-9/_.-]+",
            js,
        )
    )
    apis = sorted(apis)
    if not apis:
        sys.stderr.write("No /api/* paths found\n")
        sys.exit(2)
    for a in apis:
        print(a)


if __name__ == "__main__":
    main()
