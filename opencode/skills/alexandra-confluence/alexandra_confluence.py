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
import difflib
import getpass
import html
import http.cookiejar
import json
import os
import re
import sys
import time
import typing as t
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


sys.stdout.reconfigure(encoding="utf-8")


# ── Constants ────────────────────────────────────────────────────────

BASE: str = "https://confluence.alexandra.dk"
UA: str = "Mozilla/5.0 (alexandra-confluence-cli)"
COOKIE_DIR: Path = Path.home() / ".alexandra-confluence"
COOKIE_FILE: Path = COOKIE_DIR / "cookies.txt"
PROJ_ANCESTOR_ID: str = "208044217"  # "Projektoverblik (The Alexandra Way)"
_SLIDE_DECKS_PAGE_ID: str = "97042311"  # AI Lab slide decks page
_page_id_cache: dict[str, str] = {}
MAX_RETRIES: int = 3
INITIAL_BACKOFF: float = 1.0

_KNOWN_CATEGORIES: dict[str, tuple[str, str]] = {
    "about-us": ("1. About Us presentations", "date"),
    "themed": ("2. Themed presentation", "date"),
    "themed-general": ("2.1. General presentation about AI / AI potential checks", "date"),
    "nlp": ("2.2. NLP", "date"),
    "energy": ("2.3. Energy, Utilities & Construction", "date"),
    "healthcare": ("2.4. Healthcare", "date"),
    "iot": ("2.5. IoT / Anomaly detections", "date"),
    "client": ("3. Client Presentations", "date"),
    "courses": ("4. Courses / workshops", "date"),
    "presentations": ('5. Presentions ("opl\u00e6g")', "date"),
    "legacy": ("6. Legacy presentation Links", "date"),
}


_PROJECT_TEMPLATE: str = """\
<h1>Projekt: {title}</h1>
<ac:structured-macro ac:name="toc">
  <ac:parameter ac:name="minHeaders">2</ac:parameter>
  <ac:parameter ac:name="maxHeaders">6</ac:parameter>
  <ac:parameter ac:name="include">.*</ac:parameter>
  <ac:parameter ac:name="style">disc</ac:parameter>
</ac:structured-macro>

<h2>Projektinfo</h2>
<table class="wrapped confstyle">
<thead><tr><th>felt</th><th>v\u00e6rdi</th></tr></thead>
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
<li>Fastl\u00e6g budget og resurser</li>
<li>Identific\u00e9r interessenter</li>
<li>Planl\u00e6g f\u00f8rste milestone</li></ul>

<h2>Projektledelsesopgaver</h2>
<ul><li>Lav projektplan</li>
<li>S\u00e6t op projektstyregruppe</li>
<li>Fastl\u00e6g rapporteringsrutiner</li></ul>

<h2>Softwareudviklingsopgaver</h2>
<p>Udfyld softwareudviklingsopgaver her.</p>

<h2>Milestone oversigt</h2>
<table class="wrapped confstyle">
<thead><tr><th>Milestone</th><th>Dato</th><th>Status</th></tr></thead>
<tbody><tr><td>MVP</td><td>Ikke fastsat</td><td>Planlagt</td></tr></tbody>
</table>"""


# ── Page ID resolution ───────────────────────────────────────────────

def _resolve_page_id(
    opener: t.Any,
    title: str,
    space_key: str | None = None,
) -> str:
    """Resolve a page ID by searching for it by title.

    Uses cached result if available, otherwise queries CQL search
    and caches the result.

    Args:
        opener: HTTP opener with authenticated session.
        title: Page title substring to search for.
        space_key: Optional space key to narrow the search.

    Returns:
        The page ID as a string.

    Raises:
        _ConfluenceError: If no page matching the title is found.
    """
    cache_key = f"{space_key}:{title}" if space_key else title
    if cache_key in _page_id_cache:
        return _page_id_cache[cache_key]

    if space_key:
        cql = f'title~"{title}" AND space={space_key}'
    else:
        cql = f'title~"{title}"'

    qs = urllib.parse.urlencode({"cql": cql, "limit": 1})
    data = _request_json(opener, f"/rest/api/search?{qs}")

    results = data.get("results", [])
    if not results:
        raise _ConfluenceError(
            404, f"No page found matching title '{title}'",
        )

    page_id = results[0]["content"]["id"]
    _page_id_cache[cache_key] = page_id
    return page_id


# ── Exception ────────────────────────────────────────────────────────


class _ConfluenceError(Exception):
    """Raised when a Confluence API call returns an error status code."""

    def __init__(self, code: int, message: str) -> None:
        self.code = code
        self.message = message
        super().__init__(f"HTTP {code}: {message}")


# ── Auth helpers ─────────────────────────────────────────────────────

_cached_creds: tuple[str, str] | None = None


def _load_env(env_path: Path) -> None:
    """Parse a simple .env file and set KEY=VALUE pairs into os.environ.

    Skips blank lines and lines beginning with '#'.  Strips surrounding
    single or double quotes from values.  Silently passes if the file
    does not exist or cannot be read.
    """
    try:
        text = env_path.read_text(encoding="utf-8")
    except OSError:
        return
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if "=" not in stripped:
            continue
        key, _, raw_value = stripped.partition("=")
        key = key.strip()
        value = raw_value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ('"', "'"):
            value = value[1:-1]
        os.environ[key] = value


def _get_credentials() -> tuple[str, str]:
    global _cached_creds
    if _cached_creds is not None:
        return _cached_creds
    user = os.environ.get("CONFLUENCE_USER") or input("Confluence username: ")
    passwd = os.environ.get("CONFLUENCE_PASS") or getpass.getpass(
        "Confluence password: "
    )
    _cached_creds = (user, passwd)
    return _cached_creds


