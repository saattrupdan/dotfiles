#!/usr/bin/env python3
"""CLI for Alexandra's Confluence at confluence.alexandra.dk.

Form-login + session cookie auth. Cookies persist in
~/.alexandra-confluence/cookies.txt and are reused across invocations;
on session expiry the script silently re-authenticates and retries once.

Standard library only. See ./SKILL.md for usage.
"""
from __future__ import annotations

import argparse
import collections.abc as c
import getpass
import html
import http.cookiejar
import json
import os
import re
import sys
import typing as t
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")

BASE = "https://confluence.alexandra.dk"
UA = "Mozilla/5.0 (alexandra-confluence-cli)"
COOKIE_DIR = Path.home() / ".alexandra-confluence"
COOKIE_FILE = COOKIE_DIR / "cookies.txt"
PROJ_ANCESTOR_ID = "208044217"  # "Projektoverblik (The Alexandra Way)"


class _ConfluenceError(Exception):
    def __init__(self, code: int, message: str) -> None:
        self.code = code
        self.message = message
        super().__init__(f"HTTP {code}: {message}")


_cached_creds: tuple[str, str] | None = None


def main() -> None:
    parser = argparse.ArgumentParser(description="CLI for Alexandra's Confluence.")
    sub = parser.add_subparsers(dest="cmd", required=True)

    def _add(name: str, **kw: t.Any) -> argparse.ArgumentParser:
        p = sub.add_parser(name, **kw)
        p.add_argument("--raw", action="store_true",
                       help="print raw JSON response")
        return p

    _add("auth", help="Force re-authentication")

    p = _add("spaces", help="List all spaces")
    p.add_argument("--limit", type=int, default=100)
    p.add_argument("--start", type=int, default=0)

    p = _add("pages", help="List pages in a space")
    p.add_argument("--space-key", required=True)
    p.add_argument("--limit", type=int, default=20)

    p = _add("search", help="Search Confluence pages")
    p.add_argument("query", nargs="?", help="Title search shorthand")
    p.add_argument("--cql", help="Full CQL query (overrides query)")
    p.add_argument("--limit", type=int, default=20)

    p = _add("page", help="Get a single page by key or ID")
    p.add_argument("--key")
    p.add_argument("--id")
    p.add_argument("--body-format", choices=["auto", "text", "html"], default="auto",
                   dest="body_format", help="How to display page body")

    p = _add("create", help="Create a new page")
    p.add_argument("--space-key", required=True)
    p.add_argument("--title", required=True)
    p.add_argument("--body", required=True)
    p.add_argument("--parent", help="Parent page ID (makes this a child page)")

    p = _add("create-project",
              help="Create a project page (Alexandra Way template)")
    p.add_argument("--space-key", default="PROJ")
    p.add_argument("--title", required=True)
    p.add_argument("--client", required=True)
    p.add_argument("--owner", required=True)
    p.add_argument("--budget", default="Ikke fastsat")

    p = _add("update", help="Update an existing page")
    p.add_argument("--id", required=True)
    p.add_argument("--body", required=True)
    p.add_argument("--title", help="New title (optional)")
    p.add_argument("--minor-edit", action="store_true")

    p = _add("move", help="Move a page under another page")
    p.add_argument("--id", required=True, help="Page ID to move")
    p.add_argument("--parent", required=True, help="New parent page ID")

    p = _add("delete", help="Delete a page")
    p.add_argument("--id", required=True)

    p = _add("add-slide", help="Add a row to AI Lab Slide Decks table")
    p.add_argument("--category", required=True,
                   help="Category: about-us, themed, client, courses, presentions, nlp, energy, healthcare, iot")
    p.add_argument("--title", required=True, help="Title / Description")
    p.add_argument("--date", help="Date (YYYY-MM-DD)")
    p.add_argument("--owner-key", help="Confluence user key (e.g. from whoami)")
    p.add_argument("--language", help="Language code (DA, EN, FR, etc.)")
    p.add_argument("--slides", help="Attachment filename or link")
    p.add_argument("--note", help="Extra note (inserted as a plain row)")

    _add("whoami", help="Show current user")

    args = parser.parse_args()
    _run_cmd(_COMMANDS[args.cmd], args)


def _emit_json(obj: t.Any) -> None:
    print(json.dumps(obj, ensure_ascii=False, indent=2))


