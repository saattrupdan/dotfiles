#!/usr/bin/env python3
"""CLI for Alexandra's Confluence instance at confluence.alexandra.dk.

Handles authentication, cookie management, and wraps the Confluence REST API.
Credentials are read from ``CONFLUENCE_USER`` / ``CONFLUENCE_PASS`` env vars.

Standard library only. See ./SKILL.md for usage.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import http.cookiejar
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import TYPE_CHECKING, Any, Callable

if TYPE_CHECKING:
    from argparse import Namespace

sys.stdout.reconfigure(encoding="utf-8")

BASE = "https://confluence.alexandra.dk"
UA = "Mozilla/5.0 (alexandra-confluence-cli)"
COOKIE_DIR = Path.home() / ".alexandra-confluence"
COOKIE_FILE = COOKIE_DIR / "cookies.txt"


class _ConfluenceError(Exception):
    """Raised by API helpers on HTTP errors.

    Attributes:
        code: HTTP status code (0 for non-HTTP errors).
        message: Human-readable error message.
    """

    code: int
    message: str

    def __init__(self, code: int, message: str) -> None:
        self.code = code
        self.message = message
        super().__init__(f"HTTP {code}: {message}")


# Cached credentials to avoid repeated env-var lookups in the same process run.
_cached_creds: tuple[str, str] | None = None


def _ensure_cookie_dir() -> None:
    """Create the cookie directory if it does not already exist."""
    COOKIE_DIR.mkdir(parents=True, exist_ok=True)


def _get_credentials() -> tuple[str, str]:
    """Return cached credentials or read them from environment variables.

    The first successful call caches the result so subsequent calls return
    the same tuple without re-reading the environment.

    Returns:
        A ``(username, password)`` tuple from the cache or environment.

    Raises:
        SystemExit: If ``CONFLUENCE_USER`` and ``CONFLUENCE_PASS`` are not set
            in the environment.
    """
    global _cached_creds
    if _cached_creds is not None:
        return _cached_creds

    user = os.environ.get("CONFLUENCE_USER")
    passwd = os.environ.get("CONFLUENCE_PASS")
    if not user or not passwd:
        sys.stderr.write(
            "Error: CONFLUENCE_USER and CONFLUENCE_PASS environment variables "
            "must be set.\n"
        )
        sys.exit(2)
    _cached_creds = (user, passwd)
    return _cached_creds


def _url_encode_password(password: str) -> str:
    """URL-encode special characters in a password for the login POST body.

    Confluence's login form expects certain characters to be percent-encoded
    manually rather than relying on ``urllib.parse.quote``.

    Args:
        password: The raw user password.

    Returns:
        The password with ``&``, ``@``, ``/``, and ``#`` percent-encoded.
    """
    password = password.replace("&", "%26")
    password = password.replace("@", "%40")
    password = password.replace("/", "%2F")
    password = password.replace("#", "%23")
    return password


def _get_atlassian_token(opener: urllib.request.OpenerDirector) -> str:
    """Fetch the ``atlassian-token`` from the login page for CSRF protection.

    Args:
        opener: An ``OpenerDirector`` capable of opening the login page.

    Returns:
        The CSRF token string extracted from the login page HTML.

    Raises:
        SystemExit: If the login page cannot be fetched or the token is not
            found in the response.
    """
    url = f"{BASE}/login.action"
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    try:
        with opener.open(req, timeout=30) as r:
            html_content = r.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace") if e.fp else ""
        sys.stderr.write(f"HTTP {e.code} {e.reason} on GET {url}\n")
        sys.stderr.write(body[:200].replace("\n", " ") + "\n")
        sys.exit(2)
    m = re.search(r'name="atlassian-token" content="([^"]+)"', html_content)
    if not m:
        sys.stderr.write("atlassian-token not found in login page\n")
        sys.exit(2)
    return m.group(1)


def _authenticate(cj: http.cookiejar.CookieJar) -> None:
    """Establish a Confluence session and persist cookies to disk.

    Performs a two-step authentication: first visits the index page to
    establish a session, then submits the login form with the cached
    credentials.

    Args:
        cj: A ``CookieJar`` that will receive the session cookies.
    """
    # Discard any stale cookies from a previous session.
    if COOKIE_FILE.exists():
        try:
            COOKIE_FILE.unlink()
        except OSError:
            pass

    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))

    # Step 1: Establish session by visiting the index page.
    url = f"{BASE}/index.action"
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    try:
        with opener.open(req, timeout=30) as r:
            pass
    except urllib.error.HTTPError as e:
        sys.stderr.write(f"Failed to establish session: HTTP {e.code}\n")
        sys.exit(2)

    # Step 2: Retrieve CSRF token and submit login form.
    token = _get_atlassian_token(opener)
    user, passwd = _get_credentials()
    encoded_pass = _url_encode_password(passwd)

    login_url = f"{BASE}/dologin.action"
    post_data = (
        f"os_username={urllib.parse.quote(user, safe='')}"
        f"&os_password={encoded_pass}"
        f"&os_authType=basic"
        f"&atlassian-token={token}"
    )
    data = post_data.encode("utf-8")
    req = urllib.request.Request(
        login_url,
        data=data,
        headers={
            "User-Agent": UA,
            "Content-Type": "application/x-www-form-urlencoded",
        },
    )
    try:
        with opener.open(req, timeout=30) as r:
            code = r.status
    except urllib.error.HTTPError as e:
        sys.stderr.write(f"Login failed: HTTP {e.code}\n")
        sys.exit(2)

    if code != 200:
        sys.stderr.write(f"Login returned HTTP {code}\n")
        sys.exit(2)

    _save_cookies(cj)


def _save_cookies(cj: http.cookiejar.CookieJar) -> None:
    """Persist the cookie jar to disk in Netscape format.

    Uses the built-in ``CookieJar.save()`` method when available; falls back
    to manual serialization otherwise.

    Args:
        cj: The cookie jar to save.
    """
    if hasattr(cj, "filename") and cj.filename:
        cj.save(ignore_discard=True, ignore_expires=True)
    else:
        lines: list[str] = []
        for cookie in cj:
            domain = getattr(cookie, "domain", "")
            secure = "TRUE" if cookie.secure else "FALSE"
            path = getattr(cookie, "path", "/")
            lines.append(
                f"{domain}\tTRUE\t{str(path).startswith('/')}\t"
                f"{cookie.expires or 0}\t{cookie.name}\t{cookie.value}"
            )
        with open(COOKIE_FILE, "w") as f:
            f.write("\n".join(lines) + "\n")


def _make_opener(cj: http.cookiejar.CookieJar) -> urllib.request.OpenerDirector:
    """Build an ``OpenerDirector`` equipped with the given cookie jar.

    Args:
        cj: The cookie jar to attach to the opener.

    Returns:
        A configured ``OpenerDirector`` instance.
    """
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))


def _get_opener() -> urllib.request.OpenerDirector:
    """Create a fresh authenticated session and return an HTTP opener.

    Creates a new cookie jar, authenticates against Confluence, saves the
    resulting cookies, and returns an opener pre-configured with them.

    Returns:
        An ``OpenerDirector`` ready for authenticated API requests.
    """
    _ensure_cookie_dir()
    cj = http.cookiejar.CookieJar()
    _authenticate(cj)
    return _make_opener(cj)


def _request(
    opener: urllib.request.OpenerDirector,
    path: str,
    method: str = "GET",
    body: dict[str, Any] | None = None,
    headers: dict[str, str] | None = None,
) -> tuple[int, Any]:
    """Execute an HTTP request and return the status code with parsed body.

    JSON responses are automatically deserialized; all other responses are
    returned as UTF-8 text.

    Args:
        opener: An authenticated ``OpenerDirector``.
        path: The API path (relative to :data:`BASE` or a full URL).
        method: The HTTP method (default ``"GET"``).
        body: Optional dict to serialize as JSON in the request body.
        headers: Optional extra HTTP headers to merge with defaults.

    Returns:
        A ``(status_code, body)`` tuple where *body* is either a parsed
        ``dict``/``list`` (for JSON responses) or a ``str``.

    Raises:
        _ConfluenceError: On HTTP errors (including 302 redirects) or network
            failures.
    """
    url = path if path.startswith("http") else BASE + path
    data: bytes | None = None
    h: dict[str, str] = {"User-Agent": UA, "Accept": "application/json"}
    if headers:
        h.update(headers)
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        h["Content-Type"] = "application/json"
    elif method == "POST":
        sys.stderr.write("POST requires a body dict\n")
        raise _ConfluenceError(0, "POST requires a body dict")

    req = urllib.request.Request(url, data=data, method=method, headers=h)
    try:
        with opener.open(req, timeout=30) as r:
            raw = r.read()
            ctype = r.headers.get("Content-Type", "")
            text = raw.decode("utf-8", errors="replace")
            if ctype.startswith("application/json"):
                try:
                    return r.status, json.loads(text)
                except json.JSONDecodeError:
                    return r.status, text
            return r.status, text
    except urllib.error.HTTPError as e:
        body_text = e.read().decode("utf-8", errors="replace") if e.fp else ""
        msg = body_text[:500].replace("\n", " ") if body_text else ""
        raise _ConfluenceError(e.code, msg)
    except urllib.error.URLError as e:
        raise _ConfluenceError(0, str(e.reason))


def _request_json(
    opener: urllib.request.OpenerDirector,
    path: str,
    method: str = "GET",
    body: dict[str, Any] | None = None,
) -> Any:
    """Execute a JSON API request and return the parsed response body.

    Convenience wrapper around :func:`_request` that raises
    :class:`_ConfluenceError` when the server returns a JSON error envelope.

    Args:
        opener: An authenticated ``OpenerDirector``.
        path: The API path.
        method: The HTTP method (default ``"GET"``).
        body: Optional JSON-serializable dict for POST/PUT requests.

    Returns:
        The parsed response body (typically a ``dict`` or ``list``).

    Raises:
        _ConfluenceError: If the response contains a ``statusCode`` field
            indicating an API error.
    """
    status, result = _request(opener, path, method=method, body=body)
    if isinstance(result, dict) and "statusCode" in result:
        raise _ConfluenceError(status, json.dumps(result, ensure_ascii=False))
    return result


def _emit_json(obj: Any) -> None:
    """Print a pretty-printed JSON representation of *obj* to stdout.

    Uses ``ensure_ascii=False`` so that Unicode characters (e.g. Danish
    letters æ, ø, å) render directly instead of as escape sequences.

    Args:
        obj: The object to serialize.
    """
    print(json.dumps(obj, ensure_ascii=False, indent=2))


def _strip_tags(text: str) -> str:
    """Remove all HTML/XML tags from *text*, leaving only the raw content.

    Args:
        text: A string potentially containing HTML markup.

    Returns:
        The string with all ``<...>`` tag sequences removed.
    """
    return re.sub(r"<[^>]+>", "", text)


def _run_cmd(func: Callable[..., None], args: "Namespace") -> None:
    """Run a CLI command with automatic session recovery on authentication failure.

    If the first attempt fails with HTTP 302 (session expired), the cached
    credentials are cleared and the command is retried once.

    Args:
        func: The command callable to invoke.
        args: Parsed ``argparse.Namespace`` with command-specific arguments.

    Raises:
        SystemExit: On non-recoverable errors or a second failed attempt.
    """
    for attempt in range(2):
        try:
            opener = _get_opener()
            func(opener, args)
            return
        except _ConfluenceError as e:
            if e.code == 302 and attempt == 0:
                # Session expired — clear cached creds and retry.
                global _cached_creds
                _cached_creds = None
                continue
            sys.stderr.write(f"HTTP {e.code}: {e.message}\n")
            sys.exit(2)
        except SystemExit:
            raise


# ── Command implementations ──────────────────────────────────────────
# Each command takes an authenticated ``opener`` and an ``argparse.Namespace``
# of parsed arguments, and prints human-readable output (or raw JSON when
# ``--raw`` is set).


def cmd_spaces(opener: Any, args: "Namespace") -> None:
    """List all Confluence spaces with optional pagination.

    Prints a summary line with the total count, followed by one line per
    space showing key, name, type, and a truncated description.
    """
    qs = urllib.parse.urlencode({
        "expand": "description.plain",
        "limit": str(args.limit),
        "start": str(args.start),
    })
    data = _request_json(opener, f"/rest/api/space?{qs}")
    if args.raw:
        _emit_json(data)
        return
    total = data.get("size", 0)
    start = data.get("start", 0)
    print(
        f"Total spaces: {total}  "
        f"(showing {start}-{start + len(data.get('results', []))})"
    )
    for s in data.get("results", []):
        key = s.get("key", "?")
        name = s.get("name", "?")
        stype = s.get("type", "?")
        desc = ""
        if "description" in s:
            desc = (
                s["description"].get("plain", {}).get("value", "") or ""
            )[:80]
        prefix = "  " if key.startswith("~") else ""
        print(f"{prefix}{key}: {name} [{stype}]")
        if desc:
            print(f"   {desc}")


def cmd_pages(opener: Any, args: "Namespace") -> None:
    """List top-level pages in a Confluence space.

    Displays page ID, title, version number, parent page (if any), and
    the number of child pages.
    """
    qs = urllib.parse.urlencode({
        "spaceKey": args.space_key,
        "limit": str(args.limit),
        "expand": "body.storage,version,ancestors,children.page",
        "depth": "1",
    })
    data = _request_json(opener, f"/rest/api/content?{qs}")
    if args.raw:
        _emit_json(data)
        return
    total = data.get("size", 0)
    print(f"Total pages in {args.space_key}: {total}")
    for p in data.get("results", []):
        title = p.get("title", "?")
        pid = p.get("id", "?")
        version = p.get("version", {}).get("number", "?")
        ancestors = p.get("ancestors", [])
        ancestor_info = ""
        if ancestors:
            ancestor_info = (
                f" (child of: {ancestors[-1].get('title', '?')})"
            )
        children = (
            p.get("children", {}).get("page", {}).get("results", [])
        )
        child_info = f" (+{len(children)} children)" if children else ""
        print(f"  [{pid}] {title} v{version}{ancestor_info}{child_info}")


def cmd_search(opener: Any, args: "Namespace") -> None:
    """Search Confluence pages by title or full CQL query.

    Accepts a positional *query* argument (converted to a title search) or
    a ``--cql`` flag for full Confluence Query Language expressions.
    """
    if args.cql:
        cql = args.cql
    elif args.query:
        cql = 'title~"' + args.query.replace('"', '\\"') + '"'
    else:
        sys.stderr.write("Provide a query or --cql argument\n")
        sys.exit(2)
    qs = urllib.parse.urlencode({"cql": cql, "limit": str(args.limit)})
    data = _request_json(opener, f"/rest/api/search?{qs}")
    if args.raw:
        _emit_json(data)
        return
    total = data.get("totalSize", 0)
    print(f"Search results: {total} total")
    for r in data.get("results", []):
        content = r.get("content", {})
        if isinstance(content, dict) and content.get("space"):
            space_key = content["space"].get("key", "?")
        elif r.get("space"):
            space_key = r["space"].get("key", "?")
        else:
            url = r.get("url", "")
            path = url.split("?")[0]
            parts = path.strip("/").split("/")
            space_key = parts[1] if len(parts) >= 2 else "?"
        title = r.get("title", "?")
        if isinstance(content, dict) and content.get("id"):
            pid = content["id"]
        else:
            url = r.get("url", "")
            if "pageId=" in url:
                pid = url.split("pageId=")[1].split("&")[0]
            else:
                pid = "?"
        lastmod = (
            r.get("lastModified", "?")[:10] if r.get("lastModified") else "?"
        )
        body_val = r.get("body", {}).get("view", {}).get("value", "")
        body_clean = re.sub(r"@@@hl@@@|@@@endhl@@@", "", body_val)
        body_clean = _strip_tags(body_clean)[:200]
        print(f"  [{space_key}] {title} (id={pid}, modified={lastmod})")
        if body_clean:
            print(f"    {body_clean}")


def cmd_page(opener: Any, args: "Namespace") -> None:
    """Retrieve and display a single Confluence page by key or ID.

    Shows metadata (title, key, space, ID, version, ancestors, children)
    and a preview of the page body. Use ``--format text`` or ``--format html``
    to view the full body.
    """
    if args.key:
        qs = urllib.parse.urlencode({
            "key": args.key,
            "expand": "body.storage,body.view,version,space,"
            "ancestors,children.page",
        })
        data = _request_json(opener, f"/rest/api/content?{qs}")
    elif args.id:
        qs = urllib.parse.urlencode({
            "expand": "body.storage,body.view,version,space,"
            "ancestors,children.page",
        })
        data = _request_json(opener, f"/rest/api/content/{args.id}?{qs}")
    else:
        sys.stderr.write("Provide --key or --id\n")
        sys.exit(2)

    if args.raw:
        _emit_json(data)
        return

    # Derive page key from the API response if not directly available.
    page_key = data.get("key", "")
    if not page_key:
        webui = data.get("_links", {}).get("webui", "")
        if webui:
            parts = webui.strip("/").split("/")
            if len(parts) >= 2:
                page_key = parts[1]

    print(f"Title:  {data.get('title')}")
    print(f"Key:    {page_key}")
    print(f"Space:  {data.get('space', {}).get('key')}")
    print(f"ID:     {data.get('id')}")
    print(f"Version: {data.get('version', {}).get('number')}")
    ancestors = data.get("ancestors", [])
    if ancestors:
        print("Ancestors:")
        for a in ancestors:
            print(f"  - {a.get('title')} (id={a.get('id')})")
    children = (
        data.get("children", {}).get("page", {}).get("results", [])
    )
    if children:
        print(f"Child pages ({len(children)}):")
        for c in children:
            print(f"  - {c.get('title')} (id={c.get('id')})")

    # Display the page body according to the selected format.
    val = data.get("body", {}).get("storage", {}).get("value", "")
    if args.format == "text":
        print("\n--- Body (plain text) ---")
        print(_strip_tags(val))
    elif args.format == "html":
        print("\n--- Body (HTML) ---")
        print(val)
    else:
        clean = _strip_tags(val)
        print(f"\nBody: {len(clean)} chars")
        print(clean[:1000])
        if len(clean) > 1000:
            print(f"... ({len(clean) - 1000} more chars)")


def cmd_create(opener: Any, args: "Namespace") -> None:
    """Create a new Confluence page in the specified space.

    The page can optionally be created as a child of an existing page
    (via ``--ancestor-id``) or marked as a minor edit.
    """
    body_dict: dict[str, Any] = {
        "type": "page",
        "title": args.title,
        "space": {"key": args.space_key},
        "body": {
            "storage": {
                "value": args.body,
                "representation": "storage",
            }
        },
    }
    if args.minor_edit:
        body_dict["minorEdit"] = True
    if args.ancestor_id:
        body_dict["ancestor"] = {"id": args.ancestor_id}

    data = _request_json(
        opener, "/rest/api/content", method="POST", body=body_dict
    )
    if args.raw:
        _emit_json(data)
        return
    print(f"Created page: {data.get('title')}")
    print(f"  ID:   {data.get('id')}")
    print(f"  Key:  {data.get('key')}")
    print(f"  URL:  {BASE}/pages/viewpage.action?pageId={data.get('id')}")


def cmd_create_project(opener: Any, args: "Namespace") -> None:
    """Create a new project page using The Alexandra Way template.

    Generates a pre-filled page with project metadata, checklist excerpts
    for each project phase, and standard task lists. The page is created
    as a child of "Projektoverblik" (page ID 208044217).
    """
    project_body = (
        '<h1>Projekt: {title}</h1>\n'
        '<ac:structured-macro ac:name="toc">\n'
        '  <ac:parameter ac:name="minHeaders">2</ac:parameter>\n'
        '  <ac:parameter ac:name="maxHeaders">6</ac:parameter>\n'
        '  <ac:parameter ac:name="include">.*</ac:parameter>\n'
        '  <ac:parameter ac:name="style">disc</ac:parameter>\n'
        '  <ac:parameter ac:name="staticStyle">'
        'confluence-wiki-toc</ac:parameter>\n'
        '  <ac:parameter ac:name="staticClass">section-toc</ac:parameter>\n'
        '</ac:structured-macro>\n\n'
        '<h2>Projektinfo</h2>\n'
        '<table class="wrapped confstyle">\n'
        '<thead>\n'
        '<tr>\n'
        '<th>felt</th>\n'
        '<th>værdi</th>\n'
        "</tr>\n"
        "</thead>\n"
        "<tbody>\n"
        '<tr>\n'
        '<td>Projektnavn</td>\n'
        f'<td>{args.title}</td>\n'
        "</tr>\n"
        '<tr>\n'
        '<td>Klient / kunde</td>\n'
        f'<td>{args.client}</td>\n'
        "</tr>\n"
        '<tr>\n'
        '<td>Projektansvarlig</td>\n'
        f'<td>{args.owner}</td>\n'
        "</tr>\n"
        '<tr>\n'
        '<td>Intern Projektejer</td>\n'
        f'<td>{args.owner}</td>\n'
        "</tr>\n"
        '<tr>\n'
        '<td>Budget (Alexandra Instituttets Andel)</td>\n'
        f'<td>{args.budget}</td>\n'
        "</tr>\n"
        '<tr>\n'
        '<td>Projekttype</td>\n'
        '<td>Under udvikling</td>\n'
        "</tr>\n"
        '<tr>\n'
        '<td>Projektslut</td>\n'
        '<td>Ikke fastsat</td>\n'
        "</tr>\n"
        '<tr>\n'
        '<td>Projektkode</td>\n'
        '<td>IKKE Tildelt</td>\n'
        "</tr>\n"
        '<tr>\n'
        '<td>Status</td>\n'
        '<td>Under initiering</td>\n'
        "</tr>\n"
        '<tr>\n'
        '<td>Skabelon</td>\n'
        '<td>The Alexandra Way</td>\n'
        "</tr>\n"
        "</tbody>\n"
        "</table>\n\n"
        '<h2>Projektbeskrivelse</h2>\n'
        '<p>Udfyld projektbeskrivelsen her.</p>\n\n'
        '<h2>Tjeklister</h2>\n'
        '<h3>Initiering</h3>\n'
        '<ac:structured-macro ac:name="excerpt">\n'
        '  <ac:parameter ac:name="restrictToPage">225903078</ac:parameter>\n'
        '</ac:structured-macro>\n\n'
        '<h3>Eksekvering</h3>\n'
        '<ac:structured-macro ac:name="excerpt">\n'
        '  <ac:parameter ac:name="restrictToPage">'
        '225903164</ac:parameter>\n'
        '</ac:structured-macro>\n\n'
        '<h3>Afslutning</h3>\n'
        '<ac:structured-macro ac:name="excerpt">\n'
        '  <ac:parameter ac:name="restrictToPage">'
        '225903170</ac:parameter>\n'
        '</ac:structured-macro>\n\n'
        '<h2>Administrative opgaver</h2>\n'
        '<ul>\n'
        '<li>Opret projekt i system</li>\n'
        '<li>Fastlæg budget og resurser</li>\n'
        '<li>Identificér interessenter</li>\n'
        '<li>Planlæg første milestone</li>\n'
        "</ul>\n\n"
        '<h2>Projektledelsesopgaver</h2>\n'
        '<ul>\n'
        '<li>Lav projektplan</li>\n'
        '<li>Sæt op projektstyregruppe</li>\n'
        '<li>Fastlæg rapporteringsrutiner</li>\n'
        "</ul>\n\n"
        '<h2>Softwareudviklingsopgaver</h2>\n'
        '<p>Udfyld softwareudviklingsopgaver her.</p>\n\n'
        '<h2>Milestone oversigt</h2>\n'
        '<table class="wrapped confstyle">\n'
        '<thead>\n'
        '<tr>\n'
        '<th>Milestone</th>\n'
        '<th>Dato</th>\n'
        '<th>Status</th>\n'
        "</tr>\n"
        "</thead>\n"
        "<tbody>\n"
        '<tr>\n'
        '<td>MVP</td>\n'
        '<td>Ikke fastsat</td>\n'
        '<td>Planlagt</td>\n'
        "</tr>\n"
        "</tbody>\n"
        "</table>"
    ).format(
        title=args.title,
        client=args.client,
        owner=args.owner,
        budget=args.budget,
    )

    body_dict: dict[str, Any] = {
        "type": "page",
        "title": args.title,
        "space": {"key": args.space_key},
        "body": {
            "storage": {
                "value": project_body,
                "representation": "storage",
            }
        },
        "ancestor": {"id": "208044217"},
    }
    data = _request_json(
        opener, "/rest/api/content", method="POST", body=body_dict
    )
    if args.raw:
        _emit_json(data)
        return
    print(f"Created project page: {data.get('title')}")
    print(f"  ID:   {data.get('id')}")
    print(f"  Key:  {data.get('key')}")
    print(f"  URL:  {BASE}/pages/viewpage.action?pageId={data.get('id')}")
    print(f"  Template: The Alexandra Way (projektforklæde)")


def cmd_update(opener: Any, args: "Namespace") -> None:
    """Update an existing Confluence page's title and/or body.

    Always bumps the version number. Use ``--title`` to change the title;
    omit it to keep the current title unchanged.
    """
    qs = urllib.parse.urlencode({"expand": "version"})
    page = _request_json(opener, f"/rest/api/content/{args.id}?{qs}")
    version_number = page.get("version", {}).get("number", 1)

    body_dict: dict[str, Any] = {
        "id": args.id,
        "type": "page",
        "title": args.title or page.get("title", ""),
        "version": {"number": version_number + 1},
        "body": {
            "storage": {
                "value": args.body,
                "representation": "storage",
            }
        },
    }
    if args.minor_edit:
        body_dict["minorEdit"] = True

    data = _request_json(
        opener, f"/rest/api/content/{args.id}", method="PUT", body=body_dict
    )
    if args.raw:
        _emit_json(data)
        return
    print(f"Updated page: {data.get('title')}")
    print(f"  New version: {data.get('version', {}).get('number')}")


def cmd_delete(opener: Any, args: "Namespace") -> None:
    """Delete a Confluence page and print its former metadata."""
    qs = urllib.parse.urlencode({"expand": "title,space"})
    page = _request_json(opener, f"/rest/api/content/{args.id}?{qs}")
    title = page.get("title", "?")
    space = page.get("space", {}).get("key", "?")

    _request(opener, f"/rest/api/content/{args.id}", method="DELETE")
    print(f"Deleted page: {title} (id={args.id}, space={space})")


def cmd_whoami(opener: Any, args: "Namespace") -> None:
    """Display the authenticated user's profile information."""
    data = _request_json(
        opener,
        "/rest/api/user/current?expand=fullName,displayName,userkey",
    )
    if args.raw:
        _emit_json(data)
        return
    print(f"Username:  {data.get('username')}")
    print(f"Display:   {data.get('displayName')}")
    print(f"User key:  {data.get('userKey')}")
    print(f"Full name: {data.get('fullName', '-')}")


