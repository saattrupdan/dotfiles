#!/usr/bin/env python3
"""Surgical, formatting-preserving editing of Microsoft Word .docx files.

A .docx is a ZIP of XML parts; the body text lives in ``word/document.xml`` and
comments in ``word/comments.xml``. Re-serialising that XML with a generic library
reorders attributes, drops ``mc:AlternateContent`` fallbacks and rewrites
``w:rsid*`` bookkeeping, which Word treats as corruption. This module instead
treats ``document.xml`` as raw UTF-8 text and replaces only the exact spans you
target, so everything you do not touch stays byte-identical.

Standard library only. Usable two ways:

1. As the ``docx`` CLI for the mechanical steps (unpack, scan, validate, pack).
2. As a library imported by a small per-document build script (see ``para``,
   ``apply_edits``, ``iter_blocks``, ``comment_block``).

See SKILL.md for the full workflow and gotchas.
"""

from __future__ import annotations

import argparse
import json
import logging
import re
import shutil
import sys
import typing as t
import xml.dom.minidom as minidom
import zipfile
from pathlib import Path

CONTENT_TYPES = "[Content_Types].xml"
COMMENTS_CONTENT_TYPE = (
    "application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"
)
COMMENTS_REL_TYPE = (
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments"
)

logging.basicConfig(level=logging.INFO, format="%(message)s", stream=sys.stdout)
logger = logging.getLogger(__name__)


class Block(t.TypedDict):
    """One top-level child of ``<w:body>`` with byte offsets and metadata."""

    index: int
    kind: str
    start: int
    end: int
    text: str
    style: str | None
    italic: bool
    range_starts: list[str]
    range_ends: list[str]
    references: list[str]


def main(argv: list[str] | None = None) -> int:
    """Run the ``docx`` command-line interface.

    Args:
        argv (optional):
          Argument list to parse. Defaults to ``sys.argv``.

    Returns:
        Process exit code: 0 on success, 1 if validation fails.
    """
    parser = argparse.ArgumentParser(
        description="Surgical, formatting-preserving editing of .docx files."
    )
    sub = parser.add_subparsers(dest="cmd", required=True)

    unpack_parser = sub.add_parser("unpack", help="extract a .docx and back it up")
    unpack_parser.add_argument("docx")
    unpack_parser.add_argument("workdir")

    scan_parser = sub.add_parser("scan", help="list body blocks with offsets/styles")
    scan_parser.add_argument("workdir")
    scan_parser.add_argument("--json", action="store_true", help="emit JSON")

    comments_parser = sub.add_parser(
        "ensure-comments", help="create the comments part if the document has none"
    )
    comments_parser.add_argument("workdir")

    validate_parser = sub.add_parser(
        "validate", help="check XML well-formedness and comment-range balance"
    )
    validate_parser.add_argument("workdir")

    pack_parser = sub.add_parser("pack", help="re-zip a working directory into a .docx")
    pack_parser.add_argument("workdir")
    pack_parser.add_argument("docx")

    args = parser.parse_args(argv)
    if args.cmd == "unpack":
        unpack(docx=Path(args.docx), workdir=Path(args.workdir))
    elif args.cmd == "scan":
        scan(workdir=Path(args.workdir), as_json=args.json)
    elif args.cmd == "ensure-comments":
        ensure_comments_part(workdir=Path(args.workdir))
        logger.info("comments part ensured")
    elif args.cmd == "validate":
        return 0 if validate(workdir=Path(args.workdir)) else 1
    elif args.cmd == "pack":
        pack(workdir=Path(args.workdir), docx=Path(args.docx))
    return 0