def _has_env_credentials() -> bool:
    return bool(os.environ.get("CONFLUENCE_USER") and os.environ.get("CONFLUENCE_PASS"))


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
    """Form-login. Sets fresh session cookies on the opener's jar.

    Retries transient failures (network errors, HTTP 429/500/502/503)
    up to MAX_RETRIES times with exponential backoff.
    """
    retryable_codes: set[int] = {429, 500, 502, 503}

    # Step 1: GET /index.action to establish session
    for attempt in range(MAX_RETRIES + 1):
        try:
            opener.open(
                urllib.request.Request(
                    f"{BASE}/index.action",
                    headers={"User-Agent": UA},
                ),
                timeout=30,
            ).close()
            break
        except urllib.error.HTTPError as e:
            if attempt < MAX_RETRIES and e.code in retryable_codes:
                sys.stderr.write(
                    f"Auth session GET {e.code} (retry {attempt + 1}/{MAX_RETRIES})\n",
                )
                time.sleep(INITIAL_BACKOFF * (2**attempt))
                continue
            sys.stderr.write(
                f"Failed to establish session: HTTP {e.code}\n",
            )
            sys.exit(2)
        except urllib.error.URLError as e:
            if attempt < MAX_RETRIES:
                sys.stderr.write(
                    f"Auth session network error (retry {attempt + 1}/{MAX_RETRIES})\n",
                )
                time.sleep(INITIAL_BACKOFF * (2**attempt))
                continue
            sys.stderr.write(f"Failed to establish session: {e.reason}\n")
            sys.exit(2)

    # Step 2: GET /login.action to fetch form token
    for attempt in range(MAX_RETRIES + 1):
        try:
            with opener.open(
                urllib.request.Request(
                    f"{BASE}/login.action",
                    headers={"User-Agent": UA},
                ),
                timeout=30,
            ) as r:
                page = r.read().decode("utf-8", errors="replace")
            break
        except urllib.error.HTTPError as e:
            if attempt < MAX_RETRIES and e.code in retryable_codes:
                sys.stderr.write(
                    f"Auth login GET {e.code} (retry {attempt + 1}/{MAX_RETRIES})\n",
                )
                time.sleep(INITIAL_BACKOFF * (2**attempt))
                continue
            sys.stderr.write(f"HTTP {e.code} on GET /login.action\n")
            sys.exit(2)
        except urllib.error.URLError as e:
            if attempt < MAX_RETRIES:
                sys.stderr.write(
                    f"Auth login network error (retry {attempt + 1}/{MAX_RETRIES})\n",
                )
                time.sleep(INITIAL_BACKOFF * (2**attempt))
                continue
            sys.stderr.write(f"GET /login.action failed: {e.reason}\n")
            sys.exit(2)

    m = re.search(r'name="atlassian-token" content="([^"]+)"', page)
    if not m:
        sys.stderr.write("atlassian-token not found in login page\n")
        sys.exit(2)

    user, passwd = _get_credentials()
    data = urllib.parse.urlencode(
        {
            "os_username": user,
            "os_password": passwd,
            "os_authType": "basic",
            "atlassian-token": m.group(1),
        }
    ).encode("utf-8")

    req = urllib.request.Request(
        f"{BASE}/dologin.action",
        data=data,
        headers={
            "User-Agent": UA,
            "Content-Type": "application/x-www-form-urlencoded",
        },
    )

    # Step 3: POST /dologin.action
    for attempt in range(MAX_RETRIES + 1):
        try:
            with opener.open(req, timeout=30) as r:
                if r.status != 200:
                    sys.stderr.write(f"Login returned HTTP {r.status}\n")
                    sys.exit(2)
            break
        except urllib.error.HTTPError as e:
            if attempt < MAX_RETRIES and e.code in retryable_codes:
                sys.stderr.write(
                    f"Auth login POST {e.code} (retry {attempt + 1}/{MAX_RETRIES})\n",
                )
                time.sleep(INITIAL_BACKOFF * (2**attempt))
                continue
            sys.stderr.write(f"Login failed: HTTP {e.code}\n")
            sys.exit(2)
        except urllib.error.URLError as e:
            if attempt < MAX_RETRIES:
                sys.stderr.write(
                    f"Auth login POST network error "
                    f"(retry {attempt + 1}/{MAX_RETRIES})\n",
                )
                time.sleep(INITIAL_BACKOFF * (2**attempt))
                continue
            sys.stderr.write(f"POST /dologin.action failed: {e.reason}\n")
            sys.exit(2)


# ── HTTP helpers ─────────────────────────────────────────────────────


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

    req = urllib.request.Request(url, data=data, method=method, headers=h)
    retryable_codes: set[int] = {429, 500, 502, 503}

    for attempt in range(MAX_RETRIES + 1):
        try:
            with opener.open(req, timeout=30) as r:
                if "login.action" in r.url and "login.action" not in url:
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
            if attempt < MAX_RETRIES and e.code in retryable_codes:
                sys.stderr.write(
                    f"HTTP {e.code} (retry {attempt + 1}/{MAX_RETRIES})\n",
                )
                time.sleep(INITIAL_BACKOFF * (2**attempt))
                continue
            body_text = e.read().decode("utf-8", errors="replace") if e.fp else ""
            raise _ConfluenceError(
                e.code,
                body_text[:500].replace("\n", " "),
            )
        except urllib.error.URLError as e:
            if attempt < MAX_RETRIES:
                sys.stderr.write(
                    f"Network error (retry {attempt + 1}/{MAX_RETRIES})\n",
                )
                time.sleep(INITIAL_BACKOFF * (2**attempt))
                continue
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


def _run_cmd(
    func: c.Callable[..., None],
    args: argparse.Namespace,
) -> None:
    """Reuse persisted cookies; on session expiry re-auth and retry once."""
    cj = _build_jar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
    if _has_env_credentials():
        _authenticate(opener)
        authenticated = True
    else:
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


# ── Utility helpers ──────────────────────────────────────────────────


def _emit_json(obj: t.Any) -> None:
    print(json.dumps(obj, ensure_ascii=False, indent=2))


def _strip_tags(text: str) -> str:
    return re.sub(r"<[^>]+>", "", text)


def _find_depth_bound(
    text: str,
    open_str: str,
    close_str: str,
    start: int,
) -> int:
    """Count nesting depth from *start* until the matching close tag.

    Returns the index just past the closing tag, or -1 if not found.
    """
    depth = 0
    i = start
    while i < len(text):
        if text[i : i + len(open_str)] == open_str:
            depth += 1
        elif text[i : i + len(close_str)] == close_str:
            depth -= 1
            if depth == 0:
                return i + len(close_str)
        i += 1
    return -1


def _extract_slide_rows(tbody_html: str) -> list[dict[str, str]]:
    """Extract parsed row dicts from a <tbody> string.

    Skips the first row if it contains <th> cells (header).
    """
    rows_raw = re.findall(r"<tr(?:[^>]*)?>(.*?)</tr>", tbody_html, re.DOTALL)
    results: list[dict[str, str]] = []
    for _idx, row_html in enumerate(rows_raw):
        if "<th" in row_html:
            continue
        cells = re.findall(r"<td[^>]*>(.*?)</td>", row_html, re.DOTALL)
        while len(cells) < 5:
            cells.append("")
        results.append(
            {
                "date": _strip_tags(cells[0]).strip(),
                "owner_key": _strip_tags(cells[1]).strip(),
                "title": _strip_tags(cells[2]).strip(),
                "language": _strip_tags(cells[3]).strip(),
                "slides": _strip_tags(cells[4]).strip(),
            }
        )
    return results


def _build_slide_row(
    date: str | None,
    owner_key: str | None,
    title: str,
    language: str | None,
    slides: str | None,
) -> str:
    """Build a single <tr> row for the slide table."""
    if date:
        date_cell = (
            '<td data-mce-resize="false">'
            '<div class="content-wrapper">'
            '<p><time datetime="' + date + '" />&nbsp;</p>'
            "</div></td>"
        )
    else:
        date_cell = '<td data-mce-resize="false"><br /></td>'

    if owner_key:
        owner_cell = (
            '<td><div class="content-wrapper">'
            '<p><ac:link><ri:user ri:userkey="' + owner_key + '" /></ac:link>&nbsp;</p>'
            "</div></td>"
        )
    else:
        owner_cell = "<td></td>"

    title_cell = "<td>" + html.escape(title) + "</td>"

    if language:
        lang_cell = "<td>" + html.escape(language) + "</td>"
    else:
        lang_cell = "<td></td>"

    if slides:
        slides_cell = (
            '<td><div class="content-wrapper">'
            '<p><ac:link><ri:attachment ri:filename="'
            + html.escape(slides)
            + '" /></ac:link></p>'
            "</div></td>"
        )
    else:
        slides_cell = "<td></td>"

    return (
        "<tr>" + date_cell + owner_cell + title_cell + lang_cell + slides_cell + "</tr>"
    )


