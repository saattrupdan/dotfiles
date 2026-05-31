#!/usr/bin/env python3
"""Thin CLI for the verified anonymous endpoints on https://www.sundhed.dk/api/.

Standard library only. See ./SKILL.md for endpoint specs.
"""

from __future__ import annotations

import argparse
import html
import json
import re
import sys
import typing as t
import urllib.error
import urllib.parse
import urllib.request

BASE = "https://www.sundhed.dk"
UA = "Mozilla/5.0 (sundhed-dk-api-cli)"

KNOWN_SHARDS = (
    "applikation",
    "artikel",
    "event",
    "informationtilpraksis",
    "patientforloeb",
    "laegehaandbog",
    "laegemiddelanbefaling",
    "nyhed",
    "patienthaandbog",
    "patientklagesag",
    "sundhedstilbud",
    "sundheddkhjaelp",
    "sundheddkinformation",
    "tema",
    "indloggetrum",
)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="cmd", required=True)

    def _add(name: str, **kwargs: t.Any) -> argparse.ArgumentParser:
        p = sub.add_parser(name, **kwargs)
        p.add_argument(
            "--raw",
            action="store_true",
            help=("print raw JSON response (skip the human-readable formatter)"),
        )
        return p

    _add("version").set_defaults(func=cmd_version)
    _add("login").set_defaults(func=cmd_login)

    p = _add("keepalive")
    p.add_argument(
        "action",
        choices=["timeleft", "renew"],
        default="timeleft",
        nargs="?",
    )
    p.set_defaults(func=cmd_keepalive)

    _add("settings").set_defaults(func=cmd_settings)

    p = _add("setting")
    p.add_argument("key")
    p.set_defaults(func=cmd_setting)

    p = _add("menu")
    p.add_argument(
        "--section",
        choices=["borger", "sundhedsfaglig"],
        default="borger",
    )
    p.add_argument(
        "--kind",
        choices=["top", "footer", "icon"],
        default="top",
    )
    p.set_defaults(func=cmd_menu)

    p = _add("filters")
    p.add_argument(
        "--section",
        choices=["borger", "sundhedsfaglig"],
        default="borger",
    )
    p.set_defaults(func=cmd_filters)

    _add("orgtypes").set_defaults(func=cmd_orgtypes)

    p = _add("pagetheme")
    p.add_argument(
        "--path",
        default="/borger/",
    )
    p.set_defaults(func=cmd_pagetheme)

    _add("alerts").set_defaults(func=cmd_alerts)
    _add("plugins").set_defaults(func=cmd_plugins)

    p = _add("autocomplete")
    p.add_argument("term")
    p.set_defaults(func=cmd_autocomplete)

    _add("sitemap").set_defaults(func=cmd_sitemap)

    p = _add("urls")
    p.add_argument(
        "--shard",
        required=True,
        help="sitemap shard name. Known: " + ", ".join(KNOWN_SHARDS),
    )
    p.set_defaults(func=cmd_urls)

    args = parser.parse_args()
    args.func(args)


def _request(
    path: str,
    method: str = "GET",
    body: dict | None = None,
) -> t.Any:
    url = BASE + path
    data: bytes | None = None
    headers: dict[str, str] = {
        "User-Agent": UA,
        "Accept": "application/json",
    }
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    elif method == "POST":
        # IIS rejects bodyless POSTs with 411. Force a
        # Content-Length: 0.
        data = b""
        headers["Content-Length"] = "0"
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(
            req,
            timeout=30,
        ) as r:
            raw = r.read()
    except urllib.error.HTTPError as e:
        body_text = e.read().decode("utf-8", errors="replace") if e.fp else ""
        sys.stderr.write(f"HTTP {e.code} {e.reason} on {method} {path}\n")
        if body_text:
            sys.stderr.write(body_text.rstrip() + "\n")
        sys.exit(2)
    text = raw.decode("utf-8", errors="replace")
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return text


def _check_envelope(obj: t.Any) -> None:
    """Detect the standard sundhed.dk error envelope and exit."""
    if isinstance(obj, dict) and "ResponseStatus" in obj:
        sys.stderr.write(json.dumps(obj, ensure_ascii=False, indent=2) + "\n")
        sys.exit(2)


def _emit_json(obj: t.Any) -> None:
    print(json.dumps(obj, ensure_ascii=False, indent=2))


def cmd_version(args: argparse.Namespace) -> None:
    data = _request("/api/version")
    _check_envelope(data)
    _emit_json(data)


def cmd_login(args: argparse.Namespace) -> None:
    data = _request("/api/login/isloggedin")
    _check_envelope(data)
    _emit_json(data)


def cmd_keepalive(args: argparse.Namespace) -> None:
    if args.action == "timeleft":
        _emit_json(_request("/api/keepalive/timeleft"))
    else:
        _emit_json(
            _request(
                "/api/keepalive/renew",
                method="POST",
            )
        )


def cmd_settings(args: argparse.Namespace) -> None:
    data = _request("/api/core/startupsettings")
    _check_envelope(data)
    if args.raw:
        _emit_json(data)
        return
    for entry in data.get("AppSettings", []):
        print(f"{entry.get('Key')}={entry.get('Value', '')}")


