"""Tests for the xlsx_surgeon surgical editing helpers."""

from __future__ import annotations

import zipfile
from pathlib import Path

import pytest

from xlsx_surgeon.main import (
    col_to_num,
    enable_full_calc,
    fill_palette,
    iter_cells,
    list_sheets,
    pack,
    parse_ref,
    read,
    set_cell,
    shared_strings,
    sheet_path,
    unpack,
    validate,
)


def test_unpack_backs_up_and_lists_sheets(tmp_path: Path) -> None:
    """Unpacking writes a one-time backup and the workbook lists its sheets."""
    xlsx = _make_minimal_xlsx(path=tmp_path / "book.xlsx")
    work = tmp_path / "work"
    unpack(xlsx=xlsx, workdir=work)

    assert xlsx.with_name("book.xlsx.backup").exists()
    sheets = list_sheets(workdir=work)
    assert [s["name"] for s in sheets] == ["Data"]
    assert sheets[0]["path"] == "xl/worksheets/sheet1.xml"


def test_scan_resolves_shared_strings_and_formulas(tmp_path: Path) -> None:
    """Cells resolve shared strings, numbers and formulas with their addresses."""
    xlsx = _make_minimal_xlsx(path=tmp_path / "book.xlsx")
    work = tmp_path / "work"
    unpack(xlsx=xlsx, workdir=work)

    cells = {
        c["ref"]: c
        for c in iter_cells(
            raw=read(path=sheet_path(workdir=work, sheet="Data")),
            strings=shared_strings(workdir=work),
        )
    }
    assert cells["A1"]["value"] == "Hello"
    assert cells["B1"]["value"] == "10"
    assert cells["B2"]["formula"] == "B1*2"


def test_set_cell_replaces_inserts_and_preserves_style(tmp_path: Path) -> None:
    """set_cell replaces in place keeping style, and inserts new cells in order."""
    xlsx = _make_minimal_xlsx(path=tmp_path / "book.xlsx")
    work = tmp_path / "work"
    unpack(xlsx=xlsx, workdir=work)
    path = sheet_path(workdir=work, sheet="Data")

    raw = read(path=path)
    raw = set_cell(raw=raw, ref="B1", value="42")  # replace, keep style s="1"
    raw = set_cell(raw=raw, ref="A2", value="World")  # insert before existing B2
    cells = {
        c["ref"]: c for c in iter_cells(raw=raw, strings=shared_strings(workdir=work))
    }

    assert cells["B1"]["value"] == "42" and cells["B1"]["style"] == 1
    assert cells["A2"]["value"] == "World"
    assert raw.index('r="A2"') < raw.index('r="B2"')  # column order preserved


def test_set_cell_formula_then_recalc(tmp_path: Path) -> None:
    """A formula cell carries no cached value and recalc flips fullCalcOnLoad on."""
    xlsx = _make_minimal_xlsx(path=tmp_path / "book.xlsx")
    work = tmp_path / "work"
    unpack(xlsx=xlsx, workdir=work)
    path = sheet_path(workdir=work, sheet="Data")

    raw = set_cell(raw=read(path=path), ref="C1", value="=A1&B1", kind="formula")
    assert "<f>A1&amp;B1</f>" in raw and 'r="C1"' in raw

    enable_full_calc(workdir=work)
    assert 'fullCalcOnLoad="1"' in read(path=work / "xl" / "workbook.xml")


def test_fill_palette_resolves_theme_blue(tmp_path: Path) -> None:
    """The fill palette resolves a theme-4 (accent1) fill to a blue rgb."""
    xlsx = _make_minimal_xlsx(path=tmp_path / "book.xlsx")
    work = tmp_path / "work"
    unpack(xlsx=xlsx, workdir=work)

    fills, xf_to_fill = fill_palette(workdir=work)
    assert fills[2]["rgb"] == "5B9BD5"  # accent1, no tint
    assert xf_to_fill[1] == 2  # cell style s="1" uses the blue fill