def _build_note_row(note: str) -> str:
    """Build a plain text row (no table columns, just a note)."""
    return '<tr><td colspan="5">' + html.escape(note) + "</td></tr>"


def _clean_heading(html_fragment: str) -> str:
    """Strip all HTML tags from a heading fragment and trim whitespace.

    HTML entities (e.g. ``&amp;``) are decoded to their character equivalents
    so that comparisons are robust against Confluence's HTML encoding.
    """
    return html.unescape(re.sub(r"<[^>]+>", "", html_fragment)).strip()


def _find_table_in_section(
    body: str,
    after_offset: int,
) -> tuple[int, int] | None:
    """Find the first <table>...</table> starting at *after_offset*.

    Returns ``(table_start, table_end)`` or ``None`` if not found.
    """
    table_start = body.find("<table", after_offset)
    if table_start < 0:
        return None

    depth = 0
    table_end = -1
    for i in range(table_start, len(body)):
        if body[i : i + 6] == "<table":
            depth += 1
        elif body[i : i + 8] == "</table>":
            depth -= 1
            if depth == 0:
                table_end = i + 8
                break

    if table_end < 0:
        return None

    return table_start, table_end


def _extract_tbody_rows(
    table_start: int,
    table_end: int,
    body: str,
) -> list[dict[str, str]] | None:
    """Extract slide rows from a table span within *body*.

    Returns a list of row dicts or ``None`` if the table has no tbody.
    """
    full_table = body[table_start:table_end]
    tbody_start = full_table.find("<tbody")
    if tbody_start < 0:
        return None

    tbody_end = _find_depth_bound(full_table, "<tbody", "</tbody>", tbody_start)
    if tbody_end < 0:
        return None

    tbody = full_table[tbody_start:tbody_end]
    return _extract_slide_rows(tbody)


def _find_nearest_heading(
    heading_positions: list[int],
    table_start: int,
    body: str,
) -> str | None:
    """Return the cleaned text of the nearest heading before *table_start*.

    Returns ``None`` if no preceding heading is found.
    """
    best_idx = -1
    for hi, hp in enumerate(heading_positions):
        if hp < table_start:
            best_idx = hi
        else:
            break

    if best_idx < 0:
        return None

    heading_fragment = body[heading_positions[best_idx] :]
    close_tag_match = re.search(r"</h[12]>", heading_fragment)
    if close_tag_match:
        heading_fragment = heading_fragment[: close_tag_match.end()]

    return _clean_heading(heading_fragment)


def _build_heading_to_cat_map(
    body: str,
) -> dict[str, str]:
    """Map cleaned heading text -> category key.

    Returns a dict mapping heading display text to the CLI category key.
    """
    heading_map: dict[str, str] = {}
    for cat_key, (heading_text, _) in _SLIDE_CATEGORIES.items():
        for m in re.finditer(r"<h[12][^>]*>(.*?)</h[12]>", body, re.DOTALL):
            if _clean_heading(m.group(1)) == heading_text:
                heading_map[heading_text] = cat_key
                break
    return heading_map


# ── Resource classes ─────────────────────────────────────────────────


class Spaces:
    """Manage Confluence spaces."""

    @staticmethod
    def list(opener: t.Any, args: argparse.Namespace) -> None:
        """List all spaces."""
        start = args.start
        total_seen = 0
        total_size = 0

        while True:
            qs = urllib.parse.urlencode(
                {
                    "expand": "description.plain",
                    "limit": args.limit,
                    "start": start,
                }
            )
            data = _request_json(opener, f"/rest/api/space?{qs}")

            if total_size == 0:
                total_size = data.get("size", 0)

            results = data.get("results", [])
            total_seen += len(results)

            if args.raw:
                for s in results:
                    _emit_json(s)
                continue

            # Print header on first iteration only
            if start == args.start:
                print(
                    f"Total spaces: {total_size}  (showing {start}-{start + total_seen})"
                )

            for s in results:
                key = s.get("key", "?")
                name = s.get("name", "?")
                stype = s.get("type", "?")
                desc = (
                    s.get("description", {}).get("plain", {}).get("value", "") or ""
                )[:80]
                prefix = "  " if key.startswith("~") else ""
                print(f"{prefix}{key}: {name} [{stype}]")
                if desc:
                    print(f"   {desc}")

            # Check if more pages available
            if total_seen >= total_size:
                break
            start += args.limit

        # Final summary
        print(f"Total spaces: {total_size}  (shown: {total_seen})")

    @staticmethod
    def read(opener: t.Any, args: argparse.Namespace) -> None:
        """Read a space by key."""
        data = _request_json(
            opener,
            f"/rest/api/space/{args.key}?expand=description.plan",
        )
        if args.raw:
            return _emit_json(data)

        key = data.get("key", "?")
        name = data.get("name", "?")
        stype = data.get("type", "?")
        desc = (data.get("description", {}).get("plain", {}).get("value", "") or "")[
            :200
        ]
        print(f"Space key:   {key}")
        print(f"Name:        {name}")
        print(f"Type:        {stype}")
        if desc:
            print(f"Description: {desc}")

    @staticmethod
    def create(opener: t.Any, args: argparse.Namespace) -> None:
        """Create a new space."""
        body = {
            "key": args.key,
            "name": args.name,
            "description": {"plain": args.description or ""},
        }
        data = _request_json(
            opener,
            "/rest/api/space",
            method="POST",
            body=body,
        )
        if args.raw:
            return _emit_json(data)

        name = data.get("name", args.name)
        key = data.get("key", args.key)
        print(f'Created space "{name}" (key={key})')

    @staticmethod
    def update(opener: t.Any, args: argparse.Namespace) -> None:
        """Update a space."""
        current = _request_json(
            opener,
            f"/rest/api/space/{args.key}?expand=description.plain",
        )
        current_name = current.get("name", "")
        current_desc = (
            current.get("description", {}).get("plain", {}).get("value", "") or ""
        )

        update_body: dict[str, t.Any] = {}
        if args.name is not None:
            update_body["name"] = args.name
        else:
            update_body["name"] = current_name

        if args.description is not None:
            update_body["description"] = {"plain": args.description}
        else:
            update_body["description"] = {"plain": current_desc}

        data = _request_json(
            opener,
            f"/rest/api/space/{args.key}",
            method="PUT",
            body=update_body,
        )
        if args.raw:
            return _emit_json(data)

        name = data.get("name", args.name or current_name)
        key = data.get("key", args.key)
        print(f'Updated space "{name}" (key={key})')

    @staticmethod
    def search(opener: t.Any, args: argparse.Namespace) -> None:
        """Search spaces by title or CQL."""
        if args.cql:
            cql = args.cql
        elif args.query:
            cql = 'type=space AND title~"' + args.query.replace('"', '\\"') + '"'
        else:
            sys.stderr.write("Provide a query or --cql argument\n")
            sys.exit(2)

        qs = urllib.parse.urlencode({"cql": cql, "limit": args.limit})
        data = _request_json(opener, f"/rest/api/search?{qs}")
        if args.raw:
            return _emit_json(data)

        total = data.get("totalSize", 0)
        print(f"Space search results: {total} total")

        for r in data.get("results", []):
            space = r.get("space") or {}
            key = space.get("key", "?")
            name = space.get("name", "?")
            desc = (
                space.get("description", {}).get("plain", {}).get("value", "") or ""
            )[:150]
            print(f"  [{key}] {name}")
            if desc:
                print(f"    {desc}")


