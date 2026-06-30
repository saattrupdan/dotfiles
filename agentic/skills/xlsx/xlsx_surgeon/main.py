#!/usr/bin/env python3
"""Surgical, formatting-preserving editing of Microsoft Excel .xlsx files.

An .xlsx is a ZIP of XML parts. The sheet list lives in ``xl/workbook.xml``; each
worksheet's cells live in ``xl/worksheets/sheetN.xml``; text values are pooled in
``xl/sharedStrings.xml`` and formatting in ``xl/styles.xml``. Re-serialising that
XML with a generic library (or rewriting the file with openpyxl) reorders
attributes, drops parts it does not understand, discards the cached formula values
and can strip charts, data validations and conditional formatting -- changes Excel
may flag as repaired. This module instead treats each part as raw UTF-8 text and
replaces only the exact cells you target, so everything you do not touch stays
byte-identical.

Standard library only. Usable two ways:

1. As the ``xlsx`` CLI for the mechanical steps (unpack, sheets, scan, fills, set,
   recalc, validate, pack).
2. As a library imported by a small per-workbook build script (see ``set_cell``,
   ``iter_cells``, ``shared_strings``, ``fill_palette``).

See SKILL.md for the full workflow and gotchas.
"""

from __future__ import annotations

import argparse
import colorsys
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
# clrScheme children appear in this order in xl/theme/theme1.xml ...
THEME_ORDER = (
    "dk1",
    "lt1",
    "dk2",
    "lt2",
    "accent1",
    "accent2",
    "accent3",
    "accent4",
    "accent5",
    "accent6",
    "hlink",
    "folHlink",
)
# ... but a color's ``theme="N"`` attribute indexes a *different* order: the first
# two pairs are swapped (the well-known OOXML quirk).
THEME_INDEX = (
    "lt1",
    "dk1",
    "lt2",
    "dk2",
    "accent1",
    "accent2",
    "accent3",
    "accent4",
    "accent5",
    "accent6",
    "hlink",
    "folHlink",
)

logging.basicConfig(level=logging.INFO, format="%(message)s", stream=sys.stdout)
logger = logging.getLogger(__name__)


class Sheet(t.TypedDict):
    """One worksheet: its display name, workbook id and part path."""

    index: int
    name: str
    sheet_id: str
    rel_id: str
    path: str


class Cell(t.TypedDict):
    """One ``<c>`` element with its address, style, type, value and formula."""

    ref: str
    col: str
    col_num: int
    row: int
    style: int | None
    type: str | None
    raw_value: str | None
    formula: str | None
    value: str | None


