#!/usr/bin/env python3
"""Thin CLI for the public APIs behind https://www.frederiksberg.dk/.

Standard library only. See ./SKILL.md for the full spec.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import typing as t
import urllib.error
import urllib.request

BASE = "https://www.frederiksberg.dk"
UA = "Mozilla/5.0 (frederiksberg-dk-api-cli)"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser(
        "typeahead",
        help="search typeahead (autocomplete)",
    )
    p.add_argument(
        "term",
        help="search term",
    )
    p.add_argument(
        "--lang",
        default="da",
        help="da | en  (default: da)",
    )
    p.add_argument(
        "--limit",
        type=int,
        default=10,
    )
    p.add_argument("--raw", action="store_true")
    p.set_defaults(func=cmd_typeahead)

    p = sub.add_parser(
        "top-questions",
        help="get top FAQ questions",
    )
    p.add_argument("--raw", action="store_true")
    p.set_defaults(func=cmd_top_questions)

    p = sub.add_parser(
        "agenda",
        help="fetch meeting agenda items",
    )
    p.add_argument(
        "--page-id",
        required=True,
        help="pageId from meta tag",
    )
    p.add_argument(
        "--page-url",
        required=True,
        help="page URL slug",
    )
    p.add_argument(
        "--folder-id",
        required=True,
        help="FolderId",
    )
    p.add_argument(
        "--element-id",
        required=True,
        help="elementId",
    )
    p.add_argument(
        "--page-size",
        type=int,
        default=5,
    )
    p.add_argument(
        "--page-number",
        type=int,
        default=1,
    )
    p.add_argument("--raw", action="store_true")
    p.set_defaults(func=cmd_agenda)

    p = sub.add_parser(
        "sitemap",
        help="enumerate URLs from /sitemap.xml",
    )
    p.add_argument(
        "--section",
        help="filter to a section, e.g. 'borgerservice'",
    )
    p.add_argument(
        "--limit",
        type=int,
    )
    p.set_defaults(func=cmd_sitemap)

    p = sub.add_parser(
        "article",
        help="fetch a page and extract meta/title",
    )
    p.add_argument(
        "path",
        help="page path, e.g. /borgerservice/pas",
    )
    p.add_argument("--raw", action="store_true")
    p.set_defaults(func=cmd_article)

    args = parser.parse_args()
    args.func(args)


def _request(
    path: str,
    method: str = "GET",
    body: bytes | None = None,
    headers: dict[str, str] | None = None,
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
        with urllib.request.urlopen(req, timeout=30) as r:
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


def _emit(obj: t.Any) -> None:
    print(json.dumps(obj, ensure_ascii=False, indent=2))


def cmd_typeahead(args: argparse.Namespace) -> None:
    url = (
        f"{BASE}/api/search/GetTypeAhead?"
        f"searchTerm={urllib.request.quote(args.term)}"
        f"&lang={args.lang}")
    _, raw = _request(url)
    data = json.loads(
        raw.decode("utf-8", errors="replace"))
    if args.raw:
        _emit(data)
        return
    results = (
        data.get("results", data.get("items", []))
        if isinstance(data, dict) else [])
    for item in results[:args.limit]:
        title = item.get(
            "title", item.get("name", ""))
        url = item.get(
            "url", item.get("link", ""))
        print(f"{url}\n  {title}")


def cmd_top_questions(
    args: argparse.Namespace,
) -> None:
    url = f"{BASE}/api/search/GetTopQuestions"
    data_json = json.dumps({}).encode("utf-8")
    _, raw = _request(
        url,
        method="POST",
        body=data_json,
        headers={
            "Content-Type": "application/json",
            "Content-Length": str(len(data_json)),
        },
    )
    data = json.loads(
        raw.decode("utf-8", errors="replace"))
    if args.raw:
        _emit(data)
        return
    questions = (
        data.get("questions", data.get("items", []))
        if isinstance(data, dict) else [])
    for q in questions:
        print(
            q.get("question",
                  q.get("title", str(q))))


def cmd_agenda(args: argparse.Namespace) -> None:
    url = (
        f"{BASE}/surface/AgendaSurface/GetAgendaList?"
        f"pageId={args.page_id}"
        f"&pageSize={args.page_size}"
        f"&pageNumber={args.page_number}"
        f"&pageUrl={urllib.request.quote(args.page_url)}"
        f"&folderId={args.folder_id}"
        f"&elementId={args.element_id}")
    _, raw = _request(url)
    data = json.loads(
        raw.decode("utf-8", errors="replace"))
    if args.raw:
        _emit(data)
        return
    items = (
        data.get("items", [])
        if isinstance(data, dict) else [])
    for item in items:
        title = item.get(
            "title", item.get("name", ""))
        date = item.get(
            "date", item.get("startDate", ""))
        print(f"{date}\t{title}")


def cmd_sitemap(args: argparse.Namespace) -> None:
    _, raw = _request(f"{BASE}/sitemap.xml")
    xml = raw.decode("utf-8", errors="replace")
    locs = re.findall(r"<loc>([^<]+)</loc>", xml)
    if args.section:
        prefix = "/" + args.section.lstrip("/")
        locs = [
            u
            for u in locs
            if ("/"
                + u.split("/", 3)[-1]
                .startswith(prefix))
        ]
    if args.limit:
        locs = locs[:args.limit]
    for u in locs:
        print(u)


def cmd_article(args: argparse.Namespace) -> None:
    _, raw = _request(args.path)
    html = raw.decode("utf-8", errors="replace")
    # Extract meta tags
    metas: dict[str, str] = {}
    for m in re.finditer(
        r'<meta\s+name="([^"]+)"\s+'
        r'content="([^"]*)"',
        html,
    ):
        metas[m.group(1)] = m.group(2)
    # Extract title
    title_m = re.search(
        r'<title>([^<]*)</title>', html)
    title = (
        title_m.group(1) if title_m else "")
    # Extract main content (first <main> block)
    main_m = re.search(
        r'<main[^>]*>(.*?)</main>',
        html,
        re.DOTALL,
    )
    content = (
        main_m.group(1) or ""
        if main_m else "")
    if args.raw:
        _emit({
            "title": title,
            "meta": metas,
            "content_length": len(content),
        })
    else:
        print(f"Title: {title}")
        for k, v in metas.items():
            print(f"  {k}: {v}")


if __name__ == "__main__":
    main()