class Pages:
    """Manage Confluence pages."""

    @staticmethod
    def list(opener: t.Any, args: argparse.Namespace) -> None:
        """List pages in a space."""
        qs = urllib.parse.urlencode(
            {
                "spaceKey": args.space_key,
                "limit": args.limit,
                "expand": "version,ancestors,children.page",
                "depth": "1",
            }
        )
        data = _request_json(opener, f"/rest/api/content?{qs}")
        if args.raw:
            return _emit_json(data)

        print(f"Total pages in {args.space_key}: {data.get('size', 0)}")

        for p in data.get("results", []):
            ancestors = p.get("ancestors", [])
            ancestor = ""
            if ancestors:
                ancestor = f" (child of: {ancestors[-1].get('title', '?')})"
            children_list = p.get("children", {}).get("page", {}).get("results", [])
            nchildren = len(children_list)
            children = f" (+{nchildren} children)" if nchildren else ""
            v = p.get("version", {}).get("number", "?")
            print(
                f"  [{p.get('id', '?')}] {p.get('title', '?')} v{v}{ancestor}{children}"
            )

    @staticmethod
    def search(opener: t.Any, args: argparse.Namespace) -> None:
        """Search pages by title or CQL."""
        if args.cql:
            cql = args.cql
        elif args.query:
            cql = 'title~"' + args.query.replace('"', '\\"') + '"'
        else:
            sys.stderr.write("Provide a query or --cql argument\n")
            sys.exit(2)

        qs = urllib.parse.urlencode({"cql": cql, "limit": args.limit})
        data = _request_json(opener, f"/rest/api/search?{qs}")
        if args.raw:
            return _emit_json(data)

        print(f"Search results: {data.get('totalSize', 0)} total")

        for r in data.get("results", []):
            content = r.get("content") or {}
            space_key = (content.get("space") or {}).get("key") or "?"
            pid = content.get("id") or "?"
            if pid == "?" and "pageId=" in r.get("url", ""):
                pid = r["url"].split("pageId=")[1].split("&")[0]
            lastmod = (r.get("lastModified") or "?")[:10]
            body_val = r.get("body", {}).get("view", {}).get("value", "")
            body_clean = _strip_tags(re.sub(r"@@@hl@@@|@@@endhl@@@", "", body_val))[
                :200
            ]
            print(
                f"  [{space_key}] {r.get('title', '?')} (id={pid}, modified={lastmod})"
            )
            if body_clean:
                print(f"    {body_clean}")

    @staticmethod
    def read(opener: t.Any, args: argparse.Namespace) -> None:
        """Read a single page by key or ID."""
        expand = "body.storage,version,space,ancestors,children.page"
        if args.key:
            qs = urllib.parse.urlencode({"key": args.key, "expand": expand})
            data = _request_json(opener, f"/rest/api/content?{qs}")
        elif args.id:
            qs = urllib.parse.urlencode({"expand": expand})
            data = _request_json(
                opener,
                f"/rest/api/content/{args.id}?{qs}",
            )
        else:
            sys.stderr.write("Provide --key or --id\n")
            sys.exit(2)

        if args.raw:
            return _emit_json(data)

        print(f"Title:   {data.get('title')}")
        print(f"Space:   {data.get('space', {}).get('key')}")
        print(f"ID:      {data.get('id')}")
        print(f"Version: {data.get('version', {}).get('number')}")

        for a in data.get("ancestors", []):
            print(f"  ancestor: {a.get('title')} (id={a.get('id')})")
        for c in data.get("children", {}).get("page", {}).get("results", []):
            print(f"  child:    {c.get('title')} (id={c.get('id')})")

        val = data.get("body", {}).get("storage", {}).get("value", "")
        if args.body_format == "html":
            print("\n--- Body (HTML) ---\n" + val)
        elif args.body_format == "text":
            print("\n--- Body (plain text) ---\n" + _strip_tags(val))
        else:
            clean = _strip_tags(val)
            print(f"\nBody: {len(clean)} chars")
            print(clean[:1000])
            if len(clean) > 1000:
                print(f"... ({len(clean) - 1000} more chars)")

    @staticmethod
    def create(opener: t.Any, args: argparse.Namespace) -> None:
        """Create a new page."""
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
        print(f"  URL: {BASE}/pages/viewpage.action?pageId={data.get('id')}")

    @staticmethod
    def update(opener: t.Any, args: argparse.Namespace) -> None:
        """Update an existing page."""
        page = _request_json(
            opener,
            f"/rest/api/content/{args.id}?expand=version",
        )
        version_number = page.get("version", {}).get("number", 1)

        payload: dict[str, t.Any] = {
            "id": args.id,
            "type": "page",
            "title": args.title or page.get("title", ""),
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
        print(f"  New version: {data.get('version', {}).get('number')}")


class Projects(Pages):
    """Manage project pages (wraps the Pages class)."""

    @staticmethod
    def list(opener: t.Any, args: argparse.Namespace) -> None:
        """List project pages."""
        Pages.list(opener, args)

    @staticmethod
    def read(opener: t.Any, args: argparse.Namespace) -> None:
        """Read a project page."""
        Pages.read(opener, args)

    @staticmethod
    def create(opener: t.Any, args: argparse.Namespace) -> None:
        """Create a project page with the Alexandra Way template."""
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
            "ancestor": {"id": _resolve_page_id(opener, "Projektoverblik", space_key="PROJ")},
        }

        data = _request_json(
            opener,
            "/rest/api/content",
            method="POST",
            body=payload,
        )
        if args.raw:
            return _emit_json(data)

        print(f"Created project page: {data.get('title')}")
        print(f"  ID:       {data.get('id')}")
        print(f"  URL:      {BASE}/pages/viewpage.action?pageId={data.get('id')}")
        print("  Template: The Alexandra Way (projektforkl\u00e6de)")

    @staticmethod
    def update(opener: t.Any, args: argparse.Namespace) -> None:
        """Update a project page."""
        Pages.update(opener, args)