def unpack(docx: Path, workdir: Path) -> None:
    """Extract ``docx`` into ``workdir``, creating a one-time backup of the source.

    The backup ``<docx>.backup`` is written only if it does not already exist, so
    re-running never clobbers the true original.

    Args:
        docx:
          Path to the source .docx file.
        workdir:
          Directory to extract into. Recreated if it already exists.
    """
    backup = docx.with_name(docx.name + ".backup")
    if backup.exists():
        logger.info("backup already exists (left untouched): %s", backup)
    else:
        shutil.copy2(docx, backup)
        logger.info("backup -> %s", backup)
    if workdir.exists():
        shutil.rmtree(workdir)
    workdir.mkdir(parents=True)
    with zipfile.ZipFile(docx) as archive:
        archive.extractall(workdir)
    logger.info("unpacked -> %s", workdir)


def scan(workdir: Path, as_json: bool = False) -> None:
    """Print every top-level body block: index, style, comment ids and a preview.

    This is the map you edit against; byte offsets in the JSON form let you target
    exact spans for replacement.

    Args:
        workdir:
          Unpacked document directory.
        as_json (optional):
          Emit the full block list as JSON instead of a table. Defaults to False.
    """
    blocks = iter_blocks(raw=read(path=document_path(workdir=workdir)))
    if as_json:
        logger.info(json.dumps(blocks))
        return
    for block in blocks:
        if block["kind"] != "w:p":
            tag = f"[{block['kind']}]"
        else:
            descriptor = block["style"] or ("italic" if block["italic"] else "normal")
            tag = f"[{descriptor}]"
        mark = ""
        if block["range_starts"] or block["range_ends"] or block["references"]:
            mark = (
                f" <s{block['range_starts']} e{block['range_ends']}"
                f" ref{block['references']}>"
            )
        logger.info("%4d %-14s%s %s", block["index"], tag, mark, block["text"][:70])


def ensure_comments_part(workdir: Path) -> None:
    """Create the comments part and wire it up if the document has none yet.

    Adds ``word/comments.xml``, the relationship in ``document.xml.rels`` and the
    content-type override in ``[Content_Types].xml`` when missing. Safe to call
    repeatedly.

    Args:
        workdir:
          Unpacked document directory.
    """
    comments = workdir / "word" / "comments.xml"
    if not comments.exists():
        write(
            path=comments,
            text=(
                '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                '<w:comments xmlns:w="http://schemas.openxmlformats.org/'
                'wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/'
                'office/word/2010/wordml"></w:comments>'
            ),
        )
    content_types = workdir / CONTENT_TYPES
    types_xml = read(path=content_types)
    if "/word/comments.xml" not in types_xml:
        override = (
            f'<Override PartName="/word/comments.xml" '
            f'ContentType="{COMMENTS_CONTENT_TYPE}"/></Types>'
        )
        write(path=content_types, text=types_xml.replace("</Types>", override))
    rels_path = workdir / "word" / "_rels" / "document.xml.rels"
    rels = read(path=rels_path)
    if COMMENTS_REL_TYPE not in rels:
        used = [int(x) for x in re.findall(r'Id="rId(\d+)"', rels)] or [0]
        new_id = f"rId{max(used) + 1}"
        relationship = (
            f'<Relationship Id="{new_id}" Type="{COMMENTS_REL_TYPE}" '
            f'Target="comments.xml"/></Relationships>'
        )
        write(path=rels_path, text=rels.replace("</Relationships>", relationship))


def append_comments(workdir: Path, blocks: list[str]) -> None:
    """Append pre-built ``<w:comment>`` elements to the comments part.

    Args:
        workdir:
          Unpacked document directory.
        blocks:
          Comment elements as produced by ``comment_block``.
    """
    comments = workdir / "word" / "comments.xml"
    existing = read(path=comments)
    write(
        path=comments,
        text=existing.replace("</w:comments>", "".join(blocks) + "</w:comments>"),
    )


