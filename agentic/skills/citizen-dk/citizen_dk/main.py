#!/usr/bin/env python3
"""Slim CLI to search Danish citizen / public-service portals.

Searches the Q&A surface of the official portals via their internal JSON APIs,
grouped under one ``search`` command with a ``--source`` switch:

- ``borger``        -- borger.dk, the national citizen portal (autocomplete
                       suggestions: the topics people search for)
- ``nyidanmark``    -- nyidanmark.dk, the immigration portal (full results with
                       links)
- ``frederiksberg`` -- frederiksberg.dk municipal search (typeahead suggestions)

Plus ``citizen municipality SLUG`` for factual pages on any of Denmark's 98
municipalities (kommune.dk WordPress REST API).

kk.dk (City of Copenhagen) has no JSON search API — its results are
JS-rendered; browse https://www.kk.dk/soeg?k=<query> for that portal.

Standard library only. See ./SKILL.md for the underlying API specs.
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

UA = "Mozilla/5.0 (citizen-dk-cli)"

# borger.dk Sitecore portal item ID, published as data-portal-id in the home
# page HTML and required by /api/search. Refresh from the home page if it
# re-keys (see SKILL.md).
BORGER_PORTAL_ID = "ecfef56c-98e7-42f9-9e22-37d9268009ad"

# frederiksberg.dk search APIs require a pageId; 15719 is the site-wide search
# page.
FBG_SEARCH_PAGE_ID = "15719"

SOURCES = ("borger", "nyidanmark", "frederiksberg")


# ---------------------------------------------------------------------------
# HTTP helpers
# ---------------------------------------------------------------------------


def _emit(obj: t.Any) -> None:
    """Pretty-print a JSON value (UTF-8 preserved)."""
    print(json.dumps(obj, ensure_ascii=False, indent=2))


def _request(
    url: str,
    method: str = "GET",
    body: dict | None = None,
    accept: str = "application/json",
) -> bytes:
    """Send an HTTP request, exiting non-zero on an HTTP/network error."""
    data: bytes | None = None
    headers = {"User-Agent": UA, "Accept": accept}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.read()
    except urllib.error.HTTPError as e:
        text = e.read() if e.fp else b""
        sys.stderr.write(f"HTTP {e.code} {e.reason} on {method} {url}\n")
        if text:
            sys.stderr.write(text.decode("utf-8", errors="replace").rstrip() + "\n")
        sys.exit(2)
    except urllib.error.URLError as e:
        sys.stderr.write(f"Network error on {method} {url}: {e.reason}\n")
        sys.exit(2)


def _request_json(url: str, method: str = "GET", body: dict | None = None) -> t.Any:
    """Send a request and parse the JSON body, exiting on a non-JSON response."""
    raw = _request(url, method=method, body=body)
    try:
        return json.loads(raw.decode("utf-8", errors="replace"))
    except json.JSONDecodeError:
        sys.stderr.write(f"Non-JSON response from {url}\n")
        sys.exit(2)


# ---------------------------------------------------------------------------
# Per-source search backends
# ---------------------------------------------------------------------------


def _search_borger(query: str, limit: int) -> list[dict[str, str]]:
    """borger.dk autocomplete — the suggested search topics for a term."""
    data = _request_json(
        "https://www.borger.dk/api/search",
        method="POST",
        body={"portalId": BORGER_PORTAL_ID, "snippet": query},
    )
    items = data if isinstance(data, list) else []
    return [
        {"title": it.get("Text", ""), "url": "", "kind": "suggestion"}
        for it in items[:limit]
    ]


def _search_nyidanmark(query: str, limit: int) -> list[dict[str, str]]:
    """nyidanmark.dk full-text search — results with titles and links."""
    params = urllib.parse.urlencode({"query": query, "page": 1})
    data = _request_json(f"https://nyidanmark.dk/api/search/getsearchresults?{params}")
    results = data.get("Results", []) or []
    out: list[dict[str, str]] = []
    for r in results[:limit]:
        link = r.get("Link", "")
        if link and link.startswith("/"):
            link = "https://nyidanmark.dk" + link
        out.append(
            {"title": r.get("Title", ""), "url": link, "kind": r.get("ResultType", "")}
        )
    return out


def _search_frederiksberg(query: str, limit: int) -> list[dict[str, str]]:
    """frederiksberg.dk typeahead — municipal search suggestions."""
    params = urllib.parse.urlencode(
        {"searchTerm": query, "pageId": FBG_SEARCH_PAGE_ID, "lang": "da"}
    )
    data = _request_json(
        f"https://www.frederiksberg.dk/api/search/GetTypeAhead?{params}"
    )
    items = data if isinstance(data, list) else []
    out: list[dict[str, str]] = []
    for it in items[:limit]:
        if isinstance(it, str):
            out.append({"title": it, "url": "", "kind": "suggestion"})
        elif isinstance(it, dict):
            out.append(
                {
                    "title": it.get("title", it.get("name", "")),
                    "url": it.get("url", it.get("link", "")),
                    "kind": "suggestion",
                }
            )
    return out


_BACKENDS = {
    "borger": _search_borger,
    "nyidanmark": _search_nyidanmark,
    "frederiksberg": _search_frederiksberg,
}


def cmd_search(args: argparse.Namespace) -> None:
    """Search a citizen portal's Q&A surface."""
    sources = SOURCES if args.source == "all" else [args.source]
    results: dict[str, list[dict[str, str]]] = {
        src: _BACKENDS[src](args.query, args.limit) for src in sources
    }

    if args.json:
        _emit(results)
        return

    for src in sources:
        rows = results[src]
        print(f"# {src}: {len(rows)} result(s) for {args.query!r}")
        for row in rows:
            line = f"  {row['title']}"
            if row.get("kind") and row["kind"] != "suggestion":
                line += f"  [{row['kind']}]"
            print(line)
            if row.get("url"):
                print(f"    {row['url']}")
        if len(sources) > 1:
            print()