def _strip_tags(text: str) -> str:
    return re.sub(r"<[^>]+>", "", text)


def _get_credentials() -> tuple[str, str]:
    global _cached_creds
    if _cached_creds is not None:
        return _cached_creds
    user = os.environ.get("CONFLUENCE_USER") or input("Confluence username: ")
    passwd = os.environ.get("CONFLUENCE_PASS") or getpass.getpass(
        "Confluence password: ")
    _cached_creds = (user, passwd)
    return _cached_creds


def _build_jar() -> http.cookiejar.MozillaCookieJar:
    COOKIE_DIR.mkdir(parents=True, exist_ok=True)
    cj = http.cookiejar.MozillaCookieJar(str(COOKIE_FILE))
    if COOKIE_FILE.exists():
        try:
            cj.load(ignore_discard=True, ignore_expires=True)
        except (OSError, http.cookiejar.LoadError):
            pass
    return cj


def _clear_jar(opener: urllib.request.OpenerDirector) -> None:
    for h in opener.handlers:
        if isinstance(h, urllib.request.HTTPCookieProcessor):
            h.cookiejar.clear()
            return


def _authenticate(opener: urllib.request.OpenerDirector) -> None:
    """Form-login. Sets fresh session cookies on the opener's jar."""
    # Establish session (Confluence sets JSESSIONID here).
    try:
        opener.open(urllib.request.Request(
            f"{BASE}/index.action",
            headers={"User-Agent": UA},
        ), timeout=30).close()
    except urllib.error.HTTPError as e:
        sys.stderr.write(f"Failed to establish session: HTTP {e.code}\n")
        sys.exit(2)

    # Fetch CSRF token from the login page.
    try:
        with opener.open(urllib.request.Request(
                f"{BASE}/login.action",
                headers={"User-Agent": UA},
        ), timeout=30) as r:
            page = r.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        sys.stderr.write(f"HTTP {e.code} on GET /login.action\n")
        sys.exit(2)
    m = re.search(
        r'name="atlassian-token" content="([^"]+)"', page)
    if not m:
        sys.stderr.write("atlassian-token not found in login page\n")
        sys.exit(2)

    user, passwd = _get_credentials()
    data = urllib.parse.urlencode({
        "os_username": user,
        "os_password": passwd,
        "os_authType": "basic",
        "atlassian-token": m.group(1),
    }).encode("utf-8")
    req = urllib.request.Request(
        f"{BASE}/dologin.action",
        data=data,
        headers={
            "User-Agent": UA,
            "Content-Type": (
                "application/x-www-form-urlencoded"),
        },
    )
    try:
        with opener.open(req, timeout=30) as r:
            if r.status != 200:
                sys.stderr.write(
                    f"Login returned HTTP {r.status}\n")
                sys.exit(2)
    except urllib.error.HTTPError as e:
        sys.stderr.write(f"Login failed: HTTP {e.code}\n")
        sys.exit(2)


def _request(
    opener: urllib.request.OpenerDirector,
    path: str,
    method: str = "GET",
    body: dict | None = None,
) -> tuple[int, t.Any]:
    url = path if path.startswith("http") else BASE + path
    h: dict[str, str] = {
        "User-Agent": UA,
        "Accept": "application/json",
    }
    data: bytes | None = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        h["Content-Type"] = "application/json"
    elif method in ("POST", "PUT"):
        raise _ConfluenceError(0, f"{method} requires a body dict")
    req = urllib.request.Request(
        url, data=data, method=method, headers=h)
    try:
        with opener.open(req, timeout=30) as r:
            # urllib auto-follows 302; if we land on the login page our session
            # has expired. Surface this so the caller can re-authenticate.
            if ("login.action" in r.url
                    and "login.action" not in url):
                raise _ConfluenceError(
                    401,
                    "session expired (redirected to login)",
                )
            text = r.read().decode("utf-8", errors="replace")
            ctype = r.headers.get("Content-Type", "")
            if ctype.startswith("application/json"):
                try:
                    return r.status, json.loads(text)
                except json.JSONDecodeError:
                    return r.status, text
            return r.status, text
    except urllib.error.HTTPError as e:
        body_text = (e.read().decode("utf-8", errors="replace")
                      if e.fp else "")
        raise _ConfluenceError(
            e.code,
            body_text[:500].replace("\n", " "),
        )
    except urllib.error.URLError as e:
        raise _ConfluenceError(0, str(e.reason))