def main(argv: list[str] | None = None) -> int:
    """Run the ``xlsx`` command-line interface.

    Args:
        argv (optional):
          Argument list to parse. Defaults to ``sys.argv``.

    Returns:
        Process exit code: 0 on success, 1 if validation fails.
    """
    parser = argparse.ArgumentParser(
        description="Surgical, formatting-preserving editing of .xlsx files."
    )
    sub = parser.add_subparsers(dest="cmd", required=True)

    unpack_parser = sub.add_parser("unpack", help="extract an .xlsx and back it up")
    unpack_parser.add_argument("xlsx")
    unpack_parser.add_argument("workdir")

    sub.add_parser("sheets", help="list worksheet names and parts").add_argument(
        "workdir"
    )

    scan_parser = sub.add_parser("scan", help="dump a sheet's cells with values")
    scan_parser.add_argument("workdir")
    scan_parser.add_argument("sheet", help="sheet name, 1-based index or part filename")
    scan_parser.add_argument(
        "--style", help="only cells whose style id is in this comma list"
    )
    scan_parser.add_argument(
        "--all", action="store_true", help="include empty styled cells too"
    )
    scan_parser.add_argument("--json", action="store_true", help="emit JSON")

    fills_parser = sub.add_parser(
        "fills", help="resolve the fill palette and which style ids use each fill"
    )
    fills_parser.add_argument("workdir")

    set_parser = sub.add_parser("set", help="set or insert one cell's value")
    set_parser.add_argument("workdir")
    set_parser.add_argument("sheet")
    set_parser.add_argument("ref", help="cell address, e.g. B13")
    set_parser.add_argument("value")
    set_parser.add_argument(
        "--type",
        choices=["auto", "number", "string", "formula", "shared", "bool"],
        default="auto",
    )
    set_parser.add_argument("--style", help="override the style id for the cell")
    set_parser.add_argument(
        "--recalc",
        action="store_true",
        help="also set fullCalcOnLoad so formulas refresh on open",
    )

    sub.add_parser("recalc", help="force full recalculation on next open").add_argument(
        "workdir"
    )

    sub.add_parser("validate", help="check every XML part is well-formed").add_argument(
        "workdir"
    )

    pack_parser = sub.add_parser(
        "pack", help="re-zip a working directory into an .xlsx"
    )
    pack_parser.add_argument("workdir")
    pack_parser.add_argument("xlsx")

    args = parser.parse_args(argv)
    if args.cmd == "unpack":
        unpack(xlsx=Path(args.xlsx), workdir=Path(args.workdir))
    elif args.cmd == "sheets":
        _print_sheets(workdir=Path(args.workdir))
    elif args.cmd == "scan":
        styles = [int(x) for x in args.style.split(",")] if args.style else None
        scan(
            workdir=Path(args.workdir),
            sheet=args.sheet,
            style_ids=styles,
            include_empty=args.all,
            as_json=args.json,
        )
    elif args.cmd == "fills":
        _print_fills(workdir=Path(args.workdir))
    elif args.cmd == "set":
        workdir = Path(args.workdir)
        path = sheet_path(workdir=workdir, sheet=args.sheet)
        style = int(args.style) if args.style is not None else None
        updated = set_cell(
            raw=read(path=path),
            ref=args.ref,
            value=args.value,
            kind=args.type,
            style=style,
        )
        write(path=path, text=updated)
        logger.info("set %s!%s = %s", args.sheet, args.ref, args.value)
        if args.recalc:
            enable_full_calc(workdir=workdir)
            logger.info("fullCalcOnLoad set")
    elif args.cmd == "recalc":
        enable_full_calc(workdir=Path(args.workdir))
        logger.info("fullCalcOnLoad set")
    elif args.cmd == "validate":
        return 0 if validate(workdir=Path(args.workdir)) else 1
    elif args.cmd == "pack":
        pack(workdir=Path(args.workdir), xlsx=Path(args.xlsx))
    return 0


def unpack(xlsx: Path, workdir: Path) -> None:
    """Extract ``xlsx`` into ``workdir``, creating a one-time backup of the source.

    The backup ``<xlsx>.backup`` is written only if it does not already exist, so
    re-running never clobbers the true original.

    Args:
        xlsx:
          Path to the source .xlsx file.
        workdir:
          Directory to extract into. Recreated if it already exists.
    """
    backup = xlsx.with_name(xlsx.name + ".backup")
    if backup.exists():
        logger.info("backup already exists (left untouched): %s", backup)
    else:
        shutil.copy2(xlsx, backup)
        logger.info("backup -> %s", backup)
    if workdir.exists():
        shutil.rmtree(workdir)
    workdir.mkdir(parents=True)
    with zipfile.ZipFile(xlsx) as archive:
        archive.extractall(workdir)
    logger.info("unpacked -> %s", workdir)


