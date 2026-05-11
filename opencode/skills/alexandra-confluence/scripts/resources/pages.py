#!/usr/bin/env python3
"""Resource handler for Confluence pages.

Provides list, search, read, create, and update operations on pages.
"""

from __future__ import annotations

import re
import sys
import typing as t
import urllib.parse

from ..auth import _ConfluenceError
from ..http import _request_json
from ..utils.parsing import emit_json, strip_tags


class Pages:
    """Manage Confluence pages."""

    @staticmethod
    def size(opener: t.Any, args: t.Any) -> None:
        """Total number of pages across all spaces."""
        data = _request_json(
            opener,
            "/rest/api/search?cql=type%3Dpage&limit=0",
        )
        total = data.get("totalSize", 0)
        if args.raw:
            return emit_json({"total_pages": total})
        print(total)

    @staticmethod
    def list(opener: t.Any, args: t.Any) -> None:
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
            return emit_json(data)

        print(f"Total pages in {args.space_key}: {data.get('size', 0)}")

        for p in data.get("results", []):
            ancestors = p.get("ancestors", [])
            ancestor = ""
            if ancestors:
                ancestor = (
                    f" (child of: {ancestors[-1].get('title', '?')})"
                )
            children_list = (
                p.get("children", {})
                .get("page", {})
                .get("results", [])
            )
            nchildren = len(children_list)
            children = f" (+{nchildren} children)" if nchildren else ""
            v = p.get("version", {}).get("number", "?")
            print(
                f"  [{p.get('id', '?')}] "
                f"{p.get('title', '?')} v{v}{ancestor}{children}"
            )

    @staticmethod
    def search(opener: t.Any, args: t.Any) -> None:
        """Search pages by title or CQL."""
        if args.cql:
            cql = args.cql
        elif args.query:
            cql = 'title~"' + args.query.replace('"', '\\"') + '"'
        else:
            sys.stderr.write("Provide a query or --cql argument\n")
            sys.exit(2)

        api_limit = min(args.limit, 100)
        start = 0
        total_size = 0
        shown = 0

        while True:
            qs = urllib.parse.urlencode({
                "cql": cql,
                "limit": api_limit,
                "start": start,
            })
            data = _request_json(opener, f"/rest/api/search?{qs}")

            if total_size == 0:
                total_size = data.get("totalSize", 0)

            if args.raw:
                for r in data.get("results", []):
                    emit_json(r)
                if shown >= total_size:
                    break
                shown += len(data.get("results", []))
                start += api_limit
                continue

            if start == 0:
                print(f"Search results: {total_size} total")

            for r in data.get("results", []):
                content = r.get("content") or {}
                space_key = (content.get("space") or {}).get("key") or "?"
                pid = content.get("id") or "?"
                if pid == "?" and "pageId=" in r.get("url", ""):
                    pid = r["url"].split("pageId=")[1].split("&")[0]
                lastmod = (r.get("lastModified") or "?")[:10]
                body_val = r.get("body", {}).get("view", {}).get("value", "")
                body_clean = strip_tags(
                    re.sub(r"@@@hl@@@|@@@endhl@@@", "", body_val)
                )[:200]
                print(
                    f"  [{space_key}] "
                    f"{r.get('title', '?')} "
                    f"(id={pid}, modified={lastmod})"
                )
                if body_clean:
                    print(f"    {body_clean}")

            shown += len(data.get("results", []))
            if shown >= total_size:
                break
            start += api_limit

    @staticmethod
    def read(opener: t.Any, args: t.Any) -> None:
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
            return emit_json(data)

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
            print("\n--- Body (plain text) ---\n" + strip_tags(val))
        else:
            clean = strip_tags(val)
            print(f"\nBody: {len(clean)} chars")
            print(clean[:1000])
            if len(clean) > 1000:
                print(f"... ({len(clean) - 1000} more chars)")

    @staticmethod
    def create(opener: t.Any, args: t.Any) -> None:
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
            return emit_json(data)

        from ..auth import BASE

        print(f"Created page: {data.get('title')}")
        print(f"  ID:  {data.get('id')}")
        print(
            f"  URL: "
            f"{BASE}/pages/viewpage.action?pageId={data.get('id')}"
        )

    @staticmethod
    def update(opener: t.Any, args: t.Any) -> None:
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
            return emit_json(data)

        print(f"Updated page: {data.get('title')}")
        print(
            f"  New version: "
            f"{data.get('version', {}).get('number')}"
        )