def _request_json(
    opener: urllib.request.OpenerDirector,
    path: str,
    method: str = "GET",
    body: dict | None = None,
) -> t.Any:
    _, result = _request(opener, path, method=method, body=body)
    if isinstance(result, dict) and "statusCode" in result:
        raise _ConfluenceError(
            result.get("statusCode", 0),
            json.dumps(result, ensure_ascii=False),
        )
    return result


def _new_page_payload(
    title: str,
    body_xml: str,
    space_key: str,
    ancestor_id: str | None = None,
) -> dict[str, t.Any]:
    payload: dict[str, t.Any] = {
        "type": "page",
        "title": title,
        "space": {"key": space_key},
        "body": {
            "storage": {
                "value": body_xml,
                "representation": "storage",
            },
        },
    }
    if ancestor_id:
        payload["ancestor"] = {"id": ancestor_id}
    return payload


def _run_cmd(
    func: c.Callable[..., None],
    args: argparse.Namespace,
) -> None:
    """Reuse persisted cookies; on session expiry re-auth and retry once."""
    cj = _build_jar()
    opener = urllib.request.build_opener(
        urllib.request.HTTPCookieProcessor(cj))
    authenticated = False
    for _ in range(2):
        try:
            func(opener, args)
            cj.save(ignore_discard=True, ignore_expires=True)
            return
        except _ConfluenceError as e:
            if e.code in (302, 401) and not authenticated:
                global _cached_creds
                _cached_creds = None
                _authenticate(opener)
                authenticated = True
                continue
            sys.stderr.write(f"HTTP {e.code}: {e.message}\n")
            sys.exit(2)


# Confluence Storage Format. 225903078/164/170 are checklist excerpt
# source pages.
_PROJECT_TEMPLATE = """\
<h1>Projekt: {title}</h1>
<ac:structured-macro ac:name="toc">
  <ac:parameter ac:name="minHeaders">2</ac:parameter>
  <ac:parameter ac:name="maxHeaders">6</ac:parameter>
  <ac:parameter ac:name="include">.*</ac:parameter>
  <ac:parameter ac:name="style">disc</ac:parameter>
</ac:structured-macro>

<h2>Projektinfo</h2>
<table class="wrapped confstyle">
<thead><tr><th>felt</th><th>værdi</th></tr></thead>
<tbody>
<tr><td>Projektnavn</td><td>{title}</td></tr>
<tr><td>Klient / kunde</td><td>{client}</td></tr>
<tr><td>Projektansvarlig</td><td>{owner}</td></tr>
<tr><td>Intern Projektejer</td><td>{owner}</td></tr>
<tr><td>Budget (Alexandra Instituttets Andel)</td><td>{budget}</td></tr>
<tr><td>Projekttype</td><td>Under udvikling</td></tr>
<tr><td>Projektslut</td><td>Ikke fastsat</td></tr>
<tr><td>Projektkode</td><td>IKKE Tildelt</td></tr>
<tr><td>Status</td><td>Under initiering</td></tr>
<tr><td>Skabelon</td><td>The Alexandra Way</td></tr>
</tbody>
</table>

<h2>Projektbeskrivelse</h2>
<p>Udfyld projektbeskrivelsen her.</p>

<h2>Tjeklister</h2>
<h3>Initiering</h3>
<ac:structured-macro ac:name="excerpt">
  <ac:parameter ac:name="restrictToPage">225903078</ac:parameter>
</ac:structured-macro>
<h3>Eksekvering</h3>
<ac:structured-macro ac:name="excerpt">
  <ac:parameter ac:name="restrictToPage">225903164</ac:parameter>
</ac:structured-macro>
<h3>Afslutning</h3>
<ac:structured-macro ac:name="excerpt">
  <ac:parameter ac:name="restrictToPage">225903170</ac:parameter>
</ac:structured-macro>

<h2>Administrative opgaver</h2>
<ul><li>Opret projekt i system</li>
<li>Fastlæg budget og resurser</li>
<li>Identificér interessenter</li>
<li>Planlæg første milestone</li></ul>

<h2>Projektledelsesopgaver</h2>
<ul><li>Lav projektplan</li>
<li>Sæt op projektstyregruppe</li>
<li>Fastlæg rapporteringsrutiner</li></ul>

<h2>Softwareudviklingsopgaver</h2>
<p>Udfyld softwareudviklingsopgaver her.</p>

<h2>Milestone oversigt</h2>
<table class="wrapped confstyle">
<thead><tr><th>Milestone</th><th>Dato</th><th>Status</th></tr></thead>
<tbody><tr><td>MVP</td><td>Ikke fastsat</td><td>Planlagt</td></tr></tbody>
</table>"""