def test_round_trip_validates(tmp_path: Path) -> None:
    """An edited workbook packs, reopens and stays well-formed."""
    xlsx = _make_minimal_xlsx(path=tmp_path / "book.xlsx")
    work = tmp_path / "work"
    unpack(xlsx=xlsx, workdir=work)
    path = sheet_path(workdir=work, sheet="Data")
    (path).write_text(
        set_cell(raw=read(path=path), ref="A1", value="Changed", kind="string")
    )
    assert validate(workdir=work) is True

    out = tmp_path / "out.xlsx"
    pack(workdir=work, xlsx=out)
    reopened = tmp_path / "reopened"
    unpack(xlsx=out, workdir=reopened)
    assert validate(workdir=reopened) is True


def test_ref_helpers() -> None:
    """Address parsing and column arithmetic behave at the boundaries."""
    assert parse_ref(ref="AB12") == ("AB", 12)
    assert col_to_num(col="A") == 1
    assert col_to_num(col="AA") == 27
    with pytest.raises(ValueError, match="A1-style"):
        parse_ref(ref="B")


def _make_minimal_xlsx(path: Path) -> Path:
    """Create a minimal but valid .xlsx with one sheet, a string, a number, a formula.

    Style ``s="1"`` uses a solid theme-4 (accent1) fill so the fill-palette test
    has a "blue" cell to find.

    Args:
        path:
          Output .xlsx path.

    Returns:
        The path written.
    """
    parts = {
        "[Content_Types].xml": (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-'
            'package.relationships+xml"/><Default Extension="xml" '
            'ContentType="application/xml"/><Override PartName="/xl/workbook.xml" '
            'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.'
            'sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" '
            'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.'
            'worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" '
            'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.'
            'sharedStrings+xml"/><Override PartName="/xl/styles.xml" '
            'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.'
            'styles+xml"/></Types>'
        ),
        "_rels/.rels": (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/'
            'relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.'
            'org/officeDocument/2006/relationships/officeDocument" '
            'Target="xl/workbook.xml"/></Relationships>'
        ),
        "xl/workbook.xml": (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
            'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
            '<sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets>'
            '<calcPr calcId="191029"/></workbook>'
        ),
        "xl/_rels/workbook.xml.rels": (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/'
            'relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.'
            'org/officeDocument/2006/relationships/worksheet" '
            'Target="worksheets/sheet1.xml"/><Relationship Id="rId2" '
            'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/'
            'sharedStrings" Target="sharedStrings.xml"/><Relationship Id="rId3" '
            'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/'
            'styles" Target="styles.xml"/></Relationships>'
        ),
        "xl/worksheets/sheet1.xml": (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
            '<sheetData><row r="1"><c r="A1" t="s"><v>0</v></c>'
            '<c r="B1" s="1"><v>10</v></c></row>'
            '<row r="2"><c r="B2"><f>B1*2</f><v>20</v></c></row>'
            "</sheetData></worksheet>"
        ),
        "xl/sharedStrings.xml": (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
            'count="1" uniqueCount="1"><si><t>Hello</t></si></sst>'
        ),
        "xl/styles.xml": (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
            '<fills count="3"><fill><patternFill patternType="none"/></fill>'
            '<fill><patternFill patternType="gray125"/></fill>'
            '<fill><patternFill patternType="solid"><fgColor theme="4"/></patternFill></fill>'
            "</fills>"
            '<cellXfs count="2"><xf fillId="0"/><xf fillId="2"/></cellXfs></styleSheet>'
        ),
        "xl/theme/theme1.xml": (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
            'name="Office"><a:themeElements><a:clrScheme name="Office">'
            '<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>'
            '<a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>'
            '<a:dk2><a:srgbClr val="44546A"/></a:dk2>'
            '<a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>'
            '<a:accent1><a:srgbClr val="5B9BD5"/></a:accent1>'
            '<a:accent2><a:srgbClr val="ED7D31"/></a:accent2>'
            '<a:accent3><a:srgbClr val="A5A5A5"/></a:accent3>'
            '<a:accent4><a:srgbClr val="FFC000"/></a:accent4>'
            '<a:accent5><a:srgbClr val="4472C4"/></a:accent5>'
            '<a:accent6><a:srgbClr val="70AD47"/></a:accent6>'
            '<a:hlink><a:srgbClr val="0563C1"/></a:hlink>'
            '<a:folHlink><a:srgbClr val="954F72"/></a:folHlink>'
            "</a:clrScheme></a:themeElements></a:theme>"
        ),
    }
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, content in parts.items():
            archive.writestr(name, content)
    return path