# ---------------------------------------------------------------------------
# Municipality facts (kommune.dk WordPress REST API)
# ---------------------------------------------------------------------------

# Danish-letter transliteration used by kommune.dk page slugs.
_SLUG_MAP = str.maketrans(
    {"æ": "ae", "ø": "oe", "å": "a", "Æ": "ae", "Ø": "oe", "Å": "a"}
)


def _kommune_slug(name: str) -> str:
    """Normalise a municipality name to its kommune.dk slug."""
    return name.strip().lower().translate(_SLUG_MAP).replace(" ", "-")


def _strip_html(html: str) -> str:
    """Reduce a block of HTML to readable plain text."""
    text = re.sub(r"<(script|style)[^>]*>.*?</\1>", "", html, flags=re.S)
    text = re.sub(r"<[^>]+>", "", text)
    text = re.sub(r"&nbsp;", " ", text)
    text = re.sub(r"&amp;", "&", text)
    text = re.sub(r"\n\s*\n+", "\n\n", text)
    return text.strip()


def cmd_municipality(args: argparse.Namespace) -> None:
    """Fetch a municipality's factual page from kommune.dk."""
    slug = _kommune_slug(args.name)
    params = urllib.parse.urlencode({"slug": slug, "_fields": "title,content,link"})
    data = _request_json(f"https://www.kommune.dk/wp-json/wp/v2/pages?{params}")
    if not data:
        sys.stderr.write(
            f"No kommune.dk page for slug {slug!r} (from name {args.name!r}).\n"
        )
        sys.exit(2)
    page = data[0]
    if args.json:
        _emit(page)
        return
    title = page.get("title", {}).get("rendered", slug)
    print(f"# {title}  ({page.get('link', '')})")
    content = _strip_html(page.get("content", {}).get("rendered", ""))
    if args.section:
        # Keep from the matching heading to the next blank-line gap.
        low = content.lower()
        idx = low.find(args.section.lower())
        if idx == -1:
            sys.stderr.write(f"Section {args.section!r} not found on the page.\n")
            sys.exit(2)
        content = content[idx:]
    limit = args.chars
    print(content[:limit])
    if len(content) > limit:
        print(f"\n… (truncated at {limit} chars; use --chars N or --json)")


# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------


def main() -> None:
    """Entry point: parse arguments and dispatch to the selected command."""
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("search", help="search a citizen portal's Q&A surface")
    p.add_argument("query", help="search text")
    p.add_argument(
        "--source",
        choices=[*SOURCES, "all"],
        default="borger",
        help="portal to search (default: borger)",
    )
    p.add_argument("-n", "--limit", type=int, default=10, help="results (default 10)")
    p.add_argument("--json", action="store_true", help="raw JSON")
    p.set_defaults(func=cmd_search)

    p = sub.add_parser(
        "municipality",
        help="factual page for one of the 98 municipalities (kommune.dk)",
    )
    p.add_argument("name", help="municipality name, e.g. 'København' or 'Aarhus'")
    p.add_argument(
        "--section",
        help="jump to a section heading, e.g. 'borgerservice', 'skoler', 'boligmarkedet'",
    )
    p.add_argument(
        "--chars", type=int, default=2500, help="max characters to print (default 2500)"
    )
    p.add_argument("--json", action="store_true", help="raw JSON")
    p.set_defaults(func=cmd_municipality)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