def list_sheets(workdir: Path) -> list[Sheet]:
    """Return the workbook's sheets in tab order with their part paths.

    Resolves each sheet's ``r:id`` against ``xl/_rels/workbook.xml.rels`` to find
    the worksheet part on disk.

    Args:
        workdir:
          Unpacked workbook directory.

    Returns:
        The list of sheets in tab order.
    """
    workbook = read(path=workdir / "xl" / "workbook.xml")
    rels = read(path=workdir / "xl" / "_rels" / "workbook.xml.rels")
    targets = dict(re.findall(r'<Relationship Id="([^"]+)"[^>]*Target="([^"]+)"', rels))
    sheets: list[Sheet] = []
    for index, match in enumerate(
        re.finditer(
            r'<sheet[^>]*name="([^"]*)"[^>]*sheetId="([^"]*)"[^>]*r:id="([^"]*)"'
            r"|"
            r'<sheet[^>]*name="([^"]*)"[^>]*r:id="([^"]*)"[^>]*sheetId="([^"]*)"',
            workbook,
        )
    ):
        if match.group(1) is not None:
            name, sheet_id, rel_id = match.group(1), match.group(2), match.group(3)
        else:
            name, rel_id, sheet_id = match.group(4), match.group(5), match.group(6)
        target = targets.get(rel_id, "")
        path = ("xl/" + target.lstrip("/")) if not target.startswith("xl/") else target
        sheets.append(
            Sheet(
                index=index,
                name=_unescape(text=name),
                sheet_id=sheet_id,
                rel_id=rel_id,
                path=path.replace("xl/xl/", "xl/"),
            )
        )
    return sheets


def sheet_path(workdir: Path, sheet: str) -> Path:
    """Resolve a sheet selector to its worksheet part path.

    Args:
        workdir:
          Unpacked workbook directory.
        sheet:
          A sheet display name, a 1-based tab index, or a part filename such as
          ``sheet2.xml``.

    Returns:
        Path to the worksheet XML part.

    Raises:
        ValueError:
          If no sheet matches the selector.
    """
    sheets = list_sheets(workdir=workdir)
    for entry in sheets:
        if entry["name"] == sheet:
            return workdir / entry["path"]
    if sheet.isdigit():
        index = int(sheet) - 1
        if 0 <= index < len(sheets):
            return workdir / sheets[index]["path"]
    for entry in sheets:
        if Path(entry["path"]).name == sheet or entry["path"] == sheet:
            return workdir / entry["path"]
    direct = workdir / "xl" / "worksheets" / sheet
    if direct.exists():
        return direct
    raise ValueError(f"no sheet matches {sheet!r}; have {[s['name'] for s in sheets]}")


def shared_strings(workdir: Path) -> list[str]:
    """Return the shared-string table as a list indexed by string id.

    Args:
        workdir:
          Unpacked workbook directory.

    Returns:
        The pooled strings; empty if the workbook has no shared-strings part.
    """
    path = workdir / "xl" / "sharedStrings.xml"
    if not path.exists():
        return []
    raw = read(path=path)
    strings: list[str] = []
    for si in re.findall(r"<si>(.*?)</si>", raw, flags=re.DOTALL):
        strings.append(
            "".join(
                _unescape(text=value)
                for value in re.findall(r"<t\b[^>]*>(.*?)</t>", si, flags=re.DOTALL)
            )
        )
    return strings


