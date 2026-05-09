#!/usr/bin/env python3
"""Thin CLI for the anonymous endpoints on https://lex.dk/.

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

DEFAULT_HOST = "lex.dk"
UA = "Mozilla/5.0 (lex-dk-api-cli)"
SITEMAP_NS = {"sm": "http://www.sitemaps.org/schemas/sitemap/0.9"}


def main() -> None:
    p = argparse.ArgumentParser(
        description="Anonymous lex.dk endpoints (CLI).")
    p.add_argument(
        "--host",
        default=DEFAULT_HOST,
        help=(
            "lex.dk subdomain to target. Default: lex.dk. "
            "Examples: trap.lex.dk, "
            "danmarkshistorien.lex.dk, "
            "biografiskleksikon.lex.dk."),
    )
    sub = p.add_subparsers(dest="cmd", required=True)

    ac = sub.add_parser(
        "autocomplete",
        help="Free-text autocomplete "
        "(returns up to 5 hits).")
    ac.add_argument(
        "term",
        help="Search term, e.g. 'Marie Curie'.")
    ac.add_argument(
        "--raw",
        action="store_true",
        help="Print raw JSON.")
    ac.set_defaults(func=cmd_autocomplete)

    ar = sub.add_parser(
        "article",
        help="Fetch /<Slug>.json - "
        "full article as JSON.")
    ar.add_argument(
        "slug",
        help="Article slug, e.g. "
        "Marie_Curie (no leading slash).")
    ar.add_argument(
        "--raw",
        action="store_true",
        help="One-line JSON.")
    ar.set_defaults(func=cmd_article)

    tx = sub.add_parser(
        "taxonomy",
        help="Fetch /.taxonomy/<id>.json - "
        "node breadcrumb.")
    tx.add_argument(
        "id",
        help="Taxonomy ID, e.g. 1648.")
    tx.add_argument(
        "--raw",
        action="store_true",
        help="Print raw JSON.")
    tx.set_defaults(func=cmd_taxonomy)

    rc = sub.add_parser(
        "recent",
        help="Fetch /.recent-activities.json - "
        "recent edits feed.")
    rc.add_argument(
        "--limit",
        type=int,
        default=20,
        help="Max items to print (default 20).")
    rc.add_argument(
        "--raw",
        action="store_true",
        help="Print raw JSON.")
    rc.set_defaults(func=cmd_recent)

    df = sub.add_parser(
        "define",
        help="Den Danske Ordbog passthrough at "
        "/api/definition/v1/definition/<word>.")
    df.add_argument(
        "word",
        help="Danish word, e.g. blod.")
    df.add_argument(
        "--raw",
        action="store_true",
        help="Print raw JSON.")
    df.set_defaults(func=cmd_define)

    st = sub.add_parser(
        "status",
        help="GET /.status - plaintext health check.")
    st.set_defaults(func=cmd_status)

    an = sub.add_parser(
        "announcements",
        help="Site-wide announcement banners.")
    an.add_argument(
        "--raw",
        action="store_true",
        help="Print raw JSON.")
    an.set_defaults(func=cmd_announcements)

    sm = sub.add_parser(
        "sitemap",
        help="List sitemap shards from the sitemap index.")
    sm.add_argument(
        "--raw",
        action="store_true",
        help="Print as JSON list.")
    sm.set_defaults(func=cmd_sitemap)

    ur = sub.add_parser(
        "urls",
        help="Print all <loc> URLs in a sitemap shard.")
    ur.add_argument(
        "--shard",
        required=True,
        help="Shard number (e.g. 1) or full "
        "sitemap URL.",
    )
    ur.add_argument(
        "--grep",
        help="Regex (case-insensitive) to filter URLs.")
    ur.add_argument(
        "--raw",
        action="store_true",
        help="Print as JSON list.")
    ur.set_defaults(func=cmd_urls)

    am = sub.add_parser(
        "article-meta",
        help="Fetch /<Slug> and extract articleId, "
        "breadcrumb, schema.org JSON-LD.")
    am.add_argument(
        "slug",
        help="Article slug, e.g. "
        "Marie_Curie (no leading slash).")
    am.add_argument(
        "--raw",
        action="store_true",
        help="One-line JSON.")
    am.set_defaults(func=cmd_article_meta)

    args = p.parse_args()
    args.func(args)


def _request(
    host: str,
    path: str,
    *,
    accept: str = "application/json",
) -> tuple[str, str]:
    """Return (text, content_type). HTTP errors exit non-zero."""
    url = f"https://{host}{path}"
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": UA,
            "Accept": accept,
        },
    )
    try:
        with urllib.request.urlopen(
            req, timeout=30,
        ) as r:
            ctype = r.headers.get("Content-Type", "")
            return (
                r.read().decode("utf-8", errors="replace"),
                ctype,
            )
    except urllib.error.HTTPError as e:
        body = (
            e.read().decode("utf-8", errors="replace")
            if e.fp else "")
        ctype = (
            e.headers.get("Content-Type", "")
            if e.headers else "")
        sys.stderr.write(
            f"HTTP {e.code} {e.reason} on GET {url}\n")
        # Only echo the body when it's structured
        # (JSON/plain). HTML 404 pages are ~50 kB of
        # boilerplate; truncate hard.
        if body:
            if ctype.startswith((
                "application/json",
                "text/plain",
            )):
                sys.stderr.write(
                    body.rstrip() + "\n")
            else:
                sys.stderr.write(
                    body[:160]
                    .replace("\n", " ")
                    .rstrip() + " ...\n")
        sys.exit(2)


def _print_json(
    obj: t.Any,
    raw: bool,
) -> None:
    if raw:
        json.dump(obj, sys.stdout, ensure_ascii=False)
        sys.stdout.write("\n")
    else:
        json.dump(
            obj,
            sys.stdout,
            ensure_ascii=False,
            indent=2,
        )
        sys.stdout.write("\n")


def _sitemap_index(host: str) -> list[str]:
    text, _ = _request(
        host,
        "/.sitemap/sitemap.xml",
        accept="application/xml",
    )
    root = ET.fromstring(text)
    return [
        loc.text
        for loc in root.findall(
            "sm:sitemap/sm:loc",
            SITEMAP_NS,
        )
        if loc.text
    ]


def cmd_autocomplete(
    args: argparse.Namespace,
) -> None:
    if not args.term.strip():
        sys.stderr.write(
            "autocomplete: empty query\n")
        sys.exit(2)
    qs = urllib.parse.urlencode(
        {"query": args.term})
    text, _ = _request(
        args.host,
        f"/.search/autocomplete?{qs}")
    try:
        items = json.loads(text)
    except json.JSONDecodeError:
        sys.stderr.write(
            "Non-JSON response:\n" + text[:400] + "\n")
        sys.exit(2)
    if args.raw:
        _print_json(items, raw=True)
        return
    if not items:
        print("(no suggestions)")
        return
    for it in items:
        enc = it.get("encyclopedia") or "Lex"
        print(f"[{enc}] {it.get('title','')}")
        print(f"  {it.get('article_url','')}")
        excerpt = (
            it.get("excerpt") or "").strip()
        if excerpt:
            print(f"  {excerpt}")


def cmd_article(args: argparse.Namespace) -> None:
    """GET /<Slug>.json - the full article as JSON."""
    slug = urllib.parse.quote(
        args.slug.lstrip("/"),
        safe="_-,.()%")
    text, _ = _request(args.host, f"/{slug}.json")
    obj = json.loads(text)
    if args.raw:
        _print_json(obj, raw=True)
        return
    print(f"id:           {obj.get('id')}")
    print(f"title:        {obj.get('title')}")
    print(f"url:          {obj.get('url')}")
    print(
        f"subject:      "
        f"{obj.get('subject_title')}  "
        f"({obj.get('subject_url')})")
    print(f"changed_at:   {obj.get('changed_at')}")
    print(f"created_at:   {obj.get('created_at')}")
    print(f"licence:      {obj.get('license_name')}")
    authors = obj.get("authors") or []
    if authors:
        print("authors:")
        for a in authors:
            name = (
                a.get("full_name")
                or a.get("name") or "?")
            ident = a.get("id")
            print(
                f"  - {name}"
                + (f" (id={ident})" if ident else ""))
    images = obj.get("images") or []
    if images:
        print(f"images:       {len(images)}")
    body = obj.get("xhtml_body") or ""
    print(f"xhtml_body:   {len(body)} chars")


def cmd_taxonomy(args: argparse.Namespace) -> None:
    text, _ = _request(
        args.host,
        f"/.taxonomy/{args.id}.json")
    obj = json.loads(text)
    if args.raw:
        _print_json(obj, raw=True)
        return
    tax = obj.get("taxonomy") or {}
    print(f"title:    {tax.get('title')}")
    ancestors = tax.get("ancestors") or []
    if ancestors:
        print("ancestors:")
        for a in ancestors:
            print(
                f"  - {a.get('title')}  "
                f"({a.get('url')})")


def cmd_recent(args: argparse.Namespace) -> None:
    text, _ = _request(
        args.host,
        "/.recent-activities.json")
    items = json.loads(text)
    if args.raw:
        _print_json(items, raw=True)
        return
    for it in items[:args.limit]:
        props = it.get("properties") or {}
        print(
            f"{it.get('created_at','?')[:19]}  "
            f"{props.get('action','?'):<18}  "
            f"{props.get('article_title','?')}  "
            f"by {props.get('user_name','?')}")


def cmd_define(args: argparse.Namespace) -> None:
    word = urllib.parse.quote(args.word, safe="")
    text, _ = _request(
        args.host,
        f"/api/definition/v1/definition/{word}")
    obj = json.loads(text)
    if args.raw:
        _print_json(obj, raw=True)
        return
    if not obj:
        print(
            f"(no definition for {args.word!r})")
        return
    for entry in obj:
        head = entry.get("word", args.word)
        pos = entry.get("partOfSpeech", "")
        print(f"{head}  [{pos}]")
        for d in (
            entry.get("definitions", []) or []):
            print(f"  - {d.get('definition','')}")


def cmd_status(args: argparse.Namespace) -> None:
    text, _ = _request(
        args.host,
        "/.status",
        accept="text/plain",
    )
    sys.stdout.write(
        text
        if text.endswith("\n")
        else text + "\n")


def cmd_announcements(
    args: argparse.Namespace,
) -> None:
    text, _ = _request(
        args.host,
        "/.announcements?v=2")
    obj = json.loads(text)
    _print_json(obj, raw=args.raw)


def cmd_sitemap(args: argparse.Namespace) -> None:
    locs = _sitemap_index(args.host)
    if args.raw:
        _print_json(locs, raw=True)
    else:
        for loc in locs:
            print(loc)


def cmd_urls(args: argparse.Namespace) -> None:
    locs = _sitemap_index(args.host)
    # Pick the shard either by full URL or by integer
    # index (1-based, as the file naming).
    target: str | None = None
    for loc in locs:
        if (loc == args.shard
                or loc.endswith(
                    f"/sitemap{args.shard}.xml")):
            target = loc
            break
    if target is None:
        sys.stderr.write(
            f"Shard {args.shard!r} not found. "
            "Available:\n")
        for loc in locs:
            sys.stderr.write(f"  {loc}\n")
        sys.exit(2)
    parsed = urllib.parse.urlparse(target)
    text, _ = _request(
        parsed.netloc,
        parsed.path,
        accept="application/xml",
    )
    root = ET.fromstring(text)
    urls = [
        u.text
        for u in root.findall(
            "sm:url/sm:loc",
            SITEMAP_NS,
        )
        if u.text
    ]
    if args.grep:
        pat = re.compile(
            args.grep,
            re.IGNORECASE,
        )
        urls = [u for u in urls if pat.search(u)]
    if args.raw:
        _print_json(urls, raw=True)
    else:
        for u in urls:
            print(u)


def cmd_article_meta(
    args: argparse.Namespace,
) -> None:
    """Pull the schema.org JSON-LD and dataLayer
    articleId out of an article HTML page."""
    path = "/" + urllib.parse.quote(
        args.slug.lstrip("/"),
        safe="_-,.()%")
    text, _ = _request(
        args.host,
        path,
        accept="text/html",
    )
    out: dict[str, t.Any] = {
        "slug": args.slug,
        "host": args.host,
    }

    m = re.search(
        r'dataLayer\s*=\s*(\[\{.*?\}\])\s*</script>',
        text,
        re.DOTALL,
    )
    if m:
        try:
            dl = json.loads(m.group(1))
            if dl and isinstance(dl, list):
                out["articleId"] = (
                    dl[0].get("articleId"))
                out["breadcrumb"] = (
                    dl[0].get("breadcrumb"))
        except json.JSONDecodeError:
            pass

    m = re.search(
        r'<script type="application/ld\+json">'
        r'(.*?)</script>',
        text,
        re.DOTALL,
    )
    if m:
        try:
            out["jsonld"] = json.loads(m.group(1))
        except json.JSONDecodeError:
            out["jsonld_raw"] = m.group(1)[:500]

    title_m = re.search(
        r"<title>([^<]+)</title>", text)
    if title_m:
        out["page_title"] = title_m.group(1)

    _print_json(out, raw=args.raw)


if __name__ == "__main__":
    main()