def cmd_auth(opener: Any, args: "Namespace") -> None:
    """Force re-authentication by clearing the credential cache.

    Deletes any existing cookie file and performs a fresh login, then
    saves the new session cookies to disk.
    """
    global _cached_creds
    _cached_creds = None
    print("Cached credentials cleared. Please re-enter credentials.")
    cj = http.cookiejar.CookieJar()
    _authenticate(cj)
    print("Authenticated successfully. Cookies saved.")


def cmd_api(opener: Any, args: "Namespace") -> None:
    """Make a raw API call to any Confluence REST endpoint.

    Supports GET, POST, PUT, and DELETE methods. For POST/PUT requests,
    pass a JSON string via ``--body``.
    """
    if args.method == "GET":
        data = _request_json(opener, args.path)
    elif args.method == "POST":
        if not args.body:
            sys.stderr.write("POST requires --body\n")
            sys.exit(2)
        body = json.loads(args.body) if args.body else {}
        data = _request_json(
            opener, args.path, method="POST", body=body
        )
    else:
        sys.stderr.write(f"Unsupported method: {args.method}\n")
        sys.exit(2)
    if args.raw:
        _emit_json(data)
        return
    _emit_json(data)


# ── Dispatch table ───────────────────────────────────────────────────

_COMMANDS: dict[str, Callable[[Any, "Namespace"], None]] = {
    "auth": cmd_auth,
    "spaces": cmd_spaces,
    "pages": cmd_pages,
    "search": cmd_search,
    "page": cmd_page,
    "create": cmd_create,
    "create-project": cmd_create_project,
    "update": cmd_update,
    "delete": cmd_delete,
    "whoami": cmd_whoami,
    "api": cmd_api,
}