# Commands


def cmd_spaces(opener: t.Any, args: argparse.Namespace) -> None:
    qs = urllib.parse.urlencode({
        "expand": "description.plain",
        "limit": args.limit,
        "start": args.start,
    })
    data = _request_json(opener, f"/rest/api/space?{qs}")
    if args.raw:
        return _emit_json(data)
    total = data.get("size", 0)
    start = data.get("start", 0)
    results = data.get("results", [])
    print(
        f"Total spaces: {total}  "
        f"(showing {start}-{start + len(results)})")
    for s in results:
        key = s.get("key", "?")
        name = s.get("name", "?")
        stype = s.get("type", "?")
        desc = (
            (s.get("description", {})
             .get("plain", {})
             .get("value", "") or "")[:80])
        prefix = "  " if key.startswith("~") else ""
        print(f"{prefix}{key}: {name} [{stype}]")
        if desc:
            print(f"   {desc}")


def cmd_pages(opener: t.Any, args: argparse.Namespace) -> None:
    qs = urllib.parse.urlencode({
        "spaceKey": args.space_key,
        "limit": args.limit,
        "expand": "version,ancestors,children.page",
        "depth": "1",
    })
    data = _request_json(opener, f"/rest/api/content?{qs}")
    if args.raw:
        return _emit_json(data)
    print(
        f"Total pages in {args.space_key}: "
        f"{data.get('size', 0)}")
    for p in data.get("results", []):
        ancestors = p.get("ancestors", [])
        ancestor = ""
        if ancestors:
            ancestor = (
                f" (child of: "
                f"{ancestors[-1].get('title', '?')})")
        children_list = (
            p.get("children", {})
            .get("page", {})
            .get("results", []))
        nchildren = len(children_list)
        children = (
            f" (+{nchildren} children)"
            if nchildren else "")
        v = p.get("version", {}).get("number", "?")
        print(
            f"  [{p.get('id', '?')}] "
            f"{p.get('title', '?')} v{v}"
            f"{ancestor}{children}")


def cmd_search(opener: t.Any, args: argparse.Namespace) -> None:
    if args.cql:
        cql = args.cql
    elif args.query:
        cql = ('title~"'
               + args.query.replace('"', '\\"') + '"')
    else:
        sys.stderr.write(
            "Provide a query or --cql argument\n")
        sys.exit(2)
    qs = urllib.parse.urlencode(
        {"cql": cql, "limit": args.limit})
    data = _request_json(
        opener, f"/rest/api/search?{qs}")
    if args.raw:
        return _emit_json(data)
    print(f"Search results: "
          f"{data.get('totalSize', 0)} total")
    for r in data.get("results", []):
        content = r.get("content") or {}
        space_key = (
            (content.get("space") or {})
            .get("key") or "?")
        pid = content.get("id") or "?"
        if pid == "?" and "pageId=" in r.get("url", ""):
            pid = r["url"].split("pageId=")[1].split("&")[0]
        lastmod = (
            (r.get("lastModified") or "?")[:10])
        body_val = (
            r.get("body", {})
            .get("view", {})
            .get("value", ""))
        body_clean = _strip_tags(
            re.sub(r"@@@hl@@@|@@@endhl@@@", "", body_val)
        )[:200]
        print(
            f"  [{space_key}] "
            f"{r.get('title', '?')} "
            f"(id={pid}, modified={lastmod})")
        if body_clean:
            print(f"    {body_clean}")


