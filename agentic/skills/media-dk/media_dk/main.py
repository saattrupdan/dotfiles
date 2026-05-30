#!/usr/bin/env python3
"""CLI for Danish broadcast media — DR (dr.dk) and TV 2 (tv2.dk).

Two commands over the broadcasters' anonymous content feeds:

- ``media news [--source dr|tv2|all]``    -- the latest news headlines
- ``media search QUERY [--source …]``     -- keyword search over recent content

Neither broadcaster exposes a clean public search API (DR's ``/soeg`` is
HTML-only and robots-blocked; TV 2 has none), so ``search`` is a **keyword
filter over the current/recent feeds** — it finds live and recent items, not the
full archive. For DR, news comes from the ``__NEXT_DATA__`` JSON embedded in the
news section pages; for TV 2, from the internal ``decks`` API.

Standard library only. See ./SKILL.md for the underlying specs.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import typing as t
import urllib.error
import urllib.request

UA = "Mozilla/5.0 (media-dk-cli)"

DR_BASE = "https://www.dr.dk"
# DR news section paths whose pages embed article lists in __NEXT_DATA__. The
# first two carry the broad "latest" flow; the rest add topical coverage that
# `search` sweeps for keyword matches.
DR_SECTIONS = (
    "/nyheder",
    "/nyheder/seneste",
    "/nyheder/indland",
    "/nyheder/udland",
    "/nyheder/politik",
    "/nyheder/penge",
)

TV2_DECKS = "https://decks.services.tv2.dk"
# TV 2 deck (site, section) pairs to sweep. The decks API mainly serves the
# nyheder site; these sections cover the bulk of its teasers.
TV2_SECTIONS = (
    ("nyheder", "nyheder"),
    ("nyheder", "samfund"),
    ("nyheder", "politik"),
    ("nyheder", "udland"),
)

SOURCES = ("dr", "tv2")


# ---------------------------------------------------------------------------
# HTTP helpers
# ---------------------------------------------------------------------------


def _emit(obj: t.Any) -> None:
    """Pretty-print a JSON value (UTF-8 preserved)."""
    print(json.dumps(obj, ensure_ascii=False, indent=2))


def _get(url: str, accept: str = "text/html") -> str | None:
    """GET a URL and return decoded text, or None on HTTP/network failure.

    News sweeps hit several pages; a single failing section should not abort
    the whole command, so failures degrade to None rather than exiting.
    """
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": accept})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.read().decode("utf-8", errors="replace")
    except (urllib.error.HTTPError, urllib.error.URLError) as e:
        reason = getattr(e, "reason", e)
        sys.stderr.write(f"warning: GET {url} failed: {reason}\n")
        return None


def _matches(text: str, keywords: list[str], mode: str) -> bool:
    """Test whether text contains the keywords (case-insensitive)."""
    low = text.lower()
    hits = [k.lower() in low for k in keywords]
    return all(hits) if mode == "all" else any(hits)


# ---------------------------------------------------------------------------
# DR (dr.dk) — articles from embedded __NEXT_DATA__
# ---------------------------------------------------------------------------


def _dr_next_data(html: str) -> dict | None:
    """Extract and parse the ``__NEXT_DATA__`` JSON blob from a DR page."""
    m = re.search(r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', html, re.DOTALL)
    if not m:
        return None
    try:
        return json.loads(m.group(1))
    except json.JSONDecodeError:
        return None


def _dr_section_articles(path: str) -> list[dict[str, str]]:
    """Fetch one DR news section and normalise its articles.

    Handles both page shapes: the news front page exposes
    ``viewProps.site.publications[].content`` while topical section pages use
    ``viewProps.siteFrontPage.newsFlow.articles[]``.
    """
    html = _get(DR_BASE + path)
    if not html:
        return []
    data = _dr_next_data(html)
    if not data:
        return []
    view = data.get("props", {}).get("pageProps", {}).get("viewProps", {})

    raw: list[dict] = []
    pubs = view.get("site", {}).get("publications", [])
    if pubs:
        raw = [p.get("content", {}) for p in pubs]
    else:
        raw = view.get("siteFrontPage", {}).get("newsFlow", {}).get("articles", [])

    out: list[dict[str, str]] = []
    for art in raw:
        if not art.get("title"):
            continue
        url_path = art.get("urlPathId", "")
        url = DR_BASE + url_path if url_path.startswith("/") else url_path
        out.append(
            {
                "title": art.get("title", ""),
                "url": url,
                "date": (art.get("startDate") or "")[:10],
                "section": path,
                "source": "dr",
            }
        )
    return out


def _dr_collect(paths: t.Iterable[str]) -> list[dict[str, str]]:
    """Collect and de-duplicate DR articles across several section paths."""
    seen: set[str] = set()
    out: list[dict[str, str]] = []
    for path in paths:
        for art in _dr_section_articles(path):
            key = art["url"] or art["title"]
            if key in seen:
                continue
            seen.add(key)
            out.append(art)
    return out


# ---------------------------------------------------------------------------
# TV 2 (tv2.dk) — teasers from the decks API
# ---------------------------------------------------------------------------


def _tv2_parse_teasers(html: str, site: str, section: str) -> list[dict[str, str]]:
    """Extract article teasers from a TV 2 deck HTML fragment."""
    teasers: list[dict[str, str]] = []
    for block in re.split(r'<article class="tc_teaser"', html)[1:]:
        m = re.search(r'<a href="([^"]+)"[^>]*aria-label="([^"]*)"', block)
        title, url = "", ""
        if m:
            url, title = m.group(1), m.group(2)
        if not title:
            h = re.search(r"<h[2-6][^>]*>(.*?)</h[2-6]>", block, re.DOTALL)
            if h:
                title = re.sub(r"<[^>]+>", "", h.group(1)).strip()
        ts = re.search(r'<span class="tc_teaser__tagline__text">(.*?)</span>', block)
        if title:
            teasers.append(
                {
                    "title": title,
                    "url": url,
                    "date": re.sub(r"<[^>]+>", "", ts.group(1)).strip() if ts else "",
                    "section": section,
                    "source": "tv2",
                }
            )
    return teasers


def _tv2_section(site: str, section: str) -> list[dict[str, str]]:
    """Fetch and parse one TV 2 cross-promo deck."""
    url = f"{TV2_DECKS}/deck/cross_promo_site?site={site}&section={section}"
    raw = _get(url, accept="*/*")
    if not raw:
        return []
    try:
        parsed = json.loads(raw)
        body = parsed.get("body", raw) if isinstance(parsed, dict) else raw
    except json.JSONDecodeError:
        body = raw
    return _tv2_parse_teasers(body, site, section)


def _tv2_collect(sections: t.Iterable[tuple[str, str]]) -> list[dict[str, str]]:
    """Collect and de-duplicate TV 2 teasers across several decks."""
    seen: set[str] = set()
    out: list[dict[str, str]] = []
    for site, section in sections:
        for art in _tv2_section(site, section):
            key = art["url"] or art["title"]
            if key in seen:
                continue
            seen.add(key)
            out.append(art)
    return out


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------


def _print_articles(articles: list[dict[str, str]]) -> None:
    """Print a list of normalised articles as readable rows."""
    for art in articles:
        date = f"[{art['date']}] " if art.get("date") else ""
        print(f"{date}{art['title']}")
        if art.get("url"):
            print(f"  {art['url']}")


def cmd_news(args: argparse.Namespace) -> None:
    """Show the latest news from DR and/or TV 2."""
    sources = SOURCES if args.source == "all" else [args.source]
    out: dict[str, list[dict[str, str]]] = {}

    if "dr" in sources:
        paths = [f"/nyheder/{args.section}"] if args.section else list(DR_SECTIONS[:2])
        out["dr"] = _dr_collect(paths)[: args.limit]
    if "tv2" in sources:
        secs = [("nyheder", args.section)] if args.section else list(TV2_SECTIONS[:1])
        out["tv2"] = _tv2_collect(secs)[: args.limit]

    if args.json:
        _emit(out)
        return

    for src in sources:
        rows = out.get(src, [])
        print(f"# {src}: {len(rows)} headline(s)")
        _print_articles(rows)
        if len(sources) > 1:
            print()


def cmd_search(args: argparse.Namespace) -> None:
    """Keyword-search recent DR / TV 2 content.

    Sweeps the broadcasters' current news feeds and keeps items whose headline
    matches the keyword(s). This is recent-content search, not a full archive.
    """
    sources = SOURCES if args.source == "all" else [args.source]
    pool: list[dict[str, str]] = []
    if "dr" in sources:
        pool += _dr_collect(DR_SECTIONS)
    if "tv2" in sources:
        pool += _tv2_collect(TV2_SECTIONS)

    matched = [a for a in pool if _matches(a["title"], args.keyword, args.match)]
    matched = matched[: args.limit]

    if args.json:
        _emit(matched)
        return

    print(
        f"# {len(matched)} match(es) for {args.match}({', '.join(args.keyword)}) "
        f"across {len(pool)} recent items ({', '.join(sources)})"
    )
    _print_articles(matched)


# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------


def main() -> None:
    """Entry point: parse arguments and dispatch to the selected command."""
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("news", help="latest news headlines (DR / TV 2)")
    p.add_argument(
        "--source",
        choices=[*SOURCES, "all"],
        default="all",
        help="broadcaster (default: all)",
    )
    p.add_argument(
        "--section",
        help="DR section slug (e.g. indland, udland, politik, penge) / TV 2 section",
    )
    p.add_argument("-n", "--limit", type=int, default=10, help="headlines (default 10)")
    p.add_argument("--json", action="store_true", help="raw JSON")
    p.set_defaults(func=cmd_news)

    p = sub.add_parser("search", help="keyword-search recent DR / TV 2 content")
    p.add_argument(
        "keyword",
        nargs="+",
        metavar="TERM",
        help="keyword(s) to match in headlines (space-separated)",
    )
    p.add_argument(
        "--source",
        choices=[*SOURCES, "all"],
        default="all",
        help="broadcaster (default: all)",
    )
    p.add_argument(
        "--match",
        choices=["all", "any"],
        default="any",
        help="require all keywords or any of them (default: any)",
    )
    p.add_argument("-n", "--limit", type=int, default=20, help="results (default 20)")
    p.add_argument("--json", action="store_true", help="raw JSON")
    p.set_defaults(func=cmd_search)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
