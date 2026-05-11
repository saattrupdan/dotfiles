#!/usr/bin/env python3
"""Shared table manipulation helpers for AI Lab slides.

Provides functions to extract category rows and insert new rows
into Confluence slide tables.
"""

from __future__ import annotations

import re
import typing as t

from ..auth import _KNOWN_CATEGORIES
from ..utils.pages import HEADING_FUZZY_THRESHOLD, fuzzy_heading_match
from ..utils.parsing import (
    build_note_row,
    extract_tbody_rows,
    find_table_in_section,
    find_depth_bound,
)


def extract_category_rows(
    body: str,
    cat_key: str,
) -> list[dict[str, str]] | None:
    """Extract rows for a given category key from the page body.

    Args:
        body: Full page body HTML.
        cat_key: CLI category key (e.g. 'nlp').

    Returns:
        List of row dicts, or None if the heading is not found.
    """
    if cat_key not in _KNOWN_CATEGORIES:
        return None

    heading_text, _ = _KNOWN_CATEGORIES[cat_key]
    matched_text, heading_match = fuzzy_heading_match(body, heading_text)
    if not heading_match:
        return None

    table_span = find_table_in_section(body, heading_match.end())
    if table_span is None:
        return None

    return extract_tbody_rows(
        table_start=table_span[0],
        table_end=table_span[1],
        body=body,
    )


def insert_row_into_table(
    body: str,
    heading_text: str,
    new_row: str,
    note: str | None = None,
) -> tuple[str, int, int] | None:
    """Insert a new row into the table under *heading_text*.

    Args:
        body: Full page body HTML.
        heading_text: Target heading display text.
        new_row: HTML <tr> element to insert.
        note: Optional note row to append.

    Returns:
        Tuple of (new_body, table_start, table_end), or None.
    """
    matched_text, heading_match = fuzzy_heading_match(body, heading_text)
    if not heading_match:
        return None

    table_span = find_table_in_section(body, heading_match.end())
    if table_span is None:
        return None

    table_start, table_end = table_span
    full_table = body[table_start:table_end]

    tbody_start = full_table.find("<tbody")
    if tbody_start < 0:
        return None

    tbody_end = find_depth_bound(
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
        note_row = build_note_row(note)
        nt = new_full_table[tbody_start:tbody_end]
        nt_end = nt.find("</tbody>")
        if nt_end < 0:
            return None
        nt_open_len = new_full_table.find(">", tbody_start) + 1 - tbody_start
        nt_inner = nt[nt_open_len:-8]
        last_nt_tr = nt_inner.rfind("</tr>")
        if last_nt_tr >= 0:
            nt_new_inner = (
                nt_inner[:last_nt_tr] + note_row + nt_inner[last_nt_tr:]
            )
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