def validate(workdir: Path) -> bool:
    """Check both XML parts are well-formed and every comment range is balanced.

    Logs a per-check report and an overall ``VALID``/``INVALID`` line.

    Args:
        workdir:
          Unpacked document directory.

    Returns:
        True if the document passes every check, False otherwise.
    """
    raw = read(path=document_path(workdir=workdir))
    comments = workdir / "word" / "comments.xml"
    ok = True
    parts = [("document.xml", document_path(workdir=workdir))]
    if comments.exists():
        parts.append(("comments.xml", comments))
    for name, path in parts:
        try:
            minidom.parseString(read(path=path))
            logger.info("  ok   well-formed: %s", name)
        except Exception as exc:  # noqa: BLE001 - report any malformed XML uniformly
            ok = False
            logger.error("  FAIL XML error in %s: %s", name, exc)

    starts = set(re.findall(r'commentRangeStart w:id="(\d+)"', raw))
    ends = set(re.findall(r'commentRangeEnd w:id="(\d+)"', raw))
    refs = set(re.findall(r'commentReference w:id="(\d+)"', raw))
    defined: set[str] = set()
    if comments.exists():
        defined = set(re.findall(r'<w:comment w:id="(\d+)"', read(path=comments)))
    if starts == ends == refs and refs <= defined:
        logger.info("  ok   %d comment range(s), all balanced and defined", len(starts))
    else:
        ok = False
        logger.error(
            "  FAIL comment mismatch: starts=%s ends=%s refs=%s defined=%s",
            sorted(starts),
            sorted(ends),
            sorted(refs),
            sorted(defined),
        )
    duplicates = [s for s in starts if raw.count(f'commentRangeStart w:id="{s}"') > 1]
    if duplicates:
        ok = False
        logger.error("  FAIL duplicate commentRangeStart ids: %s", duplicates)
    logger.info("VALID" if ok else "INVALID")
    return ok


def pack(workdir: Path, docx: Path) -> None:
    """Re-zip ``workdir`` into ``docx`` and verify the archive integrity.

    The ``[Content_Types].xml`` part is written first, as the OOXML package format
    requires, and the archive is deflated.

    Args:
        workdir:
          Unpacked document directory.
        docx:
          Output .docx path.
    """
    entries = [
        (path, path.relative_to(workdir).as_posix())
        for path in workdir.rglob("*")
        if path.is_file()
    ]
    entries.sort(key=lambda pair: (pair[1] != CONTENT_TYPES, pair[1]))
    with zipfile.ZipFile(docx, "w", zipfile.ZIP_DEFLATED) as archive:
        for full, arcname in entries:
            archive.write(full, arcname)
    with zipfile.ZipFile(docx) as archive:
        corrupt = archive.testzip()
    size = docx.stat().st_size
    if corrupt:
        logger.error("packed -> %s (%d bytes) CORRUPT: %s", docx, size, corrupt)
    else:
        logger.info("packed -> %s (%d bytes) (integrity ok)", docx, size)


def sample_rpr(workdir: Path) -> str:
    """Return representative body run-properties so new paragraphs match the style.

    Picks the run properties of the longest Normal (unstyled) paragraph -- real
    body prose rather than a short title or label -- and prefers one that sets a
    font (``w:rFonts``). For exact fidelity when editing a single field, clone the
    ``<w:rPr>`` from an adjacent paragraph in that field instead.

    Args:
        workdir:
          Unpacked document directory.

    Returns:
        A ``<w:rPr>...</w:rPr>`` string, or a minimal English run if none is found.
    """
    raw = read(path=document_path(workdir=workdir))
    fallback: str | None = None
    by_length = sorted(iter_blocks(raw=raw), key=lambda b: len(b["text"]), reverse=True)
    for block in by_length:
        if block["kind"] != "w:p" or block["style"] or not block["text"].strip():
            continue
        match = re.search(
            r"<w:r\b[^>]*>\s*(<w:rPr>.*?</w:rPr>)", raw[block["start"] : block["end"]]
        )
        if not match:
            continue
        run_properties = match.group(1)
        if "w:rFonts" in run_properties:
            return run_properties
        if fallback is None:
            fallback = run_properties
    return fallback or '<w:rPr><w:lang w:val="en-GB"/></w:rPr>'