class AiLabSlides:
    """Manage AI Lab slide deck entries on a Confluence page.

    The slide data lives in a single Confluence page containing
    multiple tables, each under an h1/h2 heading.  The parser
    extracts every table and associates it with the nearest
    preceding heading to determine the category.
    """

    @staticmethod
    def _extract_category_rows(
        body: str,
        cat_key: str,
    ) -> list[dict[str, str]] | None:
        """Extract rows for a given category key from the page body.

        Returns None if the heading is not found.
        """
        if cat_key not in _SLIDE_CATEGORIES:
            return None

        heading_text, _ = _SLIDE_CATEGORIES[cat_key]
        heading_match = None

        for m in re.finditer(
            r"<h[12][^>]*>(.*?)</h[12]>",
            body,
            re.DOTALL,
        ):
            if _clean_heading(m.group(1)) == heading_text:
                heading_match = m
                break

        if not heading_match:
            return None

        table_span = _find_table_in_section(body, heading_match.end())
        if table_span is None:
            return None

        return _extract_tbody_rows(
            table_start=table_span[0],
            table_end=table_span[1],
            body=body,
        )

    @staticmethod
    def read(opener: t.Any, args: argparse.Namespace) -> None:
        """Read a specific slide entry by ID or category+index."""
        if args.id:
            if ":" not in args.id:
                sys.stderr.write(
                    f"Invalid ID '{args.id}'. "
                    f"Use format: category:index (e.g. nlp:3)\n",
                )
                sys.exit(2)
            cat_key, idx_str = args.id.rsplit(":", 1)
            try:
                index = int(idx_str)
            except ValueError:
                sys.stderr.write(
                    f"Invalid index in ID '{args.id}'. Expected integer after ':'.\n",
                )
                sys.exit(2)
        elif args.category is not None and args.index is not None:
            cat_key = args.category.lower()
            index = args.index
        else:
            sys.stderr.write(
                "Provide --id (cat:index) or both --category and --index\n",
            )
            sys.exit(2)

        if cat_key not in _SLIDE_CATEGORIES:
            sys.stderr.write(
                f"Unknown category '{cat_key}'. "
                f"Valid: {', '.join(sorted(_SLIDE_CATEGORIES.keys()))}\n",
            )
            sys.exit(2)

        page = _request_json(
            opener,
            f"/rest/api/content/{_SLIDE_DECKS_PAGE_ID}?expand=body.view",
        )
        body = page["body"]["view"]["value"]
        heading_text, _ = _SLIDE_CATEGORIES[cat_key]

        rows = AiLabSlides._extract_category_rows(body, cat_key)
        if rows is None:
            sys.stderr.write(
                f"Could not find heading '{heading_text}' in page\n",
            )
            sys.exit(2)

        if index < 0 or index >= len(rows):
            sys.stderr.write(
                f"Index {index} out of range "
                f"(0-{len(rows) - 1}) in category '{cat_key}'\n",
            )
            sys.exit(2)

        if args.raw:
            return _emit_json(rows[index])

        row = rows[index]
        slide_id = f"{cat_key}:{index}"
        print(f'Slide {slide_id} in "{heading_text}":')
        parts = [
            row["date"],
            row["owner_key"],
            row["title"],
            row["language"],
            row["slides"],
        ]
        print(f"  {'  '.join(p for p in parts if p)}")
        slides = row.get("slides")
        if slides:
            encoded = urllib.parse.quote(slides)
            print(
                f"  Download: {BASE}/download/attachments/{_SLIDE_DECKS_PAGE_ID}/{encoded}"
            )

    @staticmethod
    def _insert_row_into_table(
        body: str,
        heading_text: str,
        new_row: str,
        note: str | None = None,
    ) -> tuple[str, int, int] | None:
        """Insert a new row into the table under *heading_text*.

        Returns ``(new_body, table_start, table_end)`` or ``None``.
        """
        heading_match = None
        for m in re.finditer(
            r"<h[12][^>]*>(.*?)</h[12]>",
            body,
            re.DOTALL,
        ):
            if _clean_heading(m.group(1)) == heading_text:
                heading_match = m
                break

        if not heading_match:
            return None

        table_span = _find_table_in_section(body, heading_match.end())
        if table_span is None:
            return None

        table_start, table_end = table_span
        full_table = body[table_start:table_end]

        tbody_start = full_table.find("<tbody")
        if tbody_start < 0:
            return None

        tbody_end = _find_depth_bound(
            full_table,
            "<tbody",
            "</tbody>",
            tbody_start,
        )
        if tbody_end < 0:
            return None

        new_full_table = (
            full_table[: table_end - tbody_end]
            + (full_table[tbody_start:tbody_end])
            + new_row
            + full_table[table_end - tbody_end :]
        )

        if note:
            note_row = _build_note_row(note)
            nt = new_full_table[tbody_start:tbody_end]
            nt_end = nt.find("</tbody>")
            if nt_end < 0:
                return None
            nt_open_len = new_full_table.find(">", tbody_start) + 1 - tbody_start
            nt_inner = nt[nt_open_len:-8]
            last_nt_tr = nt_inner.rfind("</tr>")
            if last_nt_tr >= 0:
                nt_new_inner = nt_inner[:last_nt_tr] + note_row + nt_inner[last_nt_tr:]
                nt_new = nt[:nt_open_len] + nt_new_inner + nt[nt_end:]
                new_full_table = (
                    new_full_table[:tbody_start] + nt_new + new_full_table[tbody_end:]
                )
            else:
                nt_new = nt[:nt_open_len] + note_row + nt[nt_end:]
                new_full_table = (
                    new_full_table[:tbody_start] + nt_new + new_full_table[tbody_end:]
                )

        new_body = body[:table_start] + new_full_table + body[table_end:]
        return new_body, table_start, table_end

    @staticmethod
    def create(opener: t.Any, args: argparse.Namespace) -> None:
        """Create a new slide entry."""
        category = args.category.lower()

        if category not in _SLIDE_CATEGORIES:
            sys.stderr.write(
                f"Unknown category '{category}'. "
                f"Valid: {', '.join(sorted(_SLIDE_CATEGORIES.keys()))}\n",
            )
            sys.exit(2)

        heading_text, _ = _SLIDE_CATEGORIES[category]

        page = _request_json(
            opener,
            f"/rest/api/content/{_SLIDE_DECKS_PAGE_ID}?expand=body.view,version",
        )
        version_number = page.get("version", {}).get("number", 1)
        body = page["body"]["view"]["value"]

        row = _build_slide_row(
            date=args.date,
            owner_key=args.owner_key,
            title=args.title,
            language=args.language,
            slides=args.slides,
        )

        result = AiLabSlides._insert_row_into_table(
            body=body,
            heading_text=heading_text,
            new_row=row,
            note=args.note,
        )
        if result is None:
            sys.stderr.write(
                f"Could not find heading '{heading_text}' in page\n",
            )
            sys.exit(2)

        new_body, table_start, table_end = result

        for attempt in range(3):
            current_page = _request_json(
                opener,
                f"/rest/api/content/{_SLIDE_DECKS_PAGE_ID}?expand=body.view,version",
            )
            version_number = current_page.get("version", {}).get("number", 1)

            payload: dict[str, t.Any] = {
                "id": _SLIDE_DECKS_PAGE_ID,
                "type": "page",
                "title": current_page.get("title", ""),
                "version": {"number": version_number + 1},
                "body": {
                    "view": {
                        "value": new_body,
                        "representation": "view",
                    },
                },
            }

            try:
                data = _request_json(
                    opener,
                    f"/rest/api/content/{_SLIDE_DECKS_PAGE_ID}",
                    method="PUT",
                    body=payload,
                )
                break
            except _ConfluenceError as e:
                if e.code == 409 and attempt < 2:
                    continue
                raise

        if args.raw:
            return _emit_json(data)

        print(f"Added slide to: {heading_text}")
        print(f"  Title: {args.title}")
        if args.date:
            print(f"  Date: {args.date}")
        if args.language:
            print(f"  Language: {args.language}")
        if args.slides:
            print(f"  Slides: {args.slides}")
        if args.note:
            print(f"  Note: {args.note}")
        print(f"  Page version: {data.get('version', {}).get('number')}")

    @staticmethod
    def update(opener: t.Any, args: argparse.Namespace) -> None:
        """Update an existing slide entry."""
        category = args.category.lower()

        if category not in _SLIDE_CATEGORIES:
            sys.stderr.write(
                f"Unknown category '{category}'. "
                f"Valid: {', '.join(sorted(_SLIDE_CATEGORIES.keys()))}\n",
            )
            sys.exit(2)

        heading_text, _ = _SLIDE_CATEGORIES[category]

        page = _request_json(
            opener,
            f"/rest/api/content/{_SLIDE_DECKS_PAGE_ID}?expand=body.view",
        )
        body = page["body"]["view"]["value"]

        rows = AiLabSlides._extract_category_rows(body, category)
        if rows is None:
            sys.stderr.write(
                f"Could not find heading '{heading_text}' in page\n",
            )
            sys.exit(2)

        index = args.index
        if index < 0 or index >= len(rows):
            sys.stderr.write(
                f"Index {index} out of range "
                f"(0-{len(rows) - 1}) for category '{category}'\n",
            )
            sys.exit(2)

        existing = rows[index]
        date = args.date if args.date is not None else existing["date"]
        owner_key = (
            args.owner_key if args.owner_key is not None else existing["owner_key"]
        )
        title = args.title if args.title is not None else existing["title"]
        language = args.language if args.language is not None else existing["language"]
        slides = args.slides if args.slides is not None else existing["slides"]

        new_row = _build_slide_row(
            date=date,
            owner_key=owner_key,
            title=title,
            language=language,
            slides=slides,
        )

        # Locate the nth <tr> in the tbody and replace it
        heading_match = None
        for m in re.finditer(
            r"<h[12][^>]*>(.*?)</h[12]>",
            body,
            re.DOTALL,
        ):
            if _clean_heading(m.group(1)) == heading_text:
                heading_match = m
                break

        if not heading_match:
            sys.stderr.write(
                f"Could not find heading '{heading_text}' in page\n",
            )
            sys.exit(2)

        table_span = _find_table_in_section(body, heading_match.end())
        if table_span is None:
            sys.stderr.write(
                f"No table found after heading '{heading_text}'\n",
            )
            sys.exit(2)

        table_start, table_end = table_span
        full_table = body[table_start:table_end]

        tbody_start = full_table.find("<tbody")
        if tbody_start < 0:
            sys.stderr.write(
                f"No <tbody> found in table for '{heading_text}'\n",
            )
            sys.exit(2)

        tbody_end = _find_depth_bound(
            full_table,
            "<tbody",
            "</tbody>",
            tbody_start,
        )
        if tbody_end < 0:
            sys.stderr.write(
                f"No matching </tbody> found for '{heading_text}'\n",
            )
            sys.exit(2)

        tbody = full_table[tbody_start:tbody_end]
        tbody_open = tbody.find(">") + 1
        tbody_content = tbody[tbody_open:-8]

        tr_opens = [
            (m.start(), m.end())
            for m in re.finditer(
                r"<tr(?:[^>]*)?>",
                tbody_content,
                re.IGNORECASE,
            )
        ]
        tr_closes = [
            (m.start(), m.end())
            for m in re.finditer(r"</tr>", tbody_content, re.IGNORECASE)
        ]

        tr_ranges: list[tuple[int, int]] = []
        open_stack: list[int] = []
        for pos, end in tr_opens:
            open_stack.append(pos)
        for pos, end in tr_closes:
            if open_stack:
                start = open_stack.pop(0)
                tr_ranges.append((start, pos + end))

        if index >= len(tr_ranges):
            sys.stderr.write(
                f"Index {index} out of range "
                f"({len(tr_ranges)} rows) for category '{category}'\n",
            )
            sys.exit(2)

        start, end = tr_ranges[index]
        new_tbody_content = tbody_content[:start] + new_row + tbody_content[end:]
        new_tbody = (
            tbody[:tbody_open]
            + new_tbody_content
            + tbody[tbody_open + len(tbody_content) :]
        )
        new_full_table = full_table[:tbody_start] + new_tbody + full_table[tbody_end:]
        new_body = body[:table_start] + new_full_table + body[table_end:]

        # Handle note row
        if args.note:
            note_row = _build_note_row(args.note)
            nt = new_full_table[tbody_start:tbody_end]
            nt_end = nt.find("</tbody>")
            if nt_end < 0:
                return
            nt_open_len = new_full_table.find(">", tbody_start) + 1 - tbody_start
            nt_inner = nt[nt_open_len:-8]
            last_nt_tr = nt_inner.rfind("</tr>")
            if last_nt_tr >= 0:
                nt_new_inner = nt_inner[:last_nt_tr] + note_row + nt_inner[last_nt_tr:]
                nt_new = nt[:nt_open_len] + nt_new_inner + nt[nt_end:]
                new_full_table = (
                    new_full_table[:tbody_start] + nt_new + new_full_table[tbody_end:]
                )
                new_body = body[:table_start] + new_full_table + body[table_end:]

        for attempt in range(3):
            current_page = _request_json(
                opener,
                f"/rest/api/content/{_SLIDE_DECKS_PAGE_ID}?expand=body.view,version",
            )
            version_number = current_page.get("version", {}).get("number", 1)

            payload: dict[str, t.Any] = {
                "id": _SLIDE_DECKS_PAGE_ID,
                "type": "page",
                "title": current_page.get("title", ""),
                "version": {"number": version_number + 1},
                "body": {
                    "view": {
                        "value": new_body,
                        "representation": "view",
                    },
                },
            }

            try:
                data = _request_json(
                    opener,
                    f"/rest/api/content/{_SLIDE_DECKS_PAGE_ID}",
                    method="PUT",
                    body=payload,
                )
                break
            except _ConfluenceError as e:
                if e.code == 409 and attempt < 2:
                    continue
                raise

        if args.raw:
            return _emit_json(data)

        print(f"Updated slide [{index}] in: {heading_text}")
        print(f"  Title: {title}")
        if date:
            print(f"  Date: {date}")
        if language:
            print(f"  Language: {language}")
        if slides:
            print(f"  Slides: {slides}")
        if args.note:
            print(f"  Note: {args.note}")
        print(f"  Page version: {data.get('version', {}).get('number')}")

    @staticmethod
    def list(opener: t.Any, args: argparse.Namespace) -> None:
        """List all slides across all categories by extracting every
        <table> on the page and associating each with its nearest
        preceding heading.
        """
        page = _request_json(
            opener,
            f"/rest/api/content/{_SLIDE_DECKS_PAGE_ID}?expand=body.view",
        )
        body = page["body"]["view"]["value"]

        heading_map = _build_heading_to_cat_map(body)
        heading_positions = [m.start() for m in re.finditer(r"<h[12]", body)]

        table_positions: list[tuple[int, int]] = []
        for m in re.finditer(r"<table", body):
            start = m.start()
            depth = 0
            end = -1
            for i in range(start, len(body)):
                if body[i : i + 6] == "<table":
                    depth += 1
                elif body[i : i + 8] == "</table>":
                    depth -= 1
                    if depth == 0:
                        end = i + 8
                        break
            if end > 0:
                table_positions.append((start, end))

        all_rows: list[dict[str, t.Any]] = []
        seen_ids: set[str] = set()

        for t_start, t_end in table_positions:
            tbody_rows = _extract_tbody_rows(t_start, t_end, body)
            if tbody_rows is None:
                continue

            heading_text = _find_nearest_heading(
                heading_positions,
                t_start,
                body,
            )
            if heading_text is None:
                continue

            cat_key = heading_map.get(heading_text)
            if cat_key is None:
                for ck, (ht, _) in _SLIDE_CATEGORIES.items():
                    if ht == heading_text:
                        cat_key = ck
                        heading_map[heading_text] = cat_key
                        break
            if cat_key is None:
                continue

            for idx, row in enumerate(tbody_rows):
                eid = f"{cat_key}:{idx}"
                if eid in seen_ids:
                    continue
                seen_ids.add(eid)
                entry = dict(row)
                entry["_id"] = eid
                entry["_category"] = cat_key
                entry["_heading"] = heading_text
                all_rows.append(entry)

        if args.raw:
            return _emit_json(all_rows)

        total = len(all_rows)
        print(f"All slides: {total}")
        for r in all_rows:
            heading_text = r.get("_heading", "?")
            parts = [
                r["date"],
                r["owner_key"],
                r["title"],
                r["language"],
                r["slides"],
            ]
            print(
                f"  [{r['_id']}] [{heading_text}]  {'  '.join(p for p in parts if p)}"
            )

    @staticmethod
    def search(opener: t.Any, args: argparse.Namespace) -> None:
        """Search slides across all categories, returning unique IDs."""
        if args.cql:
            cql = args.cql
            qs = urllib.parse.urlencode({"cql": cql, "limit": 50})
            search_results = _request_json(
                opener,
                f"/rest/api/search?{qs}",
            )
            matching_ids = {
                r.get("content", {}).get("id")
                for r in search_results.get("results", [])
            }
            if not matching_ids or _SLIDE_DECKS_PAGE_ID not in matching_ids:
                print("No results found from slide decks page.")
                return
        elif args.query:
            search_term = args.query.lower()
        else:
            sys.stderr.write("Provide a query or --cql argument\n")
            sys.exit(2)

        page = _request_json(
            opener,
            f"/rest/api/content/{_SLIDE_DECKS_PAGE_ID}?expand=body.view",
        )
        body = page["body"]["view"]["value"]

        heading_map = _build_heading_to_cat_map(body)
        heading_positions = [m.start() for m in re.finditer(r"<h[12]", body)]

        table_positions: list[tuple[int, int]] = []
        for m in re.finditer(r"<table", body):
            start = m.start()
            depth = 0
            end = -1
            for i in range(start, len(body)):
                if body[i : i + 6] == "<table":
                    depth += 1
                elif body[i : i + 8] == "</table>":
                    depth -= 1
                    if depth == 0:
                        end = i + 8
                        break
            if end > 0:
                table_positions.append((start, end))

        all_rows: list[dict[str, t.Any]] = []
        seen_ids: set[str] = set()

        for t_start, t_end in table_positions:
            tbody_rows = _extract_tbody_rows(t_start, t_end, body)
            if tbody_rows is None:
                continue

            heading_text = _find_nearest_heading(
                heading_positions,
                t_start,
                body,
            )
            if heading_text is None:
                continue

            cat_key = heading_map.get(heading_text)
            if cat_key is None:
                for ck, (ht, _) in _SLIDE_CATEGORIES.items():
                    if ht == heading_text:
                        cat_key = ck
                        heading_map[heading_text] = cat_key
                        break
            if cat_key is None:
                continue

            for idx, row in enumerate(tbody_rows):
                eid = f"{cat_key}:{idx}"
                if eid in seen_ids:
                    continue
                seen_ids.add(eid)
                entry = dict(row)
                entry["_id"] = eid
                entry["_category"] = cat_key
                entry["_heading"] = heading_text

                if args.cql:
                    all_rows.append(entry)
                else:
                    searchable = (
                        f"{row['title']} "
                        f"{row['owner_key']} "
                        f"{row['date']} "
                        f"{row['language']} "
                        f"{row['slides']}"
                    ).lower()
                    if search_term in searchable:
                        all_rows.append(entry)

        if args.raw:
            return _emit_json(all_rows)

        if not all_rows:
            print("No slides found matching the query.")
            return

        print(f"Search results: {len(all_rows)} matching slides")
        for r in all_rows:
            heading_text = r.get("_heading", "?")
            parts = [
                r["date"],
                r["owner_key"],
                r["title"],
                r["language"],
                r["slides"],
            ]
            print(
                f"  [{r['_id']}] [{heading_text}]  {'  '.join(p for p in parts if p)}"
            )


