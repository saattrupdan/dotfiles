#!/usr/bin/env python3
"""Dispatch table mapping CLI commands to handler functions."""

from __future__ import annotations

import collections.abc as c
import typing as t

from .resources.spaces import Spaces
from .resources.pages import Pages
from .resources.projects import Projects
from .resources.slides_query import AiLabSlides
from .resources.slides_write import AiLabSlidesWrite


def build_dispatch() -> dict[tuple[str, str | None], c.Callable[..., None]]:
    """Build and return the command dispatch table.

    Returns:
        Dict mapping (resource, operation) to handler functions.
    """
    return {
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
        ("ai-lab-slides", "create"): AiLabSlidesWrite.create,
        ("ai-lab-slides", "update"): AiLabSlidesWrite.update,
        ("ai-lab-slides", "list"): AiLabSlides.list,
        ("ai-lab-slides", "search"): AiLabSlides.search,
        ("whoami", None): cmd_whoami,
        ("auth", None): cmd_auth,
    }


def cmd_whoami(opener: t.Any, args: t.Any) -> None:
    """Show current user."""
    from ..http import _request_json
    from ..utils.parsing import emit_json

    data = _request_json(
        opener,
        "/rest/api/user/current?expand=fullName,displayName,userkey",
    )
    if args.raw:
        return emit_json(data)
    print(f"Username:  {data.get('username')}")
    print(f"Display:   {data.get('displayName')}")
    print(f"User key:  {data.get('userKey')}")
    print(f"Full name: {data.get('fullName', '-')}")


def cmd_auth(opener: t.Any, args: t.Any) -> None:
    """Force re-auth: clear creds + cookies, then login."""
    from ..auth import (
        COOKIE_FILE,
        _authenticate,
        _cached_creds,
        _clear_jar,
    )

    global _cached_creds
    _cached_creds = None
    if COOKIE_FILE.exists():
        COOKIE_FILE.unlink()
    _clear_jar(opener)
    _authenticate(opener)
    print("Authenticated successfully. Cookies saved.")
