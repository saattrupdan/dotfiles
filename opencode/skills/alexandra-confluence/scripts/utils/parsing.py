#!/usr/bin/env python3
"""HTML and table parsing helpers for Confluence storage format.

Handles slide row extraction, table manipulation, heading cleaning,
and Confluence body format conversion.
"""

from __future__ import annotations

import collections.abc as c
import html
import re
import typing as t


def emit_json(obj: t.Any) -> None:
    """Print JSON-encoded object with indentation.

    Args:
        obj: Object to serialize.
    """
    import json

    print(json.dumps(obj, ensure_ascii=False, indent=2))


def strip_tags(text: str) -> str:
    """Remove all HTML tags from text.

    Args:
        text: Raw HTML string.

    Returns:
        Plain text with tags stripped.
    """
    return re.sub(r"<[^>]+>", "", text)


def find_depth_bound(
    text: str,
    open_str: str,
    close_str: str,
    start: int,
) -> int:
    """Count nesting depth from *start* until the matching close tag.

    Args:
        text: Full HTML string.
        open_str: Opening tag string (e.g. "<tbody").
        close_str: Closing tag string (e.g. "</tbody>").
        start: Index to begin counting from.

    Returns:
        Index just past the closing tag, or -1 if not found.
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


def extract_slide_rows(tbody_html: str) -> list[dict[str, str]]:
    """Extract parsed row dicts from a <tbody> string.

    Skips the first row if it contains <th> cells (header).

    Args:
        tbody_html: Inner HTML of a <tbody> element.

    Returns:
        List of dicts with keys: date, owner_key, title, language, slides.
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
                "date": strip_tags(cells[0]).strip(),
                "owner_key": strip_tags(cells[1]).strip(),
                "title": strip_tags(cells[2]).strip(),
                "language": strip_tags(cells[3]).strip(),
                "slides": strip_tags(cells[4]).strip(),
            }
        )
    return results


def build_slide_row(
    date: str | None,
    owner_key: str | None,
    title: str,
    language: str | None,
    slides: str | None,
) -> str:
    """Build a single <tr> row for the slide table.

    Args:
        date: Date string (YYYY-MM-DD).
        owner_key: Confluence user key.
        title: Slide title.
        language: Language code.
        slides: Attachment filename.

    Returns:
        HTML <tr> element string.
    """
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


def build_note_row(note: str) -> str:
    """Build a plain text row spanning all columns.

    Args:
        note: Note text.

    Returns:
        HTML <tr> with a single <td colspan="5">.
    """
    return '<tr><td colspan="5">' + html.escape(note) + "</td></tr>"


def clean_heading(html_fragment: str) -> str:
    """Strip all HTML tags from a heading fragment and trim whitespace.

    HTML entities are decoded to their character equivalents.

    Args:
        html_fragment: Heading HTML fragment.

    Returns:
        Cleaned heading text.
    """
    return html.unescape(re.sub(r"<[^>]+>", "", html_fragment)).strip()


def find_table_in_section(
    body: str,
    after_offset: int,
) -> tuple[int, int] | None:
    """Find the first <table>...</table> starting at *after_offset*.

    Args:
        body: Full page body HTML.
        after_offset: Index to begin searching from.

    Returns:
        Tuple of (table_start, table_end) indices, or None.
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


def extract_tbody_rows(
    table_start: int,
    table_end: int,
    body: str,
) -> list[dict[str, str]] | None:
    """Extract slide rows from a table span within *body*.

    Args:
        table_start: Start index of the <table> tag.
        table_end: End index of the </table> tag.
        body: Full page body HTML.

    Returns:
        List of row dicts, or None if no <tbody> found.
    """
    full_table = body[table_start:table_end]
    tbody_start = full_table.find("<tbody")
    if tbody_start < 0:
        return None

    tbody_end = find_depth_bound(full_table, "<tbody", "</tbody>", tbody_start)
    if tbody_end < 0:
        return None

    tbody = full_table[tbody_start:tbody_end]
    return extract_slide_rows(tbody)


def find_nearest_heading(
    heading_positions: list[int],
    table_start: int,
    body: str,
) -> str | None:
    """Return the cleaned text of the nearest heading before *table_start*.

    Args:
        heading_positions: List of <h1>/<h2> start positions.
        table_start: Table start position.
        body: Full page body HTML.

    Returns:
        Cleaned heading text, or None.
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

    return clean_heading(heading_fragment)