def cmd_page(opener: t.Any, args: argparse.Namespace) -> None:
    expand = (
        "body.storage,version,space,"
        "ancestors,children.page")
    if args.key:
        qs = urllib.parse.urlencode(
            {"key": args.key, "expand": expand})
        data = _request_json(
            opener, f"/rest/api/content?{qs}")
    elif args.id:
        qs = urllib.parse.urlencode({"expand": expand})
        data = _request_json(
            opener, f"/rest/api/content/{args.id}?{qs}")
    else:
        sys.stderr.write("Provide --key or --id\n")
        sys.exit(2)
    if args.raw:
        return _emit_json(data)

    print(f"Title:   {data.get('title')}")
    print(f"Space:   {data.get('space', {}).get('key')}")
    print(f"ID:      {data.get('id')}")
    print(
        f"Version: "
        f"{data.get('version', {}).get('number')}")
    for a in data.get("ancestors", []):
        print(
            f"  ancestor: "
            f"{a.get('title')} "
            f"(id={a.get('id')})")
    for c in (
            data.get("children", {})
            .get("page", {})
            .get("results", [])):
        print(
            f"  child:    "
            f"{c.get('title')} "
            f"(id={c.get('id')})")

    val = (
        data.get("body", {})
        .get("storage", {})
        .get("value", ""))
    if args.body_format == "html":
        print("\n--- Body (HTML) ---\n" + val)
    elif args.body_format == "text":
        print(
            "\n--- Body (plain text) ---\n"
            + _strip_tags(val))
    else:
        clean = _strip_tags(val)
        print(f"\nBody: {len(clean)} chars")
        print(clean[:1000])
        if len(clean) > 1000:
            print(
                f"... ({len(clean) - 1000} more chars)")


def cmd_create(opener: t.Any, args: argparse.Namespace) -> None:
    # Determine ancestor: if --parent given use it, otherwise check
    # if the space has a homepage we should nest under.
    ancestor_id = getattr(args, "parent", None)

    payload: dict[str, t.Any] = {
        "type": "page",
        "title": args.title,
        "space": {"key": args.space_key},
        "body": {
            "storage": {
                "value": args.body,
                "representation": "storage",
            },
        },
    }
    if ancestor_id:
        payload["ancestor"] = {"id": ancestor_id}

    data = _request_json(
        opener,
        "/rest/api/content",
        method="POST",
        body=payload,
    )
    if args.raw:
        return _emit_json(data)
    print(f"Created page: {data.get('title')}")
    print(f"  ID:  {data.get('id')}")
    print(
        f"  URL: "
        f"{BASE}/pages/viewpage.action"
        f"?pageId={data.get('id')}")


def cmd_create_project(
    opener: t.Any, args: argparse.Namespace,
) -> None:
    body = _PROJECT_TEMPLATE.format(
        title=html.escape(args.title),
        client=html.escape(args.client),
        owner=html.escape(args.owner),
        budget=html.escape(args.budget),
    )
    payload: dict[str, t.Any] = {
        "type": "page",
        "title": args.title,
        "space": {"key": args.space_key},
        "body": {
            "storage": {
                "value": body,
                "representation": "storage",
            },
        },
        "ancestor": {"id": PROJ_ANCESTOR_ID},
    }
    data = _request_json(
        opener,
        "/rest/api/content",
        method="POST",
        body=payload,
    )
    if args.raw:
        return _emit_json(data)
    print(f"Created project page: "
          f"{data.get('title')}")
    print(f"  ID:       {data.get('id')}")
    print(
        f"  URL:      "
        f"{BASE}/pages/viewpage.action"
        f"?pageId={data.get('id')}")
    print(
        "  Template: "
        "The Alexandra Way (projektforklæde)")


def cmd_update(opener: t.Any, args: argparse.Namespace) -> None:
    page = _request_json(
        opener,
        f"/rest/api/content/"
        f"{args.id}?expand=version")
    version_number = (
        page.get("version", {})
        .get("number", 1))
    payload: dict[str, t.Any] = {
        "id": args.id,
        "type": "page",
        "title": (
            args.title or page.get("title", "")),
        "version": {"number": version_number + 1},
        "body": {
            "storage": {
                "value": args.body,
                "representation": "storage",
            },
        },
    }
    if args.minor_edit:
        payload["minorEdit"] = True
    data = _request_json(
        opener,
        f"/rest/api/content/{args.id}",
        method="PUT",
        body=payload,
    )
    if args.raw:
        return _emit_json(data)
    print(f"Updated page: {data.get('title')}")
    print(
        f"  New version: "
        f"{data.get('version', {})
         .get('number')}")