# ── Top-level helpers ────────────────────────────────────────────────


def cmd_whoami(opener: t.Any, args: argparse.Namespace) -> None:
    """Show current user."""
    data = _request_json(
        opener,
        "/rest/api/user/current?expand=fullName,displayName,userkey",
    )
    if args.raw:
        return _emit_json(data)
    print(f"Username:  {data.get('username')}")
    print(f"Display:   {data.get('displayName')}")
    print(f"User key:  {data.get('userKey')}")
    print(f"Full name: {data.get('fullName', '-')}")


def cmd_auth(opener: t.Any, args: argparse.Namespace) -> None:
    """Force re-auth: clear creds + cookies, then login."""
    global _cached_creds
    _cached_creds = None
    if COOKIE_FILE.exists():
        COOKIE_FILE.unlink()
    _clear_jar(opener)
    _authenticate(opener)
    print("Authenticated successfully. Cookies saved.")


# ── Dispatch table ───────────────────────────────────────────────────

dispatch: dict[tuple[str, str | None], c.Callable[..., None]] = {
    ("spaces", "list"): Spaces.list,
    ("spaces", "read"): Spaces.read,
    ("spaces", "create"): Spaces.create,
    ("spaces", "update"): Spaces.update,
    ("spaces", "search"): Spaces.search,
    ("pages", "list"): Pages.list,
    ("pages", "search"): Pages.search,
    ("pages", "read"): Pages.read,
    ("pages", "create"): Pages.create,
    ("pages", "update"): Pages.update,
    ("projects", "list"): Projects.list,
    ("projects", "read"): Projects.read,
    ("projects", "create"): Projects.create,
    ("projects", "update"): Projects.update,
    ("ai-lab-slides", "read"): AiLabSlides.read,
    ("ai-lab-slides", "create"): AiLabSlides.create,
    ("ai-lab-slides", "update"): AiLabSlides.update,
    ("ai-lab-slides", "list"): AiLabSlides.list,
    ("ai-lab-slides", "search"): AiLabSlides.search,
    ("whoami", None): cmd_whoami,
    ("auth", None): cmd_auth,
}


