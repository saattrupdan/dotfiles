"""Shared constants for the Confluence CLI.

Extracted to break the circular import between auth.py and http.py.
"""

from __future__ import annotations


# ── Constants ────────────────────────────────────────────────────────

BASE: str = "https://confluence.alexandra.dk"
UA: str = "Mozilla/5.0 (alexandra-confluence-cli)"
MAX_RETRIES: int = 3
INITIAL_BACKOFF: float = 1.0


class _ConfluenceError(Exception):
    """Raised when a Confluence API call returns an error status code."""

    def __init__(self, code: int, message: str) -> None:
        self.code = code
        self.message = message
        super().__init__(f"HTTP {code}: {message}")
