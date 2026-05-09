#!/usr/bin/env python3
"""Thin CLI for the TV 2 internal decks API.

Covers decks.services.tv2.dk - returns HTML fragments with article teasers.
See ./SKILL.md for full endpoint specifications.

Standard library only.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import typing as t
import urllib.error
import urllib.request


BASE_DECKS = "https://decks.services.tv2.dk"
UA = "Mozilla/5.0 (tv2-dk-api-cli)"

DEFAULT_HEADERS: dict[str, str] = {
    "User-Agent": UA,
    "Accept": "*/*",
}


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__.strip())
    sub = parser.add_subparsers(
        dest="cmd",
        required=True,
    )

    p = sub.add_parser(
        "deck",
        help="fetch a content deck by type",
    )
    p.add_argument(
        "deck_type",
        help="deck type (e.g. "
        "'cross_promo_site', 'play_deck')",
    )
    p.add_argument(
        "--site",
        default="nyheder",
        help="site identifier (default: nyheder)",
    )
    p.add_argument(
        "--section",
        help="section identifier "
        "(for cross_promo_site)",
    )
    p.add_argument(
        "--title",
        help="deck title (for play_deck)",
    )
    p.add_argument(
        "--title-link",
        help="title link URL (for play_deck)",
    )
    p.add_argument(
        "--cta-url",
        help="CTA button URL (for play_deck)",
    )
    p.add_argument(
        "--raw",
        action="store_true",
        help=(
            "print raw response (JSON structure "
            "with head/body)"),
    )
    p.set_defaults(func=cmd_deck)

    p = sub.add_parser(
        "deck-ids",
        help="discover deck types from a page",
    )
    p.add_argument(
        "--url",
        default="https://nyheder.tv2.dk/",
        help="page to scan for deck references",
    )
    p.set_defaults(func=cmd_deck_ids)

    p = sub.add_parser(
        "article",
        help="fetch an article by path",
    )
    p.add_argument(
        "path",
        help="article path without leading slash "
        "(e.g. '2026-05-08-navn-pa-artikel')",
    )
    p.set_defaults(func=cmd_article)

    p = sub.add_parser(
        "video-info",
        help="extract Brightcove player config from "
        "a page",
    )
    p.add_argument(
        "--url",
        default="https://play.tv2.dk/",
        help="page to inspect "
        "(default: https://play.tv2.dk/)",
    )
    p.set_defaults(func=cmd_video_info)

    args = parser.parse_args()
    args.func(args)


def _request(
    url: str,
    method: str = "GET",
    body: bytes | None = None,
    headers: dict[str, str] | None = None,
) -> tuple[int, bytes]:
    h: dict[str, str] = dict(DEFAULT_HEADERS)
    if headers:
        h.update(headers)
    data = body if body is not None else None
    req = urllib.request.Request(
        url, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(
            req, timeout=15,
        ) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        body_text = e.read() if e.fp else b""
        sys.stderr.write(
            f"HTTP {e.code} {e.reason} on "
            f"{method} {url}\n")
        if body_text:
            sys.stderr.write(
                body_text.decode("utf-8", errors="replace")
                .rstrip() + "\n")
        sys.exit(2)


def _emit_json(obj: t.Any) -> None:
    print(
        json.dumps(obj, ensure_ascii=False, indent=2))


def _parse_teasers(html: str) -> list[dict[str, str]]:
    """Extract article teasers from a deck HTML fragment."""
    teasers: list[dict[str, str]] = []
    # Split by article blocks
    article_blocks = re.split(
        r'<article class="tc_teaser"',
        html,
    )

    for block in article_blocks[1:]:  # skip
        # everything before first article
        teaser: dict[str, str] = {}

        # Extract URL from href
        href_m = re.search(
            r'<a href="([^"]+)"[^>]*'
            r'aria-label="([^"]*)"',
            block,
        )
        if href_m:
            teaser["url"] = href_m.group(1)
            teaser["title"] = href_m.group(2)

        # Extract headline
        heading_m = re.search(
            r'<h[2-6][^>]*>(.*?)</h[2-6]>',
            block,
            re.DOTALL,
        )
        if heading_m and not teaser.get("title"):
            teaser["title"] = (
                re.sub(
                    r'<[^>]+>',
                    '',
                    heading_m.group(1),
                ).strip())

        # Extract category label
        label_m = re.search(
            r'<span class="ds_label'
            r'(?:[^"]*)?">(.*?)</span>',
            block,
        )
        if label_m:
            teaser["category"] = (
                re.sub(
                    r'<[^>]+>',
                    '',
                    label_m.group(1),
                ).strip())

        # Extract timestamp/tagline
        tagline_m = re.search(
            r'<span class="tc_teaser__tagline__text">'
            r'(.*?)</span>',
            block,
        )
        if tagline_m:
            teaser["timestamp"] = (
                re.sub(
                    r'<[^>]+>',
                    '',
                    tagline_m.group(1),
                ).strip())

        # Extract image URL (use the largest
        # reasonable size)
        img_m = re.search(
            r'<img[^>]+src="(https://cdn'
            r'[^"]+?w=\d+&h=\d+[^"]*)"',
            block,
        )
        if img_m:
            teaser["imageUrl"] = img_m.group(1)

        if teaser.get("title"):
            teasers.append(teaser)

    return teasers


def cmd_deck(args: argparse.Namespace) -> None:
    """Fetch a content deck by type."""
    params: list[str] = []
    params.append(f"site={args.site}")
    if hasattr(args, "section") and args.section:
        params.append(f"section={args.section}")
    if hasattr(args, "title") and args.title:
        params.append(f"title={args.title}")
    if hasattr(args, "title_link") and args.title_link:
        params.append(
            f"titleLink={args.title_link}")
    if hasattr(args, "cta_url") and args.cta_url:
        params.append(
            f"ctaButtonUrl={args.cta_url}")

    url = (
        f"{BASE_DECKS}/deck/{args.deck_type}?"
        f"{'&'.join(params)}")
    status, raw = _request(url)

    response_text = raw.decode(
        "utf-8", errors="replace")

    # Try to parse as JSON-like structure
    try:
        parsed = json.loads(response_text)
        if isinstance(parsed, dict) and "body" in parsed:
            html_body = parsed["body"]
        else:
            html_body = response_text
    except json.JSONDecodeError:
        html_body = response_text

    # Extract teasers from HTML
    teasers = _parse_teasers(html_body)

    if args.raw:
        if 'parsed' in dir():
            _emit_json(parsed)
        else:
            print(response_text)
        return

    for t in teasers:
        category = t.get("category", "")
        ts = t.get("timestamp", "")
        parts: list[str] = []
        if category:
            parts.append(f"[{category}]")
        if ts:
            parts.append(ts)
        meta = " ".join(parts)
        print(f"{t['title']}")
        if meta:
            print(f"  {meta}")
        if t.get("url"):
            print(f"  {t['url']}")
        print()


def cmd_deck_ids(args: argparse.Namespace) -> None:
    """Discover deck types by scraping a known page."""
    target_url = args.url or "https://nyheder.tv2.dk/"
    status, raw = _request(target_url)
    html = raw.decode("utf-8", errors="replace")

    # Look for deck API calls in inline JS
    deck_refs: set[str] = set()
    for m in re.finditer(
        r'decks\.services\.tv2\.dk/deck/(\w+)',
        html,
    ):
        deck_refs.add(m.group(1))

    if deck_refs:
        for d in sorted(deck_refs):
            print(d)
    else:
        sys.stderr.write(
            "No deck references found. Try --url "
            "to specify a different page.\n")
        sys.exit(2)


def cmd_article(args: argparse.Namespace) -> None:
    """Fetch an article by constructing its URL and
    extracting text."""
    url = f"https://nyheder.tv2.dk/{args.path}"
    status, raw = _request(
        url,
        headers={"Accept": "text/html"},
    )
    html = raw.decode("utf-8", errors="replace")

    # Extract headline
    headline_m = re.search(
        r'<h1[^>]*>(.*?)</h1>',
        html,
        re.DOTALL | re.IGNORECASE,
    )
    headline = (
        re.sub(
            r'<[^>]+>',
            '',
            headline_m.group(1),
        ).strip()
        if headline_m else "(no headline)")

    # Extract article body
    body_m = re.search(
        r'class=["\'][^"\']*article-body'
        r'[^"\']*["\']>(.*?)</(?:div|section)>',
        html,
        re.DOTALL | re.IGNORECASE,
    )
    if body_m:
        body_text = re.sub(
            r'<[^>]+>',
            '\n',
            body_m.group(1),
        )
        body_text = re.sub(
            r'\n\s*\n',
            '\n\n',
            body_text,
        ).strip()
        print(headline)
        print("=" * len(headline))
        print()
        print(body_text)
    else:
        print(headline)
        print("=" * len(headline))
        print()
        print(
            "(Could not extract article body - "
            "content may be JS-rendered)")


def cmd_video_info(args: argparse.Namespace) -> None:
    """Extract Brightcove player config from a page."""
    target_url = args.url or "https://play.tv2.dk/"
    status, raw = _request(target_url)
    html = raw.decode("utf-8", errors="replace")

    # Look for Brightcove config in
    # window.tv2.brightcove
    bc_match = re.search(
        r'window\.tv2\.brightcove\s*=\s*'
        r'({.*?});',
        html,
        re.DOTALL,
    )
    if bc_match:
        try:
            config = json.loads(bc_match.group(1))
            # Only show non-sensitive keys
            safe_config = {
                k: v
                for k, v in config.items()
                if k != 'reelsPolicyKey'
            }
            _emit_json(safe_config)
        except json.JSONDecodeError:
            print(bc_match.group(1))
        return

    # Look for Brightcove iframe
    iframe_match = re.search(
        r'<iframe[^>]*src=["\']([^"\']*brightcove'
        r'[^"\']*)["\']',
        html,
    )
    if iframe_match:
        print("Brightcove iframe found:")
        print(f"  {iframe_match.group(1)}")
        return

    sys.stderr.write(
        "No Brightcove player config or iframe "
        "found.\n")
    sys.exit(2)


if __name__ == "__main__":
    main()
