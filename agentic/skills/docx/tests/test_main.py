"""Tests for the docx_surgeon surgical editing helpers."""

from __future__ import annotations

import zipfile
from pathlib import Path

import pytest

from docx_surgeon.main import (
    append_comments,
    apply_edits,
    comment_block,
    document_path,
    ensure_comments_part,
    iter_blocks,
    pack,
    para,
    read,
    replace_once,
    sample_rpr,
    unpack,
    validate,
    write,
)


def test_unpack_creates_backup_and_scans_blocks(tmp_path: Path) -> None:
    """Unpacking writes a one-time backup and the body parses into ordered blocks."""
    docx = _make_minimal_docx(path=tmp_path / "sample.docx")
    work = tmp_path / "work"
    unpack(docx=docx, workdir=work)

    assert docx.with_name("sample.docx.backup").exists()
    blocks = iter_blocks(raw=read(path=document_path(workdir=work)))
    kinds = [block["kind"] for block in blocks]
    assert kinds == ["w:p", "w:p", "w:sectPr"]
    assert blocks[0]["style"] == "Heading1"
    assert blocks[1]["style"] is None
    assert "Original body" in blocks[1]["text"]


def test_edit_with_comment_round_trips_and_validates(tmp_path: Path) -> None:
    """A span edit plus a balanced comment survives a pack/unpack round-trip."""
    docx = _make_minimal_docx(path=tmp_path / "sample.docx")
    work = tmp_path / "work"
    unpack(docx=docx, workdir=work)

    raw = read(path=document_path(workdir=work))
    rpr = sample_rpr(workdir=work)
    body = next(b for b in iter_blocks(raw=raw) if "Original body" in b["text"])
    replacement = para(
        text="Replacement body text.", rpr=rpr, comment_start=1, comment_end=1
    )
    edited = apply_edits(raw=raw, edits=[(body["start"], body["end"], replacement)])
    write(path=document_path(workdir=work), text=edited)

    ensure_comments_part(workdir=work)
    append_comments(
        workdir=work,
        blocks=[comment_block(comment_id=1, text="Please verify.")],
    )
    assert validate(workdir=work) is True

    out = tmp_path / "out.docx"
    pack(workdir=work, docx=out)
    reopened = tmp_path / "reopened"
    unpack(docx=out, workdir=reopened)
    assert validate(workdir=reopened) is True
    assert "Replacement body text." in read(path=document_path(workdir=reopened))


def test_apply_edits_rejects_overlap() -> None:
    """Overlapping edits raise rather than silently corrupting the text."""
    with pytest.raises(ValueError, match="overlapping"):
        apply_edits(raw="abcdef", edits=[(0, 3, "X"), (2, 5, "Y")])


def test_replace_once_enforces_count() -> None:
    """replace_once refuses to act unless the match count is exactly as expected."""
    assert replace_once(raw="one two one", old="two", new="2") == "one 2 one"
    with pytest.raises(ValueError, match="expected 1"):
        replace_once(raw="a a a", old="a", new="b")


def _make_minimal_docx(path: Path) -> Path:
    """Create a minimal but valid .docx with a heading and one body paragraph.

    Args:
        path:
          Output .docx path.

    Returns:
        The path written.
    """
    parts = {
        "[Content_Types].xml": (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/'
            'content-types"><Default Extension="rels" ContentType="application/'
            'vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" '
            'ContentType="application/xml"/><Override PartName="/word/document.xml" '
            'ContentType="application/vnd.openxmlformats-officedocument.'
            'wordprocessingml.document.main+xml"/></Types>'
        ),
        "_rels/.rels": (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/'
            'relationships"><Relationship Id="rId1" Type="http://schemas.'
            'openxmlformats.org/officeDocument/2006/relationships/officeDocument" '
            'Target="word/document.xml"/></Relationships>'
        ),
        "word/_rels/document.xml.rels": (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/'
            'relationships"></Relationships>'
        ),
        "word/document.xml": (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/'
            '2006/main"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr>'
            "<w:r><w:t>Title</w:t></w:r></w:p><w:p><w:pPr><w:rPr>"
            '<w:rFonts w:ascii="Aptos"/></w:rPr></w:pPr><w:r><w:rPr>'
            '<w:rFonts w:ascii="Aptos"/></w:rPr><w:t xml:space="preserve">'
            "Original body paragraph text.</w:t></w:r></w:p><w:sectPr/></w:body>"
            "</w:document>"
        ),
    }
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, content in parts.items():
            archive.writestr(name, content)
    return path
