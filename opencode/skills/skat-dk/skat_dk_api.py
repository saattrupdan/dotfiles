#!/usr/bin/env python3
"""Thin CLI for the public read APIs behind https://skat.dk/.

Wraps the three useful surfaces:
  - Next.js data feed     (/_next/data/<buildId>/<locale>/<path>.json)
  - Cludo search backend  (https://api.cludo.com/api/v3/<custId>/<engineId>/search)
  - sitemap.xml           (URL enumeration)

Standard library only. See ./SKILL.md for the underlying spec.
"""
from __future__ import annotations

import argparse
import base64
import json
import re
import sys
import typing as t
import urllib.error
import urllib.parse
import urllib.request

BASE = "https://skat.dk"
CLUDO_API = "https://api.cludo.com/api/v3"
CLUDO_CUSTOMER = "2073"
UA = "Mozilla/5.0 (skat-dk-api-cli)"

# Cludo engine IDs by skat.dk product family (theme), per language.
# Source: chunk 4981-..., switch on theme name. Default is "da" if
# language unmapped.
ENGINES: dict[str, dict[str, str]] = {
    "SKAT":          {
        "da": "13369", "en": "13460",
        "de": "13213", "default": "13514",
    },
    "TOLDST":        {
        "da": "13130", "en": "13212",
        "de": "13213", "default": "13130",
    },
    "MOTORST":       {
        "da": "13214", "en": "13215",
        "de": "13502", "default": "13214",
    },
    "VURDST":        {
        "da": "13217", "en": "13218",
        "de": "13219", "default": "13217",
    },
    "GAELDST":       {
        "da": "13220", "en": "13221",
        "de": "13222", "default": "13220",
    },
    "SANST":         {"da": "13224"},
    "SKM":           {"da": "13225"},
    "SKTST":         {"da": "13226"},
    "SKTFV":         {"da": "13227"},
    "ADST":          {"da": "13228"},
    "UFST":          {"da": "13230"},
    "WEBGUIDE":      {"da": "13230"},
    "ITTI":          {"da": "13459"},
    "ZISE":          {"da": "14353"},
    "LOTTERIREGLER": {"da": "14828"},
}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser(
        "buildid",
        help="print the current Next.js buildId",
    )
    p.set_defaults(func=cmd_buildid)

    p = sub.add_parser(
        "page",
        help="fetch a page's JSON model from "
        "/_next/data/",
    )
    p.add_argument(
        "path",
        help='page path minus locale, e.g. '
        '"borger/fradrag" or "individuals"',
    )
    p.add_argument(
        "--locale",
        default="da-dk",
        help="da-dk | en-us | de-de | uk | pl | ro | "
        "lt | kl  (default: da-dk)",
    )
    p.add_argument(
        "--build-id",
        help="override the buildId "
        "(default: auto-detect)",
    )
    p.add_argument(
        "--field",
        help=(
            'dotted path into the JSON, e.g. '
            '"pageProps.content.page.childPages[].url"'),
    )
    p.set_defaults(func=cmd_page)

    p = sub.add_parser(
        "search",
        help="Cludo search across a skat.dk-family site",
    )
    p.add_argument("query")
    p.add_argument(
        "--site",
        default="SKAT",
        help="theme key: SKAT | TOLDST | MOTORST | "
        "VURDST | GAELDST | SANST | SKM | SKTST | "
        "SKTFV | ADST | UFST | WEBGUIDE | ITTI | "
        "ZISE | LOTTERIREGLER  (default: SKAT)",
    )
    p.add_argument(
        "--lang",
        default="da",
        help="da | en | de  (default: da)",
    )
    p.add_argument(
        "--engine",
        help="explicit engineId; overrides --site/--lang",
    )
    p.add_argument(
        "--size",
        type=int,
        default=10,
        help="page size (default 10)",
    )
    p.add_argument(
        "--page",
        type=int,
        default=1,
        help="page number (default 1)",
    )
    p.add_argument(
        "--facets",
        help='comma-separated facet names, e.g. "Category"',
    )
    p.add_argument(
        "--raw",
        action="store_true",
        help="print raw JSON response",
    )
    p.add_argument(
        "--verbose",
        "-v",
        action="store_true",
        help="also print descriptions",
    )
    p.set_defaults(func=cmd_search)

    p = sub.add_parser(
        "settings",
        help="Cludo public engine settings (no auth)",
    )
    p.add_argument(
        "engine",
        help="engineId, e.g. 13369 (SKAT/da)",
    )
    p.set_defaults(func=cmd_settings)

    p = sub.add_parser(
        "engines",
        help="print the Cludo engineId map",
    )
    p.add_argument("--raw", action="store_true")
    p.set_defaults(func=cmd_engines)

    p = sub.add_parser(
        "sitemap",
        help="enumerate URLs from /sitemap.xml",
    )
    p.add_argument(
        "--prefix",
        help=(
            'filter to URLs whose path starts with '
            'this, e.g. "/borger/"'),
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
    req = urllib.request.Request(
        url, data=body, method=method, headers=h)
    try:
        with urllib.request.urlopen(
            req, timeout=timeout,
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


def _emit(obj: t.Any) -> None:
    if isinstance(obj, (dict, list)):
        print(
            json.dumps(obj, ensure_ascii=False, indent=2))
    else:
        print(obj)


def _fetch_buildid(
    html: str | None = None,
) -> str:
    if html is None:
        _, raw = _request(
            f"{BASE}/borger",
            headers={"Accept": "text/html"},
        )
        html = raw.decode("utf-8", errors="replace")
    m = re.search(
        r'"buildId":"([^"]+)"', html)
    if not m:
        sys.stderr.write(
            "buildId not found in home-page HTML\n")
        sys.exit(2)
    return m.group(1)


def _extract(obj: t.Any, expr: str) -> list[t.Any]:
    tokens = re.findall(
        r'[A-Za-z0-9_]+|\[\]|\[\d+\]',
        expr,
    )
    cur: list[t.Any] = [obj]
    for tok in tokens:
        nxt: list[t.Any] = []
        if tok == "[]":
            for v in cur:
                if isinstance(v, list):
                    nxt.extend(v)
        elif (tok.startswith("[")
              and tok.endswith("]")):
            i = int(tok[1:-1])
            for v in cur:
                if isinstance(v, list) and (
                    -len(v) <= i < len(v)):
                    nxt.append(v[i])
        else:
            for v in cur:
                if isinstance(v, dict) and tok in v:
                    nxt.append(v[tok])
        cur = nxt
    return cur


def _engine_for(site: str, lang: str) -> str:
    site = site.upper()
    if site not in ENGINES:
        sys.stderr.write(
            f"Unknown site/theme {site!r}; "
            f"known: {sorted(ENGINES)}\n")
        sys.exit(2)
    e = ENGINES[site]
    return (
        e.get(lang)
        or e.get("default")
        or e.get("da")
        or next(iter(e.values())))


def _sitekey(
    customer_id: str,
    engine_id: str,
    site_key: str = "SearchKey",
) -> str:
    raw = (
        f"{customer_id}:{engine_id}:{site_key}"
        .encode("utf-8"))
    return "SiteKey " + base64.b64encode(
        raw).decode("ascii")


def cmd_buildid(args: argparse.Namespace) -> None:
    print(_fetch_buildid())


def cmd_page(args: argparse.Namespace) -> None:
    build = args.build_id or _fetch_buildid()
    path = args.path.strip("/")
    locale = args.locale.lower()
    if path:
        url = (
            f"{BASE}/_next/data/"
            f"{build}/{locale}/{path}.json")
    else:
        url = (
            f"{BASE}/_next/data/"
            f"{build}/{locale}.json")
    _, raw = _request(
        url,
        headers={"Accept": "application/json"},
    )
    data = json.loads(
        raw.decode("utf-8", errors="replace"))
    if args.field:
        # Tiny dotted-path / [] extractor:
        # foo.bar[0].baz   |   foo.bar[].baz
        # (flatten lists)
        for value in _extract(data, args.field):
            _emit(value)
    else:
        _emit(data)


def cmd_search(args: argparse.Namespace) -> None:
    engine = args.engine or _engine_for(
        args.site, args.lang)
    body: dict[str, t.Any] = {
        "query": args.query,
        "page": args.page,
        "pageSize": args.size,
    }
    if args.facets:
        body["facets"] = args.facets.split(",")
    url = (
        f"{CLUDO_API}/"
        f"{CLUDO_CUSTOMER}/"
        f"{engine}/search")
    headers: dict[str, str] = {
        "Authorization": _sitekey(
            CLUDO_CUSTOMER, engine),
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    _, raw = _request(
        url,
        method="POST",
        body=json.dumps(body).encode("utf-8"),
        headers=headers,
    )
    data = json.loads(
        raw.decode("utf-8", errors="replace"))
    if args.raw:
        _emit(data)
        return
    docs = data.get("TypedDocuments", []) or []
    for d in docs:
        f = d.get("Fields", {}) or {}
        title = (
            (f.get("Title", {}) or {})
            .get("Value", ""))
        u = (
            (f.get("Url", {}) or {})
            .get("Value", ""))
        desc = (
            (f.get("Description", {}) or {})
            .get("Value", ""))
        print(f"{u}\n  {title}")
        if desc and args.verbose:
            print(f"  {desc[:200]}")
    total = (
        data.get("TotalDocument",
                 data.get("TotalDocuments")))
    print(f"# total: {total}", file=sys.stderr)


def cmd_settings(args: argparse.Namespace) -> None:
    url = (
        f"{CLUDO_API}/"
        f"{CLUDO_CUSTOMER}/"
        f"{args.engine}/websites/publicsettings")
    _, raw = _request(
        url,
        headers={"Accept": "application/json"},
    )
    _emit(json.loads(
        raw.decode("utf-8", errors="replace")))


def cmd_engines(args: argparse.Namespace) -> None:
    if args.raw:
        _emit({
            "customerId": CLUDO_CUSTOMER,
            "engines": ENGINES,
        })
        return
    print(f"customerId: {CLUDO_CUSTOMER}")
    for site, langs in ENGINES.items():
        kv = ", ".join(
            f"{k}={v}" for k, v in langs.items())
        print(f"  {site:14s} {kv}")


def cmd_sitemap(args: argparse.Namespace) -> None:
    _, raw = _request(
        f"{BASE}/sitemap.xml",
        headers={"Accept": "*/*"},
    )
    xml = raw.decode("utf-8", errors="replace")
    locs = re.findall(
        r"<loc>([^<]+)</loc>", xml)
    if args.prefix:
        locs = [
            u
            for u in locs
            if urllib.parse.urlparse(u).path.startswith(
                args.prefix)]
    if args.limit:
        locs = locs[:args.limit]
    if not locs:
        sys.stderr.write(
            "No <loc> entries matched\n")
        sys.exit(2)
    for u in locs:
        print(u)


if __name__ == "__main__":
    main()