# ── Argument parser ──────────────────────────────────────────────────


def _build_parser() -> argparse.ArgumentParser:
    """Build and return the CLI argument parser."""
    parser = argparse.ArgumentParser(
        description="CLI for Alexandra's Confluence.",
    )
    sub = parser.add_subparsers(dest="resource", required=True)

    def _raw(p: argparse.ArgumentParser) -> None:
        p.add_argument("--raw", action="store_true")

    # ── spaces ──
    p = sub.add_parser("spaces", help="Manage spaces")
    sp = p.add_subparsers(dest="operation", required=True)

    pl = sp.add_parser("list", help="List all spaces")
    pl.add_argument("--limit", type=int, default=1000)
    pl.add_argument("--start", type=int, default=0)
    _raw(pl)

    pr = sp.add_parser("read", help="Read a space by key")
    pr.add_argument("--key", required=True)
    _raw(pr)

    pc = sp.add_parser("create", help="Create a new space")
    pc.add_argument("--key", required=True)
    pc.add_argument("--name", required=True)
    pc.add_argument("--description", help="Plain text description")
    _raw(pc)

    pu = sp.add_parser("update", help="Update a space")
    pu.add_argument("--key", required=True)
    pu.add_argument("--name", help="New name")
    pu.add_argument(
        "--description",
        help="New plain text description",
    )
    _raw(pu)

    ss = sp.add_parser("search", help="Search spaces")
    ss.add_argument("query", nargs="?", help="Title search shorthand")
    ss.add_argument(
        "--cql",
        help="Full CQL query (overrides query)",
    )
    ss.add_argument("--limit", type=int, default=20)
    _raw(ss)

    # ── pages ──
    p = sub.add_parser("pages", help="Manage pages")
    pp = p.add_subparsers(dest="operation", required=True)

    pl = pp.add_parser("list", help="List pages in a space")
    pl.add_argument("--space-key", required=True)
    pl.add_argument("--limit", type=int, default=20)
    _raw(pl)

    ps = pp.add_parser("search", help="Search pages")
    ps.add_argument("query", nargs="?", help="Title search shorthand")
    ps.add_argument("--cql", help="Full CQL query (overrides query)")
    ps.add_argument("--limit", type=int, default=20)
    _raw(ps)

    pr = pp.add_parser("read", help="Read a single page by key or ID")
    pg_group = pr.add_mutually_exclusive_group(required=True)
    pg_group.add_argument("--key")
    pg_group.add_argument("--id")
    pr.add_argument(
        "--body-format",
        choices=["auto", "text", "html"],
        default="auto",
        dest="body_format",
    )
    _raw(pr)

    pc = pp.add_parser("create", help="Create a new page")
    pc.add_argument("--space-key", required=True)
    pc.add_argument("--title", required=True)
    pc.add_argument("--body", required=True)
    pc.add_argument("--parent", help="Parent page ID")
    _raw(pc)

    pu = pp.add_parser("update", help="Update an existing page")
    pu.add_argument("--id", required=True)
    pu.add_argument("--body", required=True)
    pu.add_argument("--title", help="New title (optional)")
    pu.add_argument("--minor-edit", action="store_true")
    _raw(pu)

    # ── projects ──
    p = sub.add_parser("projects", help="Manage projects")
    pj = p.add_subparsers(dest="operation", required=True)

    pj_list = pj.add_parser("list", help="List project pages")
    pj_list.add_argument("--space-key", default="PROJ")
    pj_list.add_argument("--limit", type=int, default=20)
    _raw(pj_list)

    pj_read = pj.add_parser("read", help="Read a project page")
    pj_read_grp = pj_read.add_mutually_exclusive_group(required=True)
    pj_read_grp.add_argument("--key")
    pj_read_grp.add_argument("--id")
    pj_read.add_argument(
        "--body-format",
        choices=["auto", "text", "html"],
        default="auto",
        dest="body_format",
    )
    _raw(pj_read)

    pj_create = pj.add_parser(
        "create",
        help="Create a project page with Alexandra Way template",
    )
    pj_create.add_argument("--space-key", default="PROJ")
    pj_create.add_argument("--title", required=True)
    pj_create.add_argument("--client", required=True)
    pj_create.add_argument("--owner", required=True)
    pj_create.add_argument("--budget", default="Ikke fastsat")
    _raw(pj_create)

    pj_update = pj.add_parser("update", help="Update a project page")
    pj_update.add_argument("--id", required=True)
    pj_update.add_argument("--body", required=True)
    pj_update.add_argument("--title", help="New title (optional)")
    pj_update.add_argument("--minor-edit", action="store_true")
    _raw(pj_update)

    # ── ai-lab-slides ──
    p = sub.add_parser(
        "ai-lab-slides",
        help="Manage AI Lab slide deck entries",
    )
    alp = p.add_subparsers(dest="operation", required=True)

    alp_read = alp.add_parser(
        "read",
        help="Read a specific slide entry by ID",
    )
    grp = alp_read.add_mutually_exclusive_group(required=True)
    grp.add_argument(
        "--id",
        help="Slide ID in cat:index format (e.g. nlp:3)",
    )
    grp.add_argument("--category", help="Category key")
    alp_read.add_argument(
        "--index",
        type=int,
        help="0-based index within category",
    )
    _raw(alp_read)

    alp_create = alp.add_parser(
        "create",
        help="Create a new slide entry",
    )
    alp_create.add_argument(
        "--category",
        required=True,
        help=(
            "Category: about-us, themed, client, courses, "
            "presentations, nlp, energy, healthcare, iot"
        ),
    )
    alp_create.add_argument(
        "--title",
        required=True,
        help="Title / Description",
    )
    alp_create.add_argument("--date", help="Date (YYYY-MM-DD)")
    alp_create.add_argument(
        "--owner-key",
        help="Confluence user key",
    )
    alp_create.add_argument(
        "--language",
        help="Language code (DA, EN, FR, etc.)",
    )
    alp_create.add_argument(
        "--slides",
        help="Attachment filename or link",
    )
    alp_create.add_argument("--note", help="Extra note")
    _raw(alp_create)

    alp_update = alp.add_parser(
        "update",
        help="Update a slide entry",
    )
    alp_update.add_argument("--category", required=True)
    alp_update.add_argument(
        "--index",
        type=int,
        required=True,
        help="0-based index of the slide row to update",
    )
    alp_update.add_argument("--title", help="New title / Description")
    alp_update.add_argument("--date", help="New date (YYYY-MM-DD)")
    alp_update.add_argument(
        "--owner-key",
        help="New Confluence user key",
    )
    alp_update.add_argument("--language", help="New language code")
    alp_update.add_argument(
        "--slides",
        help="New attachment filename or link",
    )
    alp_update.add_argument("--note", help="New note")
    _raw(alp_update)

    alist = alp.add_parser(
        "list",
        help="List all slides across all categories",
    )
    _raw(alist)

    all_s = alp.add_parser(
        "search",
        help="Search slides across all categories",
    )
    all_s.add_argument(
        "query",
        nargs="?",
        help="Title search shorthand",
    )
    all_s.add_argument(
        "--cql",
        help="Full CQL query (overrides query)",
    )
    _raw(all_s)

    # ── whoami ──
    whoami_p = sub.add_parser("whoami", help="Show current user")
    _raw(whoami_p)

    # ── auth ──
    auth_p = sub.add_parser("auth", help="Force re-authentication")
    _raw(auth_p)

    return parser


# ── Entry point ──────────────────────────────────────────────────────


def main() -> None:
    _load_env(Path(".env"))
    parser = _build_parser()
    args = parser.parse_args()

    resource = args.resource
    operation = getattr(args, "operation", None)
    func = dispatch.get((resource, operation))
    if func is None:
        sys.stderr.write(
            f"Unknown command: {resource}"
            + (f" {operation}" if operation else "")
            + "\n",
        )
        sys.exit(2)
    _run_cmd(func, args)


if __name__ == "__main__":
    main()