def main() -> None:
    """Entry point: parse CLI arguments and dispatch to the appropriate command."""
    parser = argparse.ArgumentParser(
        description="CLI for Alexandra's Confluence instance."
    )
    sub = parser.add_subparsers(dest="cmd", required=True)

    def _add(name: str, **kwargs: Any) -> argparse.ArgumentParser:
        """Helper: create a subparser with a shared ``--raw`` flag."""
        p = sub.add_parser(name, **kwargs)
        p.add_argument(
            "--raw",
            action="store_true",
            help=(
                "Print raw JSON response instead of "
                "the human-readable formatter"
            ),
        )
        return p

    _add("auth", help="Authenticate and save cookies")

    p = _add("spaces", help="List all spaces")
    p.add_argument("--limit", type=int, default=100)
    p.add_argument("--start", type=int, default=0)

    p = _add("pages", help="List pages in a space")
    p.add_argument("--space-key", required=True)
    p.add_argument("--limit", type=int, default=20)

    p = _add("search", help="Search Confluence pages")
    p.add_argument(
        "query",
        nargs="?",
        help="Search query (converted to a title search)",
    )
    p.add_argument("--cql", help="Full CQL query (overrides *query*)")
    p.add_argument("--limit", type=int, default=20)

    p = _add("page", help="Get a single page by key or ID")
    p.add_argument("--key", help="Page key")
    p.add_argument("--id", help="Page ID")
    p.add_argument(
        "--format",
        choices=["auto", "text", "html"],
        default="auto",
        help="Body output format (default: auto = plain-text preview)",
    )

    p = _add("create", help="Create a new page")
    p.add_argument("--space-key", required=True)
    p.add_argument("--title", required=True)
    p.add_argument("--body", required=True)
    p.add_argument(
        "--ancestor-id",
        help="Parent page ID (creates the page as a child)",
    )
    p.add_argument("--minor-edit", action="store_true")

    p = _add(
        "create-project",
        help=(
            "Create a new project page with The Alexandra Way template"
        ),
    )
    p.add_argument("--space-key", default="PROJ")
    p.add_argument("--title", required=True)
    p.add_argument(
        "--client", required=True, help="Client / customer name"
    )
    p.add_argument(
        "--owner", required=True, help="Project owner / manager"
    )
    p.add_argument("--budget", default="Ikke fastsat")

    p = _add("update", help="Update an existing page")
    p.add_argument("--id", required=True)
    p.add_argument("--body", required=True)
    p.add_argument(
        "--title",
        help="New title (default: keep current title)",
    )
    p.add_argument("--minor-edit", action="store_true")

    p = _add("delete", help="Delete a page")
    p.add_argument("--id", required=True)

    _add("whoami", help="Show current user")

    p = _add("api", help="Raw API call (advanced)")
    p.add_argument(
        "--method",
        choices=["GET", "POST", "PUT", "DELETE"],
        default="GET",
    )
    p.add_argument("--path", required=True)
    p.add_argument("--body", help="JSON body for POST/PUT")

    args = parser.parse_args()
    cmd_func = _COMMANDS[args.cmd]
    _run_cmd(cmd_func, args)


if __name__ == "__main__":
    main()