def cmd_move(opener: t.Any, args: argparse.Namespace) -> None:
    """Move a page under a new parent by updating its ancestors."""
    # Fetch current page to get its full ancestor chain
    page = _request_json(
        opener,
        f"/rest/api/content/"
        f"{args.id}?expand=ancestors")

    title = page.get("title", "?")
    space = (
        page.get("space", {})
        .get("key", "?"))

    # Build new ancestor list: all ancestors of the NEW parent,
    # minus the last one (the parent itself becomes the direct parent).
    new_parent = _request_json(
        opener,
        f"/rest/api/content/{args.parent}?expand=ancestors")
    new_ancestors = new_parent.get("ancestors", [])

    # Fetch current body to preserve it
    full_page = _request_json(
        opener,
        f"/rest/api/content/{args.id}"
        "?expand=body.storage")
    body_value = (
        full_page.get("body", {})
        .get("storage", {})
        .get("value", ""))
    version_number = (
        page.get("version", {})
        .get("number", 1))

    payload: dict[str, t.Any] = {
        "id": args.id,
        "type": "page",
        "title": page.get("title", ""),
        "version": {"number": version_number + 1},
        "body": {
            "storage": {
                "value": body_value,
                "representation": "storage",
            },
        },
        "ancestors": [
            {"id": a["id"]} for a in new_ancestors
        ],
    }

    data = _request_json(
        opener,
        f"/rest/api/content/{args.id}",
        method="PUT",
        body=payload,
    )
    if args.raw:
        return _emit_json(data)
    print(f"Moved page: {title}")
    print(f"  From: {space} (id={args.id})")
    print(f"  Under: {new_parent.get('title')} (id={args.parent})")


# Category definitions for AI Lab Slide Decks
_SLIDE_DECKS_PAGE_ID = "97042311"

_SLIDE_CATEGORIES = {
    # Maps CLI category names to (heading text, date cell type) tuples
    "about-us": ("About Us presentations", "date"),
    "themed": ("Themed presentation", "date"),
    "client": ("Client Presentations", "date"),
    "courses": ("Courses / workshops", "date"),
    "presentions": ("Presentions (\"oplæg\")", "date"),
    "nlp": ("NLP", "date"),
    "energy": ("Energy, Utilities & Construction", "date"),
    "healthcare": ("Healthcare", "date"),
    "iot": ("IoT / Anomaly detections", "date"),
}


def _build_slide_row(
    date: str | None,
    owner_key: str | None,
    title: str,
    language: str | None,
    slides: str | None,
) -> str:
    """Build a single <tr> row for the slide table."""
    # Date cell
    if date:
        date_cell = (
            '<td data-mce-resize="false">'
            '<div class="content-wrapper">'
            '<p><time datetime="' + date + '" />&nbsp;</p>'
            '</div></td>')
    else:
        date_cell = (
            '<td data-mce-resize="false"><br /></td>')

    # Owner cell
    if owner_key:
        owner_cell = (
            '<td><div class="content-wrapper">'
            '<p><ac:link><ri:user ri:userkey="' + owner_key + '" /></ac:link>&nbsp;</p>'
            '</div></td>')
    else:
        owner_cell = '<td></td>'

    # Title cell
    title_cell = '<td>' + html.escape(title) + '</td>'

    # Language cell
    if language:
        lang_cell = '<td>' + html.escape(language) + '</td>'
    else:
        lang_cell = '<td></td>'

    # Slides cell
    if slides:
        slides_cell = (
            '<td><div class="content-wrapper">'
            '<p><ac:link><ri:attachment ri:filename="' + html.escape(slides) + '" /></ac:link></p>'
            '</div></td>')
    else:
        slides_cell = '<td></td>'

    return (
        '<tr>' + date_cell + owner_cell + title_cell + lang_cell + slides_cell + '</tr>'
    )


def _build_note_row(note: str) -> str:
    """Build a plain text row (no table columns, just a note)."""
    return (
        '<tr><td colspan="5">' + html.escape(note) + '</td></tr>'
    )