def iter_cells(raw: str, strings: list[str] | None = None) -> list[Cell]:
    """Parse all ``<c>`` cells of a worksheet, resolving values where possible.

    Args:
        raw:
          Full text of a ``xl/worksheets/sheetN.xml`` part.
        strings (optional):
          Shared-string table, so ``t="s"`` cells resolve to text. Defaults to None.

    Returns:
        The cells in document order.
    """
    cells: list[Cell] = []
    for match in re.finditer(r"<c\b([^>]*?)(?:/>|>(.*?)</c>)", raw, flags=re.DOTALL):
        attrs, inner = match.group(1), match.group(2) or ""
        ref = _attr(attrs=attrs, name="r")
        if ref is None:
            continue
        col, row = parse_ref(ref=ref)
        style = _attr(attrs=attrs, name="s")
        cell_type = _attr(attrs=attrs, name="t")
        formula_match = re.search(r"<f\b[^>]*>(.*?)</f>", inner, flags=re.DOTALL)
        value_match = re.search(r"<v\b[^>]*>(.*?)</v>", inner, flags=re.DOTALL)
        inline_match = re.search(r"<is\b[^>]*>(.*?)</is>", inner, flags=re.DOTALL)
        raw_value: str | None = None
        if value_match:
            raw_value = value_match.group(1)
        elif inline_match:
            raw_value = "".join(
                re.findall(
                    r"<t\b[^>]*>(.*?)</t>", inline_match.group(1), flags=re.DOTALL
                )
            )
        cells.append(
            Cell(
                ref=ref,
                col=col,
                col_num=col_to_num(col=col),
                row=row,
                style=int(style) if style is not None else None,
                type=cell_type,
                raw_value=raw_value,
                formula=_unescape(text=formula_match.group(1))
                if formula_match
                else None,
                value=_resolve(
                    cell_type=cell_type, raw_value=raw_value, strings=strings or []
                ),
            )
        )
    return cells


def scan(
    workdir: Path,
    sheet: str,
    style_ids: list[int] | None = None,
    include_empty: bool = False,
    as_json: bool = False,
) -> None:
    """Print a worksheet's cells: address, style id, type, formula flag and value.

    This is the map you edit against. By default it shows cells that carry a value
    or a formula; ``--all`` adds empty styled cells (useful when hunting for blank
    input fields by their fill).

    Args:
        workdir:
          Unpacked workbook directory.
        sheet:
          Sheet selector (name, index or part filename).
        style_ids (optional):
          Restrict output to cells whose style id is in this list. Defaults to None.
        include_empty (optional):
          Include cells that have a style but no value. Defaults to False.
        as_json (optional):
          Emit the cell list as JSON instead of a table. Defaults to False.
    """
    cells = iter_cells(
        raw=read(path=sheet_path(workdir=workdir, sheet=sheet)),
        strings=shared_strings(workdir=workdir),
    )
    selected = [
        cell
        for cell in cells
        if (style_ids is None or cell["style"] in style_ids)
        and (include_empty or cell["value"] is not None or cell["formula"])
    ]
    if as_json:
        logger.info(json.dumps(selected))
        return
    for cell in selected:
        flag = "f" if cell["formula"] else " "
        style = "" if cell["style"] is None else cell["style"]
        value = cell["value"] if cell["value"] is not None else ""
        logger.info(
            "%-5s s=%-4s %s %.80s",
            cell["ref"],
            style,
            flag,
            str(value).replace("\n", " "),
        )


def fill_palette(workdir: Path) -> tuple[list[dict[str, t.Any]], list[int | None]]:
    """Resolve the fill palette and the fill each cell-style (xf) points at.

    Each fill is reported with its raw definition and, where it is a solid fill, a
    resolved ``rgb`` hex string (theme colors are looked up in ``theme1.xml`` and
    any tint applied). This is what makes "fill in the blue fields" tractable: read
    the palette, decide which fill ids are blue, then ``scan --style`` the cell
    styles that use them.

    Args:
        workdir:
          Unpacked workbook directory.

    Returns:
        A ``(fills, xf_to_fill)`` pair. ``fills[i]`` describes fill ``i``;
        ``xf_to_fill[j]`` is the fill id used by cell-style ``j`` (the ``s=``
        attribute on a cell), or None.
    """
    styles = read(path=workdir / "xl" / "styles.xml")
    theme = _theme_colors(workdir=workdir)

    fills: list[dict[str, t.Any]] = []
    fills_block = re.search(r"<fills\b.*?</fills>", styles, flags=re.DOTALL)
    if fills_block:
        for fill in re.findall(
            r"<fill\b.*?</fill>", fills_block.group(0), flags=re.DOTALL
        ):
            pattern = re.search(r'patternType="([^"]*)"', fill)
            fg = re.search(r"<fgColor\b([^>]*)/?>", fill)
            rgb = _resolve_color(attrs=fg.group(1), theme=theme) if fg else None
            fills.append(
                {
                    "pattern": pattern.group(1) if pattern else None,
                    "fgColor": fg.group(1).strip() if fg else None,
                    "rgb": rgb,
                }
            )

    xf_to_fill: list[int | None] = []
    xfs_block = re.search(r"<cellXfs\b.*?</cellXfs>", styles, flags=re.DOTALL)
    if xfs_block:
        for xf in re.findall(
            r"<xf\b[^>]*?(?:/>|>.*?</xf>)", xfs_block.group(0), re.DOTALL
        ):
            fill_id = _attr(attrs=xf, name="fillId")
            xf_to_fill.append(int(fill_id) if fill_id is not None else None)
    return fills, xf_to_fill


