#!/usr/bin/env python3
"""Thin CLI for the CVR distribution API at http://distribution.virk.dk.

Standard library only. Reads credentials from env vars DATACVR_USER /
DATACVR_PASS (free creds via cvrselvbetjening@erst.dk). See ./SKILL.md
for the full schema cribsheet.
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import sys
import typing as t
import urllib.error
import urllib.request

BASE = "http://distribution.virk.dk"
UA = "datacvr-api-cli"


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
            help="print full JSON response "
            "(skip the formatter)",
        )
        return p

    p = _add(
        "virksomhed",
        help="company by CVR number "
        "(Vrvirksomhed.cvrNummer)",
    )
    p.add_argument(
        "cvr",
        help="8-digit CVR number",
    )
    p.add_argument(
        "--field",
        help=(
            "dot-path under virksomhedMetadata (or "
            "Vrvirksomhed) to extract, e.g. "
            "'nyesteNavn.navn'"),
    )
    p.set_defaults(func=cmd_virksomhed)

    p = _add(
        "p-enhed",
        help="production unit by P-number",
    )
    p.add_argument(
        "pnr",
        help="P-number (10 digits)",
    )
    p.set_defaults(func=cmd_p_enhed)

    p = _add(
        "deltager",
        help="participant by enhedsNummer",
    )
    p.add_argument("enheds")
    p.set_defaults(func=cmd_deltager)

    p = _add(
        "search",
        help="company name search (match on "
        "nyesteNavn.navn)",
    )
    p.add_argument("name")
    p.add_argument(
        "--limit",
        type=int,
        default=10,
    )
    p.set_defaults(func=cmd_search)

    p = _add(
        "raw",
        help="POST a raw ES query body to "
        "<index>/<type>/_search",
    )
    p.add_argument(
        "index",
        help="cvr-permanent, "
        "registreringstekster, ...",
    )
    p.add_argument(
        "type",
        help="virksomhed, "
        "produktionsenhed, deltager, "
        "registreringstekst, ...",
    )
    p.add_argument(
        "body_file",
        help="path to JSON file with the "
        "query body",
    )
    p.set_defaults(func=cmd_raw)

    p = _add(
        "count",
        help="document count for an index/type "
        "via match_all",
    )
    p.add_argument("index")
    p.add_argument("type")
    p.set_defaults(func=cmd_count)

    args = parser.parse_args()
    args.func(args)


def _auth_header() -> dict[str, str]:
    user = os.environ.get("DATACVR_USER")
    pw = os.environ.get("DATACVR_PASS")
    if not user or not pw:
        sys.stderr.write(
            "Set DATACVR_USER and DATACVR_PASS "
            "(request free credentials at "
            "cvrselvbetjening@erst.dk).\n")
        sys.exit(2)
    token = base64.b64encode(
        f"{user}:{pw}".encode("utf-8")).decode("ascii")
    return {"Authorization": f"Basic {token}"}


def _post(path: str, body: dict) -> t.Any:
    url = BASE + path
    data = json.dumps(body).encode("utf-8")
    headers: dict[str, str] = {
        "User-Agent": UA,
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    headers.update(_auth_header())
    req = urllib.request.Request(
        url, data=data, method="POST", headers=headers)
    try:
        with urllib.request.urlopen(
            req, timeout=60,
        ) as r:
            return json.loads(
                r.read().decode("utf-8", errors="replace"))
    except urllib.error.HTTPError as e:
        sys.stderr.write(
            f"HTTP {e.code} {e.reason} on "
            f"POST {path}\n")
        sys.stderr.write(
            (e.read() or b"").decode(
                "utf-8", errors="replace") + "\n")
        sys.exit(2)


def _emit(obj: t.Any) -> None:
    print(
        json.dumps(obj, ensure_ascii=False, indent=2))


def _dot_get(obj: t.Any, path: str) -> t.Any:
    cur = obj
    for part in path.split("."):
        if isinstance(cur, list):
            try:
                cur = cur[int(part)]
                continue
            except (ValueError, IndexError):
                return None
        if not isinstance(cur, dict):
            return None
        cur = cur.get(part)
        if cur is None:
            return None
    return cur


def _first_source(
    resp: dict,
) -> dict | None:
    hits = (
        (resp.get("hits") or {}).get("hits") or [])
    if not hits:
        return None
    return hits[0].get("_source")


# --- subcommands ---------------------------------------------------------

def cmd_virksomhed(
    args: argparse.Namespace,
) -> None:
    body = {
        "query": {
            "term": {
                "Vrvirksomhed.cvrNummer": int(
                    args.cvr)},
        },
        "size": 1,
    }
    resp = _post(
        "/cvr-permanent/virksomhed/_search",
        body,
    )
    src = _first_source(resp)
    if src is None:
        sys.stderr.write(
            f"No company with CVR={args.cvr}\n")
        sys.exit(1)
    if args.field:
        v = _dot_get(
            src.get("Vrvirksomhed", {})
            .get("virksomhedMetadata", {}),
            args.field,
        )
        if v is None:
            v = _dot_get(
                src.get("Vrvirksomhed", {}),
                args.field,
            )
        _emit(
            v if v is not None else None)
        return
    _emit(src)


def cmd_p_enhed(args: argparse.Namespace) -> None:
    body = {
        "query": {
            "term": {
                "VrproduktionsEnhed.pNummer": int(
                    args.pnr)},
        },
        "size": 1,
    }
    resp = _post(
        "/cvr-permanent/produktionsenhed/_search",
        body,
    )
    src = _first_source(resp)
    if src is None:
        sys.stderr.write(
            f"No P-unit with pNummer={args.pnr}\n")
        sys.exit(1)
    _emit(src)


def cmd_deltager(args: argparse.Namespace) -> None:
    # `deltager` is searched by enhedsNummer.
    body = {
        "query": {
            "term": {
                "Vrdeltagerperson.enhedsNummer": int(
                    args.enheds)},
        },
        "size": 1,
    }
    resp = _post(
        "/cvr-permanent/deltager/_search",
        body,
    )
    src = _first_source(resp)
    if src is None:
        sys.stderr.write(
            f"No participant with "
            f"enhedsNummer={args.enheds}\n")
        sys.exit(1)
    _emit(src)


def cmd_search(args: argparse.Namespace) -> None:
    body = {
        "query": {
            "match": {
                "Vrvirksomhed.virksomhedMetadata"
                ".nyesteNavn.navn": args.name},
        },
        "size": args.limit,
        "_source": [
            "Vrvirksomhed.cvrNummer",
            "Vrvirksomhed.virksomhedMetadata"
            ".nyesteNavn",
            "Vrvirksomhed.virksomhedMetadata"
            ".nyesteBeliggenhedsadresse",
            "Vrvirksomhed.virksomhedMetadata"
            ".nyesteVirksomhedsform",
        ],
    }
    resp = _post(
        "/cvr-permanent/virksomhed/_search",
        body,
    )
    if args.raw:
        _emit(resp)
        return
    hits = (
        (resp.get("hits") or {}).get("hits") or [])
    total = (
        (resp.get("hits") or {}).get("total"))
    if isinstance(total, dict):
        total = total.get("value")
    print(
        f"# {total} hits for {args.name!r}")
    for h in hits:
        src = h.get("_source", {}).get(
            "Vrvirksomhed", {})
        meta = (
            src.get("virksomhedMetadata", {})
            or {})
        navn = (
            (meta.get("nyesteNavn") or {})
            .get("navn", ""))
        cvr = src.get("cvrNummer", "")
        adr = (
            meta.get(
                "nyesteBeliggenhedsadresse") or {})
        addr = (
            f"{adr.get('vejnavn','')} "
            f"{adr.get('husnummerFra','')}, "
            f"{adr.get('postnummer','')} "
            f"{adr.get('postdistrikt','')}"
        ).strip(", ")
        form = (
            (meta.get(
                "nyesteVirksomhedsform") or {})
            .get("kortBeskrivelse", ""))
        print(
            f"{cvr}\t{form}\t{navn}\t{addr}")


def cmd_raw(args: argparse.Namespace) -> None:
    with open(args.body_file, "r", encoding="utf-8") as f:
        body = json.load(f)
    path = f"/{args.index}/{args.type}/_search"
    resp = _post(path, body)
    _emit(resp)


def cmd_count(args: argparse.Namespace) -> None:
    body = {
        "query": {"match_all": {}},
        "size": 0,
        "track_total_hits": True,
    }
    resp = _post(
        f"/{args.index}/{args.type}/_search",
        body,
    )
    total = (
        (resp.get("hits") or {}).get("total"))
    if isinstance(total, dict):
        total = total.get("value")
    print(
        total if total is not None else "?")


if __name__ == "__main__":
    main()