def cmd_setting(args: argparse.Namespace) -> None:
    data = _request(
        f"/api/core/appsetting/{urllib.parse.quote(args.key, safe='')}",
    )
    _check_envelope(data)
    _emit_json(data)


def cmd_menu(args: argparse.Namespace) -> None:
    qs = urllib.parse.urlencode({"section": args.section})
    if args.kind == "top":
        data = _request(f"/api/navigationtopmenu/?{qs}")
    elif args.kind == "footer":
        data = _request(f"/api/navigationfootermenu/?{qs}")
    else:
        data = _request(f"/api/navigationiconmenu/?{qs}")
    _check_envelope(data)
    if args.raw:
        _emit_json(data)
        return

    def _line(item: dict) -> str:
        url = item.get("PortalUrl", "")
        title = html.unescape(item.get("NavigationTitle", ""))
        return f"{url}\t{title}"

    if args.kind == "top":
        # dict keyed by structure ID
        items = sorted(
            data.values(),
            key=lambda v: (
                v.get("ParentStructureId", 0),
                v.get("Sortorder", 0),
            ),
        )
        for v in items:
            print(_line(v))
    elif args.kind == "footer":
        for block in data.get("FooterMenuItems", []):
            for item in block.get("SubItems", []):
                print(_line(item))
    else:  # icon
        section_key = (
            "BorgerMenuItemBlocks"
            if args.section == "borger"
            else "FagPersonMenuItemBlocks"
        )
        for block in data.get(section_key, []):
            header = block.get("HeaderMenuItem") or {}
            title = html.unescape(header.get("NavigationTitle", ""))
            print(f"# {title.upper()}\t{header.get('PortalUrl', '')}")
            for item in block.get("MenuItems", []):
                print(_line(item))


def cmd_filters(args: argparse.Namespace) -> None:
    qs = urllib.parse.urlencode({"section": args.section})
    data = _request(f"/api/search/searchadditionalfilters?{qs}")
    _check_envelope(data)
    if args.raw:
        _emit_json(data)
        return
    print("# Regions")
    for k, v in data.get("Regions", {}).items():
        print(f"{k}\t{v}")
    print("\n# Municipalities")
    for k, v in data.get("Municipalities", {}).items():
        print(f"{k}\t{v}")


def cmd_orgtypes(args: argparse.Namespace) -> None:
    data = _request("/api/searchorganizationtype/")
    _check_envelope(data)
    if args.raw:
        _emit_json(data)
        return
    for o in data.get("OrganisationTypes", []):
        print(f"{o.get('Id'):>3}  {o.get('SoegningOrganisationType')}")


def cmd_pagetheme(args: argparse.Namespace) -> None:
    qs = urllib.parse.urlencode({"path": args.path})
    data = _request(f"/api/pagetheme/?{qs}")
    _check_envelope(data)
    _emit_json(data)


def cmd_alerts(args: argparse.Namespace) -> None:
    data = _request("/api/alertbanners/")
    _check_envelope(data)
    if args.raw:
        _emit_json(data)
        return
    for a in data.get("AlertBanners", []):
        text = html.unescape(a.get("Text", "")).strip()
        print(f"{a.get('Id')}  {a.get('RootPage')}\n  {text}\n")


def cmd_plugins(args: argparse.Namespace) -> None:
    data = _request("/api/core/applicationplugin/")
    _check_envelope(data)
    if args.raw:
        _emit_json(data)
        return
    for p in data:
        print(
            f"{p.get('ApplicationId'):>4}  "
            f"{p.get('ApplicationName')}\t"
            f"{p.get('JsPath', '')}"
        )


def cmd_autocomplete(args: argparse.Namespace) -> None:
    data = _request(
        "/api/ordbog/autocomplete/",
        method="POST",
        body={"SearchTerm": args.term},
    )
    _check_envelope(data)
    if args.raw:
        _emit_json(data)
        return
    for word in data.get("AutoCompleteResult", []):
        print(word)


def cmd_sitemap(args: argparse.Namespace) -> None:
    data = _request("/api/cms/sitemap")
    _check_envelope(data)
    if args.raw:
        _emit_json(data)
        return
    for entry in data:
        print(entry.get("loc"))


def cmd_urls(args: argparse.Namespace) -> None:
    if args.shard not in KNOWN_SHARDS:
        sys.stderr.write(
            f"Unknown shard: {args.shard!r}\nKnown shards: {', '.join(KNOWN_SHARDS)}\n"
        )
        sys.exit(2)
    url = f"{BASE}/sitemap-{args.shard}.xml"
    req = urllib.request.Request(
        url,
        headers={"User-Agent": UA},
    )
    try:
        with urllib.request.urlopen(
            req,
            timeout=30,
        ) as r:
            xml = r.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        sys.stderr.write(f"HTTP {e.code} {e.reason} on {url}\n")
        sys.exit(2)
    matches = list(
        re.finditer(
            r"<loc>([^<]+)</loc>",
            xml,
        )
    )
    if not matches:
        sys.stderr.write(f"No <loc> entries found in {url}\n")
        sys.exit(2)
    for m in matches:
        print(m.group(1))


if __name__ == "__main__":
    main()
