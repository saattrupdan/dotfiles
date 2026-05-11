#!/usr/bin/env python3
"""HTTP helpers for Confluence API calls.

Handles retries with exponential backoff for transient failures.
"""

from __future__ import annotations

import json
import sys
import time
import typing as t
import urllib.error
import urllib.request

from .auth import BASE, INITIAL_BACKOFF, MAX_RETRIES, _ConfluenceError, UA


def _request(
    opener: urllib.request.OpenerDirector,
    path: str,
    method: str = "GET",
    body: dict | None = None,
) -> tuple[int, t.Any]:
    """Send an HTTP request with retry logic.

    Args:
        opener: HTTP opener with authenticated session.
        path: URL path or full URL.
        method: HTTP method.
        body: Request body dict (JSON-encoded).

    Returns:
        Tuple of (status_code, response_data).

    Raises:
        _ConfluenceError: On non-retryable errors or exhausted retries.
    """
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
    """Send a JSON request and return parsed response body.

    Args:
        opener: HTTP opener with authenticated session.
        path: URL path or full URL.
        method: HTTP method.
        body: Request body dict.

    Returns:
        Parsed JSON response data.
    """
    _, result = _request(opener, path, method=method, body=body)
    if isinstance(result, dict) and "statusCode" in result:
        raise _ConfluenceError(
            result.get("statusCode", 0),
            json.dumps(result, ensure_ascii=False),
        )
    return result