def cmd_add_slide(opener: t.Any, args: argparse.Namespace) -> None:
    """Add a row to the AI Lab Slide Decks table."""
    page_id = _SLIDE_DECKS_PAGE_ID
    category = args.category.lower()

    if category not in _SLIDE_CATEGORIES:
        sys.stderr.write(
            f"Unknown category '{category}'. "
            f"Valid: {', '.join(sorted(_SLIDE_CATEGORIES.keys()))}\n")
        sys.exit(2)

    heading_text, date_cell_type = _SLIDE_CATEGORIES[category]

    # Fetch current page body
    page = _request_json(
        opener,
        f"/rest/api/content/{page_id}?expand=body.storage")

    version_number = (
        page.get("version", {})
        .get("number", 1))

    body = page["body"]["storage"]["value"]

    # Find the table-filter macro for this category.
    # Strategy: find the heading <h1>, then find the next <table> after it.
    # We insert the new row before the last <tr> of that table's <tbody>,
    # which is typically a spacer/empty row.

    # Find the heading for this category
    heading_pattern = re.escape(heading_text)
    heading_match = re.search(
        r'<h1[^>]*>' + heading_pattern + r'</h1>', body)
    if not heading_match:
        sys.stderr.write(
            f"Could not find heading '{heading_text}' in page\n")
        sys.exit(2)

    # Find the next table after this heading
    after_heading = body[heading_match.end():]
    table_start = after_heading.find('<table')
    if table_start < 0:
        sys.stderr.write(
            f"No table found after heading '{heading_text}'\n")
        sys.exit(2)

    # Find the matching </table>
    table_open = after_heading[:table_start] + "<table"
    # Count <table and </table> tags to find the matching close
    depth = 0
    pos = table_start
    for i in range(table_start, len(after_heading)):
        if after_heading[i:i+6] == '<table':
            depth += 1
        elif after_heading[i:i+8] == '</table>':
            depth -= 1
            if depth == 0:
                table_end = i + 8
                break

    full_table = after_heading[table_start:table_end]

    # Find the first <tbody>...</tbody> in the table
    tbody_start = full_table.find('<tbody')
    if tbody_start < 0:
        sys.stderr.write(
            f"No <tbody> found in table for '{heading_text}'\n")
        sys.exit(2)

    # Find matching </tbody> — count nesting depth
    depth = 0
    tbody_end = -1
    i = tbody_start
    while i < len(full_table):
        if full_table[i:i+6] == '<tbody':
            depth += 1
        elif full_table[i:i+8] == '</tbody>':
            depth -= 1
            if depth == 0:
                tbody_end = i
                break
        i += 1

    if tbody_end < 0:
        sys.stderr.write(
            f"No matching </tbody> found for '{heading_text}'\n")
        sys.exit(2)

    tbody = full_table[tbody_start:tbody_end]
    tbody_open_tag_len = full_table.find('>', tbody_start) + 1 - tbody_start
    tbody_close_tag_len = 8  # len('</tbody>')
    tbody_inner = tbody[tbody_open_tag_len:-tbody_close_tag_len]

    # Build the new row
    row = _build_slide_row(
        args.date, args.owner_key, args.title,
        args.language, args.slides)

    # Find the last </table> within full_table
    table_close_abs = full_table.find('</table>')
    if table_close_abs < 0:
        sys.stderr.write(
            f"No </table> found for '{heading_text}'\n")
        sys.exit(2)

    # Insert the new row right before </table>
    # This places it after all existing rows (including the incomplete last one).
    new_full_table = (
        full_table[:table_close_abs]
        + row
        + full_table[table_close_abs:])
    # Replace the old table in the body
    new_body = (
        body[:heading_match.end() + table_start]
        + new_full_table
        + body[heading_match.end() + table_end:])

    # Handle extra note rows
    if args.note:
        note_row = _build_note_row(args.note)
        # Find tbody in new_full_table
        nt_start = new_full_table.find('<tbody')
        if nt_start >= 0:
            depth2 = 0
            nt_end = -1
            j = nt_start
            while j < len(new_full_table):
                if new_full_table[j:j+6] == '<tbody':
                    depth2 += 1
                elif new_full_table[j:j+8] == '</tbody>':
                    depth2 -= 1
                    if depth2 == 0:
                        nt_end = j
                        break
                j += 1
            if nt_end >= 0:
                nt = new_full_table[nt_start:nt_end]
                nt_open_len = new_full_table.find('>', nt_start) + 1 - nt_start
                nt_inner = nt[nt_open_len:-8]
                last_nt_tr = nt_inner.rfind('</tr>')
                if last_nt_tr >= 0:
                    nt_new_inner = (
                        nt_inner[:last_nt_tr]
                        + note_row
                        + nt_inner[last_nt_tr:])
                    nt_new = (
                        nt[:nt_open_len]
                        + nt_new_inner
                        + nt[nt_end:])
                    new_full_table = (
                        new_full_table[:nt_start]
                        + nt_new
                        + new_full_table[nt_end:])
                    new_body = (
                        body[:heading_match.end() + table_start]
                        + new_full_table
                        + body[heading_match.end() + table_end:])
                nt_inner = nt[nt_open_len:-8]
                last_nt_tr = nt_inner.rfind('</tr>')
                if last_nt_tr >= 0:
                    nt_new_inner = (
                        nt_inner[:last_nt_tr]
                        + note_row
                        + nt_inner[last_nt_tr:])
                    nt_new = (
                        nt[:nt_open_len]
                        + nt_new_inner
                        + nt[nt_end:])
                    new_full_table = (
                        new_full_table[:nt_start]
                        + nt_new
                        + new_full_table[nt_end:])
                    new_body = (
                        body[:heading_match.end() + table_start]
                        + new_full_table
                        + body[heading_match.end() + table_end:])

    # Update the page with retry for version conflicts
    max_retries = 3
    for attempt in range(max_retries):
        # Re-fetch current version to avoid conflicts
        current_page = _request_json(
            opener,
            f"/rest/api/content/{page_id}?expand=body.storage,version")
        version_number = (
            current_page.get("version", {})
            .get("number", 1))

        payload: dict[str, t.Any] = {
            "id": page_id,
            "type": "page",
            "title": current_page.get("title", ""),
            "version": {"number": version_number + 1},
            "body": {
                "storage": {
                    "value": new_body,
                    "representation": "storage",
                },
            },
        }

        try:
            data = _request_json(
                opener,
                f"/rest/api/content/{page_id}",
                method="PUT",
                body=payload,
            )
            break
        except _ConfluenceError as e:
            if e.code == 409 and attempt < max_retries - 1:
                # Version conflict — retry with fresh version
                continue
            raise
    if args.raw:
        return _emit_json(data)
    print(f"Added slide to: {heading_text}")
    print(f"  Title: {args.title}")
    if args.date:
        print(f"  Date: {args.date}")
    if args.owner_key:
        print(f"  Language: {args.language or '(none)'}")
    if args.slides:
        print(f"  Slides: {args.slides}")
    if args.note:
        print(f"  Note: {args.note}")
    print(f"  Page version: {data.get('version', {}).get('number')}")