def set_cell(
    raw: str,
    ref: str,
    value: str,
    kind: str = "auto",
    style: int | None = None,
) -> str:
    """Set or insert one cell, returning the updated worksheet text.

    If the cell exists it is replaced in place (its style is preserved unless
    ``style`` overrides it). If it does not exist it is inserted in the correct
    column position, creating the row if necessary. Formula cells are written
    without a cached value, so run ``recalc`` (or ``set --recalc``) afterwards so
    Excel refreshes dependent values on open.

    Args:
        raw:
          Full text of the worksheet part.
        ref:
          Cell address, e.g. ``B13``.
        value:
          The value to write. For ``formula`` it is the formula without a leading
          ``=``; for ``shared`` it is the shared-string index; for ``bool`` it is
          ``1``/``0`` or ``true``/``false``.
        kind (optional):
          One of ``auto`` (number if it parses, else inline string), ``number``,
          ``string``, ``formula``, ``shared`` or ``bool``. Defaults to ``auto``.
        style (optional):
          Style id for the cell. Defaults to keeping the existing cell's style, or
          none for a freshly inserted cell.

    Returns:
        The updated worksheet text.
    """
    col, row = parse_ref(ref=ref)
    col_num = col_to_num(col=col)

    cell_pat = re.compile(
        r'<c r="' + re.escape(ref) + r'"(?: [^>]*?)?(?:/>|>.*?</c>)', re.DOTALL
    )
    existing = cell_pat.search(raw)
    if existing:
        old_style = _attr(attrs=existing.group(0), name="s")
        keep = style if style is not None else (int(old_style) if old_style else None)
        new_cell = _build_cell(ref=ref, value=value, kind=kind, style=keep)
        return raw[: existing.start()] + new_cell + raw[existing.end() :]

    new_cell = _build_cell(ref=ref, value=value, kind=kind, style=style)
    return _insert_cell(raw=raw, ref=ref, row=row, col_num=col_num, cell=new_cell)


def enable_full_calc(workdir: Path) -> None:
    """Set ``fullCalcOnLoad`` so Excel recomputes every formula on next open.

    Cached formula results in the worksheet XML go stale the moment you change an
    input they depend on; this flag forces a clean recalculation. Safe to call
    repeatedly.

    Args:
        workdir:
          Unpacked workbook directory.
    """
    path = workdir / "xl" / "workbook.xml"
    raw = read(path=path)
    if "fullCalcOnLoad" in raw:
        return
    if "<calcPr" in raw:
        raw = re.sub(r"<calcPr\b", '<calcPr fullCalcOnLoad="1"', raw, count=1)
    else:
        raw = raw.replace("</workbook>", '<calcPr fullCalcOnLoad="1"/></workbook>')
    write(path=path, text=raw)


