#!/usr/bin/env python3
"""Query operations for AI Lab slide deck entries.

Provides read, list, and search operations for the slide deck page.
"""

from __future__ import annotations

import re
import sys
import typing as t
import urllib.parse

from ..auth import _KNOWN_CATEGORIES, _SLIDE_DECKS_PAGE_ID, BASE
from ..http import _request_json
from ..utils.parsing import emit_json, strip_tags
from ..utils.pages import build_heading_to_cat_map, find_nearest_heading
from .slides_core import extract_category_rows


class AiLabSlides:
    """Manage AI Lab slide deck entries on a Confluence page."""

    @staticmethod
    def read(opener: t.Any, args: t.Any) -> None:
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
                    f"Invalid index in ID '{args.id}'. "
                    f"Expected integer after ':'.\n",
                )
                sys.exit(2)
        elif args.category is not None and args.index is not None:
            cat_key = args.category.lower()
            index = args.index
        else:
            sys.stderr.write(
                "Provide --id (cat:index) or both "
                "--category and --index\n",
            )
            sys.exit(2)

        if cat_key not in _KNOWN_CATEGORIES:
            sys.stderr.write(
                f"Unknown category '{cat_key}'. "
                f"Valid: {', '.join(sorted(_KNOWN_CATEGORIES.keys()))}\n",
            )
            sys.exit(2)

        page = _request_json(
            opener,
            f"/rest/api/content/{_SLIDE_DECKS_PAGE_ID}?"
            f"expand=body.view",
        )
        body = page["body"]["view"]["value"]
        heading_text, _ = _KNOWN_CATEGORIES[cat_key]

        rows = extract_category_rows(body, cat_key)
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
            return emit_json(rows[index])

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
                f"  Download: "
                f"{BASE}/download/attachments/"
                f"{_SLIDE_DECKS_PAGE_ID}/{encoded}"
            )

    @staticmethod
    def list(opener: t.Any, args: t.Any) -> None:
        """List all slides across all categories.

        Extracts every <table> on the page and associates each with
        its nearest preceding heading to determine the category.
        """
        page = _request_json(
            opener,
            f"/rest/api/content/{_SLIDE_DECKS_PAGE_ID}?"
            f"expand=body.view",
        )
        body = page["body"]["view"]["value"]

        heading_map = build_heading_to_cat_map(body)
        heading_positions = [
            m.start() for m in re.finditer(r"<h[12]", body)
        ]

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
            tbody_rows = extract_tbody_rows(
                t_start, t_end, body
            )
            if tbody_rows is None:
                continue

            heading_text = find_nearest_heading(
                heading_positions, t_start, body
            )
            if heading_text is None:
                continue

            cat_key = heading_map.get(heading_text)
            if cat_key is None:
                from ..utils.pages import resolve_category_key

                cat_key = resolve_category_key(heading_text)
                if cat_key:
                    heading_map[heading_text] = cat_key
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
            return emit_json(all_rows)

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
                f"  [{r['_id']}] "
                f"[{heading_text}]  "
                f"{'  '.join(p for p in parts if p)}"
            )

    @staticmethod
    def search(opener: t.Any, args: t.Any) -> None:
        """Search slides across all categories.

        Returns unique slide IDs matching the query.
        """
        if args.cql:
            cql = args.cql
            qs = urllib.parse.urlencode({"cql": cql, "limit": 50})
            search_results = _request_json(
                opener, f"/rest/api/search?{qs}"
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
            f"/rest/api/content/{_SLIDE_DECKS_PAGE_ID}?"
            f"expand=body.view",
        )
        body = page["body"]["view"]["value"]

        heading_map = build_heading_to_cat_map(body)
        heading_positions = [
            m.start() for m in re.finditer(r"<h[12]", body)
        ]

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
            tbody_rows = extract_tbody_rows(
                t_start, t_end, body
            )
            if tbody_rows is None:
                continue

            heading_text = find_nearest_heading(
                heading_positions, t_start, body
            )
            if heading_text is None:
                continue

            cat_key = heading_map.get(heading_text)
            if cat_key is None:
                from ..utils.pages import resolve_category_key

                cat_key = resolve_category_key(heading_text)
                if cat_key:
                    heading_map[heading_text] = cat_key
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
            return emit_json(all_rows)

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
                f"  [{r['_id']}] "
                f"[{heading_text}]  "
                f"{'  '.join(p for p in parts if p)}"
            )