def para(
    text: str,
    rpr: str,
    comment_start: int | None = None,
    comment_end: int | None = None,
) -> str:
    """Build a body paragraph, optionally carrying comment-range markers.

    For a comment spanning paragraphs, set ``comment_start`` on the first paragraph
    and ``comment_end`` on the last. For a single-paragraph comment, set both to the
    same id.

    Args:
        text:
          Visible paragraph text (escaped automatically).
        rpr:
          Run-properties string to apply, e.g. from ``sample_rpr``.
        comment_start (optional):
          Comment id to open a range before the text. Defaults to None.
        comment_end (optional):
          Comment id to close a range and emit its reference. Defaults to None.

    Returns:
        A ``<w:p>...</w:p>`` paragraph element.
    """
    opening = (
        f'<w:commentRangeStart w:id="{comment_start}"/>'
        if comment_start is not None
        else ""
    )
    closing = ""
    if comment_end is not None:
        closing = (
            f'<w:commentRangeEnd w:id="{comment_end}"/><w:r><w:rPr>'
            f'<w:rStyle w:val="CommentReference"/></w:rPr>'
            f'<w:commentReference w:id="{comment_end}"/></w:r>'
        )
    return (
        f"<w:p><w:pPr>{rpr}</w:pPr>{opening}<w:r>{rpr}"
        f'<w:t xml:space="preserve">{escape(text=text)}</w:t></w:r>{closing}</w:p>'
    )


def comment_block(
    comment_id: int,
    text: str,
    author: str = "drafting",
    initials: str = "DR",
    date: str = "2026-01-01T00:00:00Z",
) -> str:
    """Build one ``<w:comment>`` element for the comments part.

    The in-body range markers and reference are emitted separately via ``para`` or
    ``apply_edits``.

    Args:
        comment_id:
          Numeric comment id, matching the in-body markers.
        text:
          Comment body text (escaped automatically).
        author (optional):
          Comment author name. Defaults to "drafting".
        initials (optional):
          Author initials. Defaults to "DR".
        date (optional):
          ISO-8601 timestamp. Defaults to a fixed date.

    Returns:
        A ``<w:comment>...</w:comment>`` element.
    """
    return (
        f'<w:comment w:id="{comment_id}" w:author="{escape(text=author)}" '
        f'w:date="{date}" w:initials="{escape(text=initials)}"><w:p><w:pPr>'
        f'<w:pStyle w:val="CommentText"/></w:pPr><w:r><w:rPr>'
        f'<w:rStyle w:val="CommentReference"/></w:rPr><w:annotationRef/></w:r>'
        f'<w:r><w:t xml:space="preserve">{escape(text=text)}</w:t></w:r>'
        f"</w:p></w:comment>"
    )


def iter_blocks(raw: str) -> list[Block]:
    """Parse the body of ``document.xml`` into top-level blocks with byte offsets.

    Offsets index into ``raw`` so callers can slice the exact fragment
    (``raw[start:end]``) or target a span for replacement. Block order equals
    document order. Italic detection is heuristic (every run carries ``<w:i/>``),
    which is enough to spot italic helper or instruction paragraphs.

    Args:
        raw:
          Full text of ``word/document.xml``.

    Returns:
        The list of parsed blocks.
    """
    body_start = raw.index("<w:body>") + len("<w:body>")
    body_end = raw.rindex("</w:body>")
    inner = raw[body_start:body_end]
    tag = re.compile(r"<(/?)(w:[A-Za-z]+)([^>]*?)(/?)>")
    children: list[tuple[str, int, int]] = []
    stack: list[str] = []
    open_start = 0
    open_kind = ""
    for match in tag.finditer(inner):
        closing = match.group(1) == "/"
        name = match.group(2)
        self_closing = match.group(4) == "/"
        if self_closing:
            if not stack:
                children.append(
                    (name, body_start + match.start(), body_start + match.end())
                )
            continue
        if not closing:
            if not stack:
                open_start, open_kind = body_start + match.start(), name
            stack.append(name)
        elif stack and stack[-1] == name:
            stack.pop()
            if not stack:
                children.append((open_kind, open_start, body_start + match.end()))

    blocks: list[Block] = []
    for index, (kind, start, end) in enumerate(children):
        fragment = raw[start:end]
        style_match = re.search(r'<w:pStyle w:val="([^"]*)"', fragment)
        runs = re.findall(r"<w:r\b.*?</w:r>", fragment, flags=re.DOTALL)
        italic = bool(runs) and all("<w:i/>" in run or "<w:i " in run for run in runs)
        text = "".join(
            _unescape(text=value)
            for value in re.findall(
                r"<w:t\b[^>]*>(.*?)</w:t>", fragment, flags=re.DOTALL
            )
        )
        blocks.append(
            Block(
                index=index,
                kind=kind,
                start=start,
                end=end,
                text=text,
                style=style_match.group(1) if style_match else None,
                italic=italic,
                range_starts=re.findall(r'commentRangeStart w:id="(\d+)"', fragment),
                range_ends=re.findall(r'commentRangeEnd w:id="(\d+)"', fragment),
                references=re.findall(r'commentReference w:id="(\d+)"', fragment),
            )
        )
    return blocks