def validate(workdir: Path) -> bool:
    """Check every XML part in the workbook is well-formed.

    Logs a per-part report and an overall ``VALID``/``INVALID`` line.

    Args:
        workdir:
          Unpacked workbook directory.

    Returns:
        True if every ``.xml`` and ``.rels`` part parses, False otherwise.
    """
    ok = True
    count = 0
    for path in sorted(workdir.rglob("*")):
        if path.suffix not in {".xml", ".rels"} or not path.is_file():
            continue
        count += 1
        try:
            minidom.parseString(read(path=path))
        except Exception as exc:  # noqa: BLE001 - report any malformed XML uniformly
            ok = False
            logger.error("  FAIL %s: %s", path.relative_to(workdir), exc)
    if ok:
        logger.info("  ok   %d XML part(s) well-formed", count)
    logger.info("VALID" if ok else "INVALID")
    return ok


def pack(workdir: Path, xlsx: Path) -> None:
    """Re-zip ``workdir`` into ``xlsx`` and verify the archive integrity.

    The ``[Content_Types].xml`` part is written first, as the OOXML package format
    requires, and the archive is deflated.

    Args:
        workdir:
          Unpacked workbook directory.
        xlsx:
          Output .xlsx path.
    """
    entries = [
        (path, path.relative_to(workdir).as_posix())
        for path in workdir.rglob("*")
        if path.is_file()
    ]
    entries.sort(key=lambda pair: (pair[1] != CONTENT_TYPES, pair[1]))
    with zipfile.ZipFile(xlsx, "w", zipfile.ZIP_DEFLATED) as archive:
        for full, arcname in entries:
            archive.write(full, arcname)
    with zipfile.ZipFile(xlsx) as archive:
        corrupt = archive.testzip()
    size = xlsx.stat().st_size
    if corrupt:
        logger.error("packed -> %s (%d bytes) CORRUPT: %s", xlsx, size, corrupt)
    else:
        logger.info("packed -> %s (%d bytes) (integrity ok)", xlsx, size)


def parse_ref(ref: str) -> tuple[str, int]:
    """Split a cell address into its column letters and 1-based row number.

    Args:
        ref:
          Cell address such as ``AB12``.

    Returns:
        A ``(column_letters, row_number)`` pair.

    Raises:
        ValueError:
          If ``ref`` is not a plain ``A1``-style address.
    """
    match = re.match(r"^([A-Z]+)(\d+)$", ref)
    if not match:
        raise ValueError(f"not an A1-style cell ref: {ref!r}")
    return match.group(1), int(match.group(2))


def col_to_num(col: str) -> int:
    """Convert column letters to a 1-based column number (``A``->1, ``AA``->27).

    Args:
        col:
          Column letters.

    Returns:
        The 1-based column index.
    """
    number = 0
    for char in col:
        number = number * 26 + (ord(char) - ord("A") + 1)
    return number


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


def _build_cell(ref: str, value: str, kind: str, style: int | None) -> str:
    """Build one ``<c>`` element for ``set_cell``.

    Args:
        ref:
          Cell address.
        value:
          The value, interpreted per ``kind``.
        kind:
          ``auto``/``number``/``string``/``formula``/``shared``/``bool``.
        style:
          Style id, or None to omit the ``s`` attribute.

    Returns:
        A ``<c ...>...</c>`` element.
    """
    attr = f' s="{style}"' if style is not None else ""
    resolved = kind
    if kind == "auto":
        resolved = "number" if _is_number(value=value) else "string"
    if resolved == "number":
        return f'<c r="{ref}"{attr}><v>{escape(text=value)}</v></c>'
    if resolved == "formula":
        return f'<c r="{ref}"{attr}><f>{escape(text=value.lstrip("="))}</f></c>'
    if resolved == "shared":
        return f'<c r="{ref}"{attr} t="s"><v>{int(value)}</v></c>'
    if resolved == "bool":
        flag = "1" if value.strip().lower() in {"1", "true"} else "0"
        return f'<c r="{ref}"{attr} t="b"><v>{flag}</v></c>'
    return (
        f'<c r="{ref}"{attr} t="inlineStr"><is>'
        f'<t xml:space="preserve">{escape(text=value)}</t></is></c>'
    )


