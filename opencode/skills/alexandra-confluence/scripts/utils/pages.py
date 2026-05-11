#!/usr/bin/env python3
"""Page ID resolution and heading-to-category mapping.

Provides dynamic resolution of page IDs by title search, and fuzzy
matching of Confluence headings against known category labels.
"""

from __future__ import annotations

import difflib
import re
import typing as t

from ..auth import _KNOWN_CATEGORIES

# Module-level caches
_page_id_cache: dict[str, str] = {}
_resolved_cat_cache: dict[str, str | None] = {}
HEADING_FUZZY_THRESHOLD: float = 0.8


def fuzzy_heading_match(
    body: str,
    target_heading: str,
    threshold: float = HEADING_FUZZY_THRESHOLD,
) -> tuple[str | None, re.Match[str] | None]:
    """Find a heading in body that matches *target_heading* (exact or fuzzy).

    Returns a tuple of (matched_heading_text, regex_match_object) or (None, None).
    Using the match object avoids searching for the heading a second time.

    Args:
        body: Full page body HTML.
        target_heading: Expected heading text (from _KNOWN_CATEGORIES).
        threshold: Minimum similarity ratio for fuzzy match.

    Returns:
        Tuple of (cleaned matched text, re.Match object) or (None, None).
    """
    from .parsing import clean_heading

    for m in re.finditer(r"<h[12][^>]*>(.*?)</h[12]>", body, re.DOTALL):
        candidate = clean_heading(m.group(1))
        if candidate == target_heading:
            return candidate, m
        for known_heading, _ in _KNOWN_CATEGORIES.values():
            if difflib.SequenceMatcher(
                None, candidate, known_heading
            ).ratio() >= threshold:
                return candidate, m
    return None, None


def resolve_category_key(heading_text: str) -> str | None:
    """Resolve a CLI category key from a heading display text.

    Tries exact match against _KNOWN_CATEGORIES first, then fuzzy match.
    Caches results to avoid repeated lookups.

    Args:
        heading_text: Cleaned heading text from the page.

    Returns:
        The CLI category key (e.g. 'nlp'), or None if no match.
    """
    if heading_text in _resolved_cat_cache:
        return _resolved_cat_cache[heading_text]

    for ck, (ht, _) in _KNOWN_CATEGORIES.items():
        if ht == heading_text:
            _resolved_cat_cache[heading_text] = ck
            return ck

    for ck, (ht, _) in _KNOWN_CATEGORIES.items():
        if difflib.SequenceMatcher(None, heading_text, ht).ratio() >= HEADING_FUZZY_THRESHOLD:
            _resolved_cat_cache[heading_text] = ck
            return ck

    _resolved_cat_cache[heading_text] = None
    return None


def parse_categories_from_body(body: str) -> dict[str, tuple[str, str]]:
    """Parse category headings dynamically from the page body.

    Scans for <h1>/<h2> headings and maps them to category keys.
    Uses _KNOWN_CATEGORIES as fallback for known headings.
    Falls back to fuzzy matching for unknown headings.

    Args:
        body: Full page body HTML.

    Returns:
        Dict mapping category key -> (heading_text, sort_field).
    """
    from .parsing import clean_heading

    cat_map: dict[str, tuple[str, str]] = {}

    for m in re.finditer(r"<h[12][^>]*>(.*?)</h[12]>", body, re.DOTALL):
        heading_text = clean_heading(m.group(1))
        for cat_key, (known_heading, sort_field) in _KNOWN_CATEGORIES.items():
            if heading_text == known_heading:
                cat_map[cat_key] = (heading_text, sort_field)
                break
        else:
            for cat_key, (known_heading, sort_field) in _KNOWN_CATEGORIES.items():
                if difflib.SequenceMatcher(
                    None, heading_text, known_heading
                ).ratio() >= HEADING_FUZZY_THRESHOLD:
                    cat_map[cat_key] = (heading_text, sort_field)
                    break

    return cat_map


def build_heading_to_cat_map(
    body: str,
) -> dict[str, str]:
    """Map cleaned heading text -> category key.

    Uses dynamic parsing from body with _KNOWN_CATEGORIES as fallback.

    Args:
        body: Full page body HTML.

    Returns:
        Dict mapping heading display text -> CLI category key.
    """
    cat_key_to_heading = parse_categories_from_body(body)
    heading_map: dict[str, str] = {}
    for cat_key, (heading_text, _) in cat_key_to_heading.items():
        heading_map[heading_text] = cat_key
    return heading_map


def find_nearest_heading(
    heading_positions: list[int],
    table_position: int,
    body: str,
) -> str | None:
    """Find the nearest heading text preceding a table position.

    Scans heading positions backwards from the table position and
    returns the text of the closest preceding <h1>/<h2> tag.

    Args:
        heading_positions: Sorted list of byte offsets of '<h1>'/'<h2>' tags.
        table_position: Byte offset of the table start.
        body: Full page body HTML.

    Returns:
        Cleaned heading text, or None if no heading precedes the table.
    """
    from .parsing import clean_heading

    pos = table_position
    for hp in reversed(heading_positions):
        if hp >= pos:
            continue
        m = re.match(r"<h[12][^>]*>(.*?)</h[12]>", body[hp:], re.DOTALL)
        if m:
            return clean_heading(m.group(1))
    return None