def apply_edits(raw: str, edits: list[tuple[int, int, str]]) -> str:
    """Apply ``(start, end, replacement)`` edits to ``raw``.

    Edits are applied from the highest offset to the lowest so that earlier offsets
    stay valid as spans are spliced.

    Args:
        raw:
          Text to edit.
        edits:
          Replacement spans as ``(start, end, replacement)`` tuples.

    Returns:
        The edited text.

    Raises:
        ValueError:
          If two edits overlap.
    """
    ordered = sorted(edits, key=lambda edit: edit[0], reverse=True)
    previous_start: int | None = None
    for start, end, _ in ordered:
        if previous_start is not None and end > previous_start:
            raise ValueError(f"overlapping edit at {start}:{end}")
        previous_start = start
    for start, end, replacement in ordered:
        raw = raw[:start] + replacement + raw[end:]
    return raw


def replace_once(raw: str, old: str, new: str, count: int = 1) -> str:
    """Replace ``old`` with ``new`` after asserting its occurrence count.

    Args:
        raw:
          Text to edit.
        old:
          Substring to replace.
        new:
          Replacement substring.
        count (optional):
          Required number of occurrences of ``old``. Defaults to 1.

    Returns:
        The edited text.

    Raises:
        ValueError:
          If ``old`` does not occur exactly ``count`` times.
    """
    found = raw.count(old)
    if found != count:
        raise ValueError(f"expected {count} occurrence(s), found {found}: {old[:60]!r}")
    return raw.replace(old, new)


def escape(text: str) -> str:
    """Escape the XML metacharacters ``&``, ``<`` and ``>``.

    Args:
        text:
          Raw text.

    Returns:
        XML-escaped text.
    """
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def read(path: Path) -> str:
    """Read a UTF-8 text file.

    Args:
        path:
          File to read.

    Returns:
        The file contents.
    """
    return path.read_text(encoding="utf-8")


def write(path: Path, text: str) -> None:
    """Write a UTF-8 text file.

    Args:
        path:
          File to write.
        text:
          Contents to write.
    """
    path.write_text(text, encoding="utf-8")


def document_path(workdir: Path) -> Path:
    """Return the path to ``word/document.xml`` inside an unpacked directory.

    Args:
        workdir:
          Unpacked document directory.

    Returns:
        Path to the main document part.
    """
    return workdir / "word" / "document.xml"


def _unescape(text: str) -> str:
    """Reverse XML escaping for extracted run text.

    Args:
        text:
          Escaped text from a ``<w:t>`` run.

    Returns:
        The unescaped text.
    """
    return (
        text.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", '"')
        .replace("&apos;", "'")
        .replace("&amp;", "&")
    )


if __name__ == "__main__":
    raise SystemExit(main())
