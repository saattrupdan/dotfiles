#!/usr/bin/env python3
"""Authentication and session management for Confluence CLI.

Handles form-login, cookie persistence, credential loading, and
automatic re-authentication on session expiry.
"""

from __future__ import annotations

import getpass
import http.cookiejar
import os
import re
import sys
import time
import typing as t
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from ._constants import (
    BASE,
    INITIAL_BACKOFF,
    MAX_RETRIES,
    UA,
    _ConfluenceError,
)
from .http import _request_json


COOKIE_DIR: Path = Path.home() / ".alexandra-confluence"
COOKIE_FILE: Path = COOKIE_DIR / "cookies.txt"
_SLIDE_DECKS_PAGE_ID: str = "97042311"
PROJ_ANCESTOR_ID: str = "208044217"  # "Projektoverblik (The Alexandra Way)"

_KNOWN_CATEGORIES: dict[str, tuple[str, str]] = {
    "about-us": ("1. About Us presentations", "date"),
    "themed": ("2. Themed presentation", "date"),
    "themed-general": (
        "2.1. General presentation about AI / AI potential checks",
        "date",
    ),
    "nlp": ("2.2. NLP", "date"),
    "energy": ("2.3. Energy, Utilities & Construction", "date"),
    "healthcare": ("2.4. Healthcare", "date"),
    "iot": ("2.5. IoT / Anomaly detections", "date"),
    "client": ("3. Client Presentations", "date"),
    "courses": ("4. Courses / workshops", "date"),
    "presentations": ('5. Presentions ("opl\u00e6g")', "date"),
    "legacy": ("6. Legacy presentation Links", "date"),
}


# ── Exception ────────────────────────────────────────────────────────


# ── Credential loading ──────────────────────────────────────────────

_cached_creds: tuple[str, str] | None = None


def _load_env(env_path: Path) -> None:
    """Parse a simple .env file and set KEY=VALUE pairs into os.environ.

    Skips blank lines and lines beginning with '#'.  Strips surrounding
    single or double quotes from values.  Silently passes if the file
    does not exist or cannot be read.

    Args:
        env_path: Path to the .env file.
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
    """Get Confluence credentials from env vars, .env file, or prompts.

    Returns:
        Tuple of (username, password).
    """
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
    """Check if credentials are available via environment variables.

    Returns:
        True if both CONFLUENCE_USER and CONFLUENCE_PASS are set.
    """
    return bool(
        os.environ.get("CONFLUENCE_USER") and os.environ.get("CONFLUENCE_PASS")
    )


# ── Cookie management ───────────────────────────────────────────────


def _build_jar() -> http.cookiejar.MozillaCookieJar:
    """Build a cookie jar, loading persisted cookies if available.

    Returns:
        MozillaCookieJar instance.
    """
    COOKIE_DIR.mkdir(parents=True, exist_ok=True)
    cj = http.cookiejar.MozillaCookieJar(str(COOKIE_FILE))
    if COOKIE_FILE.exists():
        try:
            cj.load(ignore_discard=True, ignore_expires=True)
        except (OSError, http.cookiejar.LoadError):
            pass
    return cj


def _clear_jar(opener: urllib.request.OpenerDirector) -> None:
    """Clear all cookies from the opener's cookie jar.

    Args:
        opener: HTTP opener with a HTTPCookieProcessor handler.
    """
    for h in opener.handlers:
        if isinstance(h, urllib.request.HTTPCookieProcessor):
            h.cookiejar.clear()
            return


# ── Authentication ──────────────────────────────────────────────────


def _authenticate(opener: urllib.request.OpenerDirector) -> None:
    """Perform form-login authentication.

    Sets fresh session cookies on the opener's jar.
    Retries transient failures up to MAX_RETRIES times with exponential backoff.

    Args:
        opener: HTTP opener with a cookie jar.
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
                    f"Auth session GET {e.code} "
                    f"(retry {attempt + 1}/{MAX_RETRIES})\n",
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
                    f"Auth session network error "
                    f"(retry {attempt + 1}/{MAX_RETRIES})\n",
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
                    f"Auth login GET {e.code} "
                    f"(retry {attempt + 1}/{MAX_RETRIES})\n",
                )
                time.sleep(INITIAL_BACKOFF * (2**attempt))
                continue
            sys.stderr.write(f"HTTP {e.code} on GET /login.action\n")
            sys.exit(2)
        except urllib.error.URLError as e:
            if attempt < MAX_RETRIES:
                sys.stderr.write(
                    f"Auth login network error "
                    f"(retry {attempt + 1}/{MAX_RETRIES})\n",
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
                    f"Auth login POST {e.code} "
                    f"(retry {attempt + 1}/{MAX_RETRIES})\n",
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


# ── Page ID resolution ──────────────────────────────────────────────

_page_id_cache: dict[str, str] = {}


def resolve_page_id(
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


# ── Command runner ──────────────────────────────────────────────────


def run_cmd(
    func: t.Callable[..., None],
    args: t.Any,
) -> None:
    """Execute a command with cookie persistence and auto-re-auth.

    Reuses persisted cookies; on session expiry re-authenticates
    and retries once.

    Args:
        func: Command function to execute.
        args: Parsed CLI arguments namespace.
    """
    cj = _build_jar()
    opener = urllib.request.build_opener(
        urllib.request.HTTPCookieProcessor(cj)
    )
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
