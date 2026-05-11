#!/usr/bin/env python3
"""Write operations for AI Lab slide deck entries.

Provides create and update operations for the slide deck page.
"""

from __future__ import annotations

import re
import sys
import typing as t

from ..auth import _KNOWN_CATEGORIES, _SLIDE_DECKS_PAGE_ID
from ..http import _request_json
from ..utils.parsing import (
    build_note_row,
    build_slide_row,
    emit_json,
    find_depth_bound,
    find_table_in_section,
)
from ..utils.pages import fuzzy_heading_match
from .slides_core import extract_category_rows, insert_row_into_table


class AiLabSlidesWrite:
    """Write operations for AI Lab slide deck entries."""

    @staticmethod
    def create(opener: t.Any, args: t.Any) -> None:
        """Create a new slide entry.

        Args:
            opener: HTTP opener for Confluence API requests.
            args: Parsed command-line arguments.
        """
        category = args.category.lower()

        if category not in _KNOWN_CATEGORIES:
            sys.stderr.write(
                f"Unknown category '{category}'. "
                f"Valid: {', '.join(sorted(_KNOWN_CATEGORIES.keys()))}\n",
            )
            sys.exit(2)

        heading_text, _ = _KNOWN_CATEGORIES[category]

        page = _request_json(
            opener,
            f"/rest/api/content/{_SLIDE_DECKS_PAGE_ID}?"
            f"expand=body.view,version",
        )
        version_number = page.get("version", {}).get("number", 1)
        body = page["body"]["view"]["value"]

        row = build_slide_row(
            date=args.date,
            owner_key=args.owner_key,
            title=args.title,
            language=args.language,
            slides=args.slides,
        )

        result = insert_row_into_table(
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
                f"/rest/api/content/{_SLIDE_DECKS_PAGE_ID}?"
                f"expand=body.view,version",
            )
            version_number = (
                current_page.get("version", {}).get("number", 1)
            )

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
            except Exception as e:
                if hasattr(e, "code") and e.code == 409 and attempt < 2:
                    continue
                raise

        if args.raw:
            return emit_json(data)

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
        print(
            f"  Page version: "
            f"{data.get('version', {}).get('number')}"
        )

    @staticmethod
    def update(opener: t.Any, args: t.Any) -> None:
        """Update an existing slide entry.

        Args:
            opener: HTTP opener for Confluence API requests.
            args: Parsed command-line arguments.
        """
        category = args.category.lower()

        if category not in _KNOWN_CATEGORIES:
            sys.stderr.write(
                f"Unknown category '{category}'. "
                f"Valid: {', '.join(sorted(_KNOWN_CATEGORIES.keys()))}\n",
            )
            sys.exit(2)

        heading_text, _ = _KNOWN_CATEGORIES[category]

        page = _request_json(
            opener,
            f"/rest/api/content/{_SLIDE_DECKS_PAGE_ID}?"
            f"expand=body.view",
        )
        body = page["body"]["view"]["value"]

        rows = extract_category_rows(body, category)
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
            args.owner_key
            if args.owner_key is not None
            else existing["owner_key"]
        )
        title = (
            args.title if args.title is not None else existing["title"]
        )
        language = (
            args.language
            if args.language is not None
            else existing["language"]
        )
        slides = (
            args.slides if args.slides is not None else existing["slides"]
        )

        new_row = build_slide_row(
            date=date,
            owner_key=owner_key,
            title=title,
            language=language,
            slides=slides,
        )

        # Locate the nth <tr> in the tbody and replace it
        table_span = find_table_for_heading(body, heading_text)
        if table_span is None:
            sys.stderr.write(
                f"Could not find heading '{heading_text}' in page\n",
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

        tbody_end = find_depth_bound(
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
            for m in re.finditer(
                r"</tr>", tbody_content, re.IGNORECASE
            )
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
                f"({len(tr_ranges)} rows) "
                f"for category '{category}'\n",
            )
            sys.exit(2)

        start, end = tr_ranges[index]
        new_tbody_content = (
            tbody_content[:start] + new_row + tbody_content[end:]
        )
        new_tbody = (
            tbody[:tbody_open]
            + new_tbody_content
            + tbody[tbody_open + len(tbody_content) :]
        )
        new_full_table = (
            full_table[:tbody_start]
            + new_tbody
            + full_table[tbody_end:]
        )
        new_body = (
            body[:table_start]
            + new_full_table
            + body[table_end:]
        )

        # Handle note row
        if args.note:
            note_row = build_note_row(args.note)
            nt = new_full_table[tbody_start:tbody_end]
            nt_end = nt.find("</tbody>")
            if nt_end >= 0:
                nt_open_len = (
                    new_full_table.find(">", tbody_start)
                    + 1
                    - tbody_start
                )
                nt_inner = nt[nt_open_len:-8]
                last_nt_tr = nt_inner.rfind("</tr>")
                if last_nt_tr >= 0:
                    nt_new_inner = (
                        nt_inner[:last_nt_tr]
                        + note_row
                        + nt_inner[last_nt_tr:]
                    )
                    nt_new = (
                        nt[:nt_open_len] + nt_new_inner + nt[nt_end:]
                    )
                    new_full_table = (
                        new_full_table[:tbody_start]
                        + nt_new
                        + new_full_table[tbody_end:]
                    )
                    new_body = (
                        body[:table_start]
                        + new_full_table
                        + body[table_end:]
                    )

        for attempt in range(3):
            current_page = _request_json(
                opener,
                f"/rest/api/content/{_SLIDE_DECKS_PAGE_ID}?"
                f"expand=body.view,version",
            )
            version_number = (
                current_page.get("version", {}).get("number", 1)
            )

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
            except Exception as e:
                if hasattr(e, "code") and e.code == 409 and attempt < 2:
                    continue
                raise

        if args.raw:
            return emit_json(data)

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
        print(
            f"  Page version: "
            f"{data.get('version', {}).get('number')}"
        )


def find_table_for_heading(
    body: str, heading_text: str
) -> tuple[int, int] | None:
    """Find the table associated with a heading.

    Args:
        body: Full page body HTML.
        heading_text: Target heading display text.

    Returns:
        Tuple of (table_start, table_end) or None.
    """
    matched_text, heading_match = fuzzy_heading_match(body, heading_text)
    if not heading_match:
        return None

    return find_table_in_section(body, heading_match.end())
