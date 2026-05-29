#!/usr/bin/env python3
"""Thin CLI for the anonymous queries on https://virk.dk/graphql.

Standard library only. See ./SKILL.md for the schema cribsheet.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import typing as t
import urllib.error
import urllib.request

BASE = "https://virk.dk"
GQL = BASE + "/graphql"
UA = "Mozilla/5.0 (virk-dk-api-cli)"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="cmd", required=True)

    def _add(
        name: str,
        **kwargs: t.Any,
    ) -> argparse.ArgumentParser:
        p = sub.add_parser(name, **kwargs)
        p.add_argument(
            "--raw",
            action="store_true",
            help="print raw JSON response",
        )
        return p

    p = _add(
        "query",
        help="run an arbitrary GraphQL query string",
    )
    p.add_argument("query")
    p.add_argument(
        "--variables",
        help="JSON object string",
    )
    p.set_defaults(func=cmd_query)

    p = _add(
        "raw",
        help="POST a GraphQL document read from a file",
    )
    p.add_argument("file")
    p.add_argument(
        "--variables",
        help="JSON object string",
    )
    p.set_defaults(func=cmd_raw)

    p = _add(
        "article",
        help="fetch one Artikel by slug",
    )
    p.add_argument("slug")
    p.set_defaults(func=cmd_article)

    p = _add(
        "search-articles",
        help="contains-match Artikel.overskrift",
    )
    p.add_argument("text")
    p.add_argument(
        "--limit",
        type=int,
        default=20,
    )
    p.set_defaults(func=cmd_search_articles)

    p = _add(
        "ordninger",
        help="list Ordninger",
    )
    p.add_argument(
        "--limit",
        type=int,
        default=200,
    )
    p.set_defaults(func=cmd_ordninger)

    p = _add(
        "myndigheder",
        help="list Myndigheder (agencies)",
    )
    p.add_argument(
        "--type",
        choices=["stat", "kommune", "region"],
        help="restrict to one type",
    )
    p.add_argument(
        "--limit",
        type=int,
        default=300,
    )
    p.set_defaults(func=cmd_myndigheder)

    p = _add(
        "ministerier",
        help="ministry -> agency tree (backs /nye-regler/)",
    )
    p.set_defaults(func=cmd_ministerier)

    p = _add(
        "mv-services",
        help="Mit Virk backend service status (anon)",
    )
    p.set_defaults(func=cmd_mv_services)

    p = _add(
        "ressourceset",
        help="key/value strings of an i18n bundle",
    )
    p.add_argument("slug")
    p.add_argument(
        "--locale",
        default="da",
    )
    p.set_defaults(func=cmd_ressourceset)

    p = _add(
        "redirect",
        help="resolve a vanity URL via redirectQuery",
    )
    p.add_argument("url")
    p.add_argument(
        "--realm",
        default="virk",
    )
    p.set_defaults(func=cmd_redirect)

    p = _add(
        "sitemap",
        help="URLs from /sitemap.xml",
    )
    p.add_argument(
        "--limit",
        type=int,
    )
    p.add_argument(
        "--prefix",
        help="path prefix to filter (e.g. /emner/)",
    )
    p.set_defaults(func=cmd_sitemap)

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
        "Accept": "application/json",
    }
    if headers:
        h.update(headers)
    req = urllib.request.Request(url, data=body, method=method, headers=h)
    try:
        with urllib.request.urlopen(
            req,
            timeout=30,
        ) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        body_text = e.read() if e.fp else b""
        sys.stderr.write(f"HTTP {e.code} {e.reason} on {method} {path}\n")
        if body_text:
            sys.stderr.write(
                body_text.decode("utf-8", errors="replace").rstrip() + "\n"
            )
        sys.exit(2)


def gql(
    query: str,
    variables: dict | None = None,
) -> t.Any:
    body = json.dumps(
        {
            "query": query,
            "variables": variables or {},
        }
    ).encode("utf-8")
    _, raw = _request(
        GQL,
        method="POST",
        body=body,
        headers={
            "Content-Type": "application/json",
        },
    )
    text = raw.decode("utf-8", errors="replace")
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        sys.stderr.write("Non-JSON response from /graphql:\n" + text + "\n")
        sys.exit(2)


def emit(obj: t.Any, raw: bool = False) -> None:
    print(
        json.dumps(
            obj,
            ensure_ascii=False,
            indent=2 if raw else None,
        )
    )


def _check_errors(resp: t.Any) -> t.Any:
    if isinstance(resp, dict) and resp.get("errors"):
        sys.stderr.write("GraphQL errors:\n")
        json.dump(
            resp["errors"],
            sys.stderr,
            ensure_ascii=False,
            indent=2,
        )
        sys.stderr.write("\n")
    return resp


# --- subcommands ---------------------------------------------------------


def cmd_query(args: argparse.Namespace) -> None:
    variables: dict[str, t.Any] = json.loads(args.variables) if args.variables else {}
    resp = _check_errors(gql(args.query, variables))
    emit(resp, raw=True)


def cmd_raw(args: argparse.Namespace) -> None:
    with open(args.file, "r", encoding="utf-8") as f:
        query = f.read()
    variables: dict[str, t.Any] = json.loads(args.variables) if args.variables else {}
    resp = _check_errors(gql(query, variables))
    emit(resp, raw=True)


def cmd_article(args: argparse.Namespace) -> None:
    q = """query($slug: String!) {
      artikelCollection(limit: 1, where: { slug: $slug }) {
        items {
          sys { id publishedAt }
          slug overskrift alternativTitel alternativBeskrivelse tags
          linkedFrom { ordningCollection(limit: 1) { items { slug overordnetTitel } } }
        }
      }
    }"""
    resp = _check_errors(gql(q, {"slug": args.slug}))
    if args.raw:
        emit(resp, raw=True)
        return
    items = resp.get("data", {}).get("artikelCollection", {}).get("items", [])
    if not items:
        sys.stderr.write(f"No artikel with slug={args.slug!r}\n")
        sys.exit(1)
    emit(items[0], raw=True)


def cmd_search_articles(
    args: argparse.Namespace,
) -> None:
    # Contentful supports overskrift_contains;
    # search is case-insensitive substring.
    q = """query($q: String!, $limit: Int!) {
      artikelCollection(limit: $limit, where: { overskrift_contains: $q }) {
        total
        items { sys { id } slug overskrift alternativBeskrivelse tags }
      }
    }"""
    resp = _check_errors(gql(q, {"q": args.text, "limit": args.limit}))
    if args.raw:
        emit(resp, raw=True)
        return
    coll = resp.get("data", {}).get("artikelCollection") or {}
    print(f"# {coll.get('total', 0)} hits for {args.text!r}")
    for it in coll.get("items", []) or []:
        print(f"{it['slug']}\t{it.get('overskrift') or ''}")


def cmd_ordninger(args: argparse.Namespace) -> None:
    q = """query($limit: Int!) {
      ordningCollection(limit: $limit) {
        total
        items { sys { id } slug overordnetTitel alternativTitel alternativBeskrivelse }
      }
    }"""
    resp = _check_errors(gql(q, {"limit": args.limit}))
    if args.raw:
        emit(resp, raw=True)
        return
    for it in resp.get("data", {}).get("ordningCollection", {}).get("items", []) or []:
        print(f"{it['slug']}\t{it.get('overordnetTitel') or ''}")


def cmd_myndigheder(args: argparse.Namespace) -> None:
    where: dict[str, str] = {}
    if args.type:
        where["type"] = args.type
    q = """query($limit: Int!, $where: MyndighedFilter) {
      myndighedCollection(limit: $limit, where: $where) {
        items { sys { id } forkortelse type cvr beskrivelse }
      }
    }"""
    # Contentful filter type is generated as
    # <Type>Filter; if the field name differs the
    # server will tell us. We keep it permissive.
    try:
        resp = gql(
            q,
            {"limit": args.limit, "where": where or None},
        )
    except SystemExit:
        raise
    if isinstance(resp, dict) and resp.get("errors"):
        # Fall back: filter client-side.
        resp = _check_errors(
            gql(
                """query($limit: Int!) {
              myndighedCollection(limit: $limit) {
                items { sys { id } forkortelse type cvr beskrivelse }
              }
            }""",
                {"limit": args.limit},
            )
        )
    items = resp.get("data", {}).get("myndighedCollection", {}).get("items", []) or []
    if args.type:
        items = [m for m in items if m.get("type") == args.type]
    if args.raw:
        emit(
            {
                "data": {
                    "myndighedCollection": {"items": items},
                },
            },
            raw=True,
        )
        return
    for m in items:
        print(f"{m.get('forkortelse', '')}\t{m.get('type', '')}\t{m.get('cvr', '')}")


def cmd_ministerier(args: argparse.Namespace) -> None:
    q = (
        "query { ministeriumCollection { "
        "items { navn cvr myndigheder { navn "
        "cvr } } } }"
    )
    resp = _check_errors(gql(q))
    if args.raw:
        emit(resp, raw=True)
        return
    for m in (
        resp.get("data", {}).get("ministeriumCollection", {}).get("items", []) or []
    ):
        print(f"{m.get('navn', '')}\tcvr={m.get('cvr', '')}")
        for c in m.get("myndigheder") or []:
            print(f"  - {c.get('navn', '')}\tcvr={c.get('cvr', '')}")


def cmd_mv_services(args: argparse.Namespace) -> None:
    q = """query { mvServices { navn informationsTyper metode alive active } }"""
    resp = _check_errors(gql(q))
    if args.raw:
        emit(resp, raw=True)
        return
    for s in resp.get("data", {}).get("mvServices", []) or []:
        print(
            f"{s.get('navn', '')}\t"
            f"alive={s.get('alive')}\t"
            f"active={s.get('active')}\t"
            f"metode={s.get('metode', '')}"
        )


def cmd_ressourceset(args: argparse.Namespace) -> None:
    q = """query($slug: String!, $locale: String!) {
      ressourceSetCollection(where: { slug: $slug }, locale: $locale, limit: 1) {
        items { ressourcerCollection(limit: 1000) { items { key value } } }
      }
    }"""
    resp = _check_errors(
        gql(
            q,
            {
                "slug": args.slug,
                "locale": args.locale,
            },
        )
    )
    if args.raw:
        emit(resp, raw=True)
        return
    items = (resp.get("data", {}) or {}).get("ressourceSetCollection", {}).get(
        "items", []
    ) or []
    if not items:
        sys.stderr.write(
            f"No ressourceSet with slug={args.slug!r} locale={args.locale!r}\n"
        )
        sys.exit(1)
    for kv in (items[0].get("ressourcerCollection", {}) or {}).get("items", []) or []:
        print(f"{kv['key']}\t{kv['value']}")


def cmd_redirect(args: argparse.Namespace) -> None:
    q = """query($q: String!, $realm: String!) {
      redirectQuery(query: $q, realm: $realm) { redirectUrl httpStatus }
    }"""
    resp = _check_errors(gql(q, {"q": args.url, "realm": args.realm}))
    r = (resp.get("data", {}) or {}).get("redirectQuery") or {}
    if args.raw:
        emit(resp, raw=True)
        return
    if r.get("httpStatus", -1) <= 0:
        sys.stderr.write(f"No redirect for {args.url!r} in realm {args.realm!r}\n")
        sys.exit(1)
    print(f"{r.get('httpStatus')} {r.get('redirectUrl')}")


def cmd_sitemap(args: argparse.Namespace) -> None:
    _, raw = _request(
        "/sitemap.xml",
        headers={"Accept": "*/*"},
    )
    xml = raw.decode("utf-8", errors="replace")
    locs = re.findall(r"<loc>([^<]+)</loc>", xml)
    if args.prefix:
        locs = [
            u for u in locs if (u.startswith(BASE + args.prefix) or args.prefix in u)
        ]
    if args.limit:
        locs = locs[: args.limit]
    if not locs:
        sys.stderr.write("No <loc> entries matched.\n")
        sys.exit(1)
    for u in locs:
        print(u)


if __name__ == "__main__":
    main()