def cmd_delete(opener: t.Any, args: argparse.Namespace) -> None:
    page = _request_json(
        opener,
        f"/rest/api/content/"
        f"{args.id}?expand=space")
    title = page.get("title", "?")
    space = (
        page.get("space", {})
        .get("key", "?"))
    _request(
        opener,
        f"/rest/api/content/{args.id}",
        method="DELETE")
    print(
        f"Deleted page: "
        f"{title} "
        f"(id={args.id}, space={space})")


def cmd_whoami(opener: t.Any, args: argparse.Namespace) -> None:
    data = _request_json(
        opener,
        "/rest/api/user/current"
        "?expand=fullName,displayName,userkey")
    if args.raw:
        return _emit_json(data)
    print(f"Username:  {data.get('username')}")
    print(f"Display:   {data.get('displayName')}")
    print(f"User key:  {data.get('userKey')}")
    print(f"Full name: "
          f"{data.get('fullName', '-')}")


def cmd_auth(opener: t.Any, args: argparse.Namespace) -> None:
    """Force re-auth: clear creds + cookies, then login."""
    global _cached_creds
    _cached_creds = None
    if COOKIE_FILE.exists():
        COOKIE_FILE.unlink()
    _clear_jar(opener)
    _authenticate(opener)
    print("Authenticated successfully. Cookies saved.")


_COMMANDS = {
    "auth": cmd_auth,
    "spaces": cmd_spaces,
    "pages": cmd_pages,
    "search": cmd_search,
    "page": cmd_page,
    "create": cmd_create,
    "create-project": cmd_create_project,
    "update": cmd_update,
    "move": cmd_move,
    "add-slide": cmd_add_slide,
    "delete": cmd_delete,
    "whoami": cmd_whoami,
}


if __name__ == "__main__":
    main()
