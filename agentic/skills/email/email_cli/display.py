"""Output rendering: markdown tables for humans, JSON for ``--raw``.

The ``_cell``/``_md_table`` helpers mirror ``alexandra-vera``'s display module so
output looks consistent across the skills.
"""

from __future__ import annotations

import json

from .models import Message


def _cell(text: object) -> str:
    """Escape table-breaking characters in a cell value."""
    return str(text).replace("|", "\\|").replace("\n", " ")


def _md_table(headers: list[str], rows: list[list[str]], aligns: list[str]) -> str:
    """Build a GitHub-flavoured markdown table.

    Args:
        headers:
            The column headers.
        rows:
            The data rows (each the same length as ``headers``).
        aligns:
            Per-column alignment: ``'l'``, ``'r'``, or ``'c'``.

    Returns:
        The rendered markdown table.
    """
    sep_map = {"l": ":--", "r": "--:", "c": ":-:"}
    out = ["| " + " | ".join(_cell(h) for h in headers) + " |"]
    out.append("| " + " | ".join(sep_map[a] for a in aligns) + " |")
    for row in rows:
        out.append("| " + " | ".join(_cell(c) for c in row) + " |")
    return "\n".join(out)


def render_message_list(messages: list[Message]) -> str:
    """Render a listing of messages as a markdown table."""
    if not messages:
        return "_No messages._"
    rows = []
    for i, m in enumerate(messages, start=1):
        flag = "✉" if m.unread else ""
        rows.append([str(i), flag, m.date, m.sender, m.subject, m.id])
    return _md_table(
        headers=["#", "", "Date", "From", "Subject", "Id"],
        rows=rows,
        aligns=["r", "c", "l", "l", "l", "l"],
    )


def render_message(message: Message, *, want_html: bool = False) -> str:
    """Render a single message: headers, attachments, then body."""
    lines = [
        f"From:    {message.sender}",
        f"To:      {', '.join(message.to)}",
        f"Date:    {message.date}",
        f"Subject: {message.subject}",
    ]
    if message.attachments:
        lines.append(f"Attach:  {', '.join(message.attachments)}")
    lines.append("")
    if want_html and message.body_html:
        body = message.body_html
    else:
        body = message.body_text or message.body_html or "(no body)"
    lines.append(body.strip())
    return "\n".join(lines)


def emit_raw(obj: object) -> None:
    """Print ``obj`` as indented UTF-8 JSON (the ``--raw`` output format)."""
    print(json.dumps(obj, ensure_ascii=False, indent=2))
