#!/usr/bin/env python3
"""Resource handler for Confluence spaces."""

from __future__ import annotations

import sys
import typing as t
import urllib.parse

from ..auth import _ConfluenceError
from ..http import _request_json
from ..utils.parsing import emit_json


class Spaces:
    """Manage Confluence spaces."""

    @staticmethod
    def size(opener: t.Any, args: t.Any) -> None:
        """Total number of spaces."""
        api_limit = 100
        start = 0
        total = 0
        while True:
            qs = urllib.parse.urlencode(
                {"limit": api_limit, "start": start},
            )
            data = _request_json(opener, f"/rest/api/space?{qs}")
            total += data.get("size", 0)
            if len(data.get("results", [])) < api_limit:
                break
            start += api_limit
        if args.raw:
            return emit_json({"total_spaces": total})
        print(total)

    @staticmethod
    def list(opener: t.Any, args: t.Any) -> None:
        """List all spaces with auto-pagination."""
        start = args.start
        total_seen = 0
        api_limit = min(args.limit, 100)

        while True:
            qs = urllib.parse.urlencode(
                {
                    "expand": "description.plain",
                    "limit": api_limit,
                    "start": start,
                }
            )
            data = _request_json(opener, f"/rest/api/space?{qs}")

            results = data.get("results", [])
            total_seen += len(results)

            if args.raw:
                for s in results:
                    emit_json(s)
                if len(results) < api_limit:
                    break
                start += api_limit
                continue

            if start == args.start:
                print(
                    f"Total spaces: ?  "
                    f"(showing {start}-{start + total_seen})"
                )

            for s in results:
                key = s.get("key", "?")
                name = s.get("name", "?")
                stype = s.get("type", "?")
                desc = (
                    s.get("description", {})
                    .get("plain", {})
                    .get("value", "")
                    or ""
                )[:80]
                prefix = "  " if key.startswith("~") else ""
                print(f"{prefix}{key}: {name} [{stype}]")
                if desc:
                    print(f"   {desc}")

            if len(results) < api_limit:
                break
            start += api_limit

        print(f"Total spaces: {total_seen}  (shown: {total_seen})")

    @staticmethod
    def read(opener: t.Any, args: t.Any) -> None:
        """Read a space by key."""
        data = _request_json(
            opener,
            f"/rest/api/space/{args.key}?expand=description.plan",
        )
        if args.raw:
            return emit_json(data)

        key = data.get("key", "?")
        name = data.get("name", "?")
        stype = data.get("type", "?")
        desc = (
            data.get("description", {})
            .get("plain", {})
            .get("value", "")
            or ""
        )[:200]
        print(f"Space key:   {key}")
        print(f"Name:        {name}")
        print(f"Type:        {stype}")
        if desc:
            print(f"Description: {desc}")

    @staticmethod
    def create(opener: t.Any, args: t.Any) -> None:
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
            return emit_json(data)

        name = data.get("name", args.name)
        key = data.get("key", args.key)
        print(f'Created space "{name}" (key={key})')

    @staticmethod
    def update(opener: t.Any, args: t.Any) -> None:
        """Update a space."""
        current = _request_json(
            opener,
            f"/rest/api/space/{args.key}?expand=description.plain",
        )
        current_name = current.get("name", "")
        current_desc = (
            current.get("description", {})
            .get("plain", {})
            .get("value", "")
            or ""
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
            return emit_json(data)

        name = data.get("name", args.name or current_name)
        key = data.get("key", args.key)
        print(f'Updated space "{name}" (key={key})')

    @staticmethod
    def search(opener: t.Any, args: t.Any) -> None:
        """Search spaces by title or CQL."""
        if args.cql:
            cql = args.cql
        elif args.query:
            cql = 'type=space AND title~"' + args.query.replace('"', '\\"') + '"'
        else:
            sys.stderr.write("Provide a query or --cql argument\n")
            sys.exit(2)

        api_limit = min(args.limit, 100)
        start = 0
        total = 0
        shown = 0

        while True:
            qs = urllib.parse.urlencode({"cql": cql, "limit": api_limit, "start": start})
            data = _request_json(opener, f"/rest/api/search?{qs}")

            if total == 0:
                total = data.get("totalSize", 0)

            if args.raw:
                for r in data.get("results", []):
                    emit_json(r)
                if shown >= total:
                    break
                shown += len(data.get("results", []))
                start += api_limit
                continue

            if start == 0:
                print(f"Space search results: {total} total")

            for r in data.get("results", []):
                space = r.get("space") or {}
                key = space.get("key", "?")
                name = space.get("name", "?")
                desc = (
                    space.get("description", {})
                    .get("plain", {})
                    .get("value", "")
                    or ""
                )[:150]
                print(f"  [{key}] {name}")
                if desc:
                    print(f"    {desc}")

            shown += len(data.get("results", []))
            if shown >= total:
                break
            start += api_limit