def _insert_cell(raw: str, ref: str, row: int, col_num: int, cell: str) -> str:
    """Insert a new cell into the right row and column position.

    Args:
        raw:
          Worksheet text.
        ref:
          Cell address being inserted.
        row:
          1-based row number.
        col_num:
          1-based column number of the cell.
        cell:
          The ``<c>`` element to insert.

    Returns:
        The updated worksheet text.

    Raises:
        ValueError:
          If the worksheet has no ``<sheetData>`` element.
    """
    row_pat = re.compile(
        r'<row r="' + str(row) + r'"(?: [^>]*?)?(?:/>|>.*?</row>)', re.DOTALL
    )
    match = row_pat.search(raw)
    if match:
        element = match.group(0)
        if element.endswith("/>"):
            new_row = element[:-2] + ">" + cell + "</row>"
            return raw[: match.start()] + new_row + raw[match.end() :]
        insert_at = element.rindex("</row>")
        for sibling in re.finditer(r'<c r="([A-Z]+)\d+"', element):
            if col_to_num(col=sibling.group(1)) > col_num:
                insert_at = sibling.start()
                break
        new_row = element[:insert_at] + cell + element[insert_at:]
        return raw[: match.start()] + new_row + raw[match.end() :]

    new_row = f'<row r="{row}">{cell}</row>'
    data = re.search(r"<sheetData\b[^>]*?(/>|>)", raw)
    if not data:
        raise ValueError("worksheet has no <sheetData>")
    if data.group(1) == "/>":
        opening = data.group(0)[:-2] + ">"
        return (
            raw[: data.start()] + opening + new_row + "</sheetData>" + raw[data.end() :]
        )
    body_start = data.end()
    body_end = raw.index("</sheetData>", body_start)
    insert_at = body_end
    for sibling in re.finditer(r'<row r="(\d+)"', raw[body_start:body_end]):
        if int(sibling.group(1)) > row:
            insert_at = body_start + sibling.start()
            break
    return raw[:insert_at] + new_row + raw[insert_at:]


def _resolve(
    cell_type: str | None, raw_value: str | None, strings: list[str]
) -> str | None:
    """Resolve a cell's stored value to display text.

    Args:
        cell_type:
          The ``t`` attribute (``s``, ``inlineStr``, ``str``, ``b`` or None).
        raw_value:
          The stored ``<v>`` text or inline-string text.
        strings:
          Shared-string table.

    Returns:
        The resolved value, or None if the cell is empty.
    """
    if raw_value is None:
        return None
    if cell_type == "s":
        index = int(raw_value)
        return strings[index] if 0 <= index < len(strings) else f"<s:{index}>"
    if cell_type == "b":
        return "TRUE" if raw_value == "1" else "FALSE"
    return _unescape(text=raw_value)


def _theme_colors(workdir: Path) -> dict[str, str]:
    """Map theme color names to RGB hex from ``xl/theme/theme1.xml``.

    Args:
        workdir:
          Unpacked workbook directory.

    Returns:
        A mapping such as ``{"accent1": "5B9BD5", ...}``; empty if no theme part.
    """
    path = workdir / "xl" / "theme" / "theme1.xml"
    if not path.exists():
        return {}
    scheme = re.search(r"<a:clrScheme\b.*?</a:clrScheme>", read(path=path), re.DOTALL)
    if not scheme:
        return {}
    values = re.findall(
        r"<a:(sysClr|srgbClr)\b[^>]*?(?:val|lastClr)=\"([0-9A-Fa-f]{6})\"",
        scheme.group(0),
    )
    return {
        THEME_ORDER[i]: rgb.upper()
        for i, (_, rgb) in enumerate(values)
        if i < len(THEME_ORDER)
    }


def _resolve_color(attrs: str, theme: dict[str, str]) -> str | None:
    """Resolve a color element's attributes to an RGB hex string.

    Args:
        attrs:
          The attribute text of an ``<fgColor .../>`` element.
        theme:
          Theme color map from ``_theme_colors``.

    Returns:
        Six-hex-digit RGB (no alpha), or None if it cannot be resolved.
    """
    rgb_match = re.search(r'rgb="[0-9A-Fa-f]{0,2}([0-9A-Fa-f]{6})"', attrs)
    if rgb_match:
        return rgb_match.group(1).upper()
    theme_match = re.search(r'theme="(\d+)"', attrs)
    if not theme_match:
        return None
    index = int(theme_match.group(1))
    if index >= len(THEME_INDEX):
        return None
    base = theme.get(THEME_INDEX[index])
    if base is None:
        return None
    tint_match = re.search(r'tint="([-0-9.eE]+)"', attrs)
    return _apply_tint(rgb=base, tint=float(tint_match.group(1)) if tint_match else 0.0)


def _apply_tint(rgb: str, tint: float) -> str:
    """Apply an OOXML luminance tint to an RGB hex string.

    Args:
        rgb:
          Six-hex-digit base color.
        tint:
          Tint in ``[-1, 1]``; negative darkens, positive lightens.

    Returns:
        The tinted color as six hex digits.
    """
    if tint == 0:
        return rgb
    red, green, blue = (int(rgb[i : i + 2], 16) / 255 for i in (0, 2, 4))
    hue, lum, sat = colorsys.rgb_to_hls(red, green, blue)
    lum = lum * (1 + tint) if tint < 0 else lum * (1 - tint) + tint
    red, green, blue = colorsys.hls_to_rgb(hue, max(0.0, min(1.0, lum)), sat)
    return f"{round(red * 255):02X}{round(green * 255):02X}{round(blue * 255):02X}"


def _attr(attrs: str, name: str) -> str | None:
    """Read one attribute value from a tag's attribute text.

    Args:
        attrs:
          The attribute portion of a tag (or the whole tag).
        name:
          Attribute name.

    Returns:
        The attribute value, or None if absent.
    """
    match = re.search(r"\b" + re.escape(name) + r'="([^"]*)"', attrs)
    return match.group(1) if match else None


def _is_number(value: str) -> bool:
    """Report whether ``value`` parses as a number.

    Args:
        value:
          Candidate text.

    Returns:
        True if ``float(value)`` succeeds.
    """
    try:
        float(value)
    except ValueError:
        return False
    return True


def _print_sheets(workdir: Path) -> None:
    """Print the worksheet list as a table.

    Args:
        workdir:
          Unpacked workbook directory.
    """
    for sheet in list_sheets(workdir=workdir):
        logger.info(
            "%2d  %-40s id=%-3s %s",
            sheet["index"] + 1,
            sheet["name"],
            sheet["sheet_id"],
            sheet["path"],
        )


def _print_fills(workdir: Path) -> None:
    """Print the fill palette and the style ids that use each fill.

    Args:
        workdir:
          Unpacked workbook directory.
    """
    fills, xf_to_fill = fill_palette(workdir=workdir)
    users: dict[int, list[int]] = {}
    for xf_index, fill_id in enumerate(xf_to_fill):
        if fill_id is not None:
            users.setdefault(fill_id, []).append(xf_index)
    for index, fill in enumerate(fills):
        rgb = f"#{fill['rgb']}" if fill["rgb"] else "-"
        styles = users.get(index, [])
        logger.info(
            "fill %-3d %-9s rgb=%-8s styles(s=)=%s",
            index,
            fill["pattern"] or "",
            rgb,
            styles,
        )


def _unescape(text: str) -> str:
    """Reverse XML escaping for extracted text.

    Args:
        text:
          Escaped text.

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
