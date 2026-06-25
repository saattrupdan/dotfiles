---
name: docx
description: Edit Microsoft Word .docx files in place while preserving all formatting — surgical raw-OOXML editing, Word comments, page breaks, character-limit fields. Use when filling in or revising .docx documents (grant applications, forms, reports) rather than regenerating them.
tagline: Formatting-preserving surgical editing of Word .docx files
last-updated: 2026-06-25
autoload:
  tools:
    - read
    - write
    - edit
    - bash
  extensions:
    - .docx
---

# Editing .docx Files In Place

A `.docx` is a ZIP archive of XML parts. The body text is `word/document.xml`;
comments live in `word/comments.xml`. The goal of this skill is to **change the
content a human wrote without disturbing the formatting, styles, page breaks,
headers/footers, or revision metadata** that Word cares about.

## Core principle: surgical raw-text editing, never re-serialise

Do **not** parse `document.xml` with an XML library and write it back. Generic
serialisers reorder attributes, drop `mc:AlternateContent` fallbacks, normalise
namespaces and rewrite `w:rsid*` bookkeeping — Word flags the result as repaired
or corrupt. Instead treat `document.xml` as **raw UTF-8 text** and replace only the
exact byte spans you target. Everything you don't touch stays byte-identical.

Two ways to make a change:

- **Targeted string replacement** for small edits (a value, a sentence, a name):
  assert the old string occurs exactly N times, then replace. Use
  `replace_once()`.
- **Span replacement by offset** for rewriting whole fields/sections: `scan` the
  body to get each block's byte offsets, build new paragraph XML, and replace the
  `[start, end]` span. Use `apply_edits()`.

Avoid pandoc / `python-docx` for in-place edits — both rewrite the whole document.

## CLI

All mechanical steps go through the `docx` CLI (standard library only). The same
module is importable for per-document build scripts (see the example below).

```bash
docx unpack app.docx work/      # extracts to work/, writes app.docx.backup once
docx scan   work/               # numbered blocks: index, style, comment ids, text
docx scan   work/ --json        # same, machine-readable, with byte offsets
docx ensure-comments work/      # create comments part + rel + content-type if absent
docx validate work/             # XML well-formed + comment ranges balanced
docx pack   work/ app.docx      # re-zip ([Content_Types].xml first, DEFLATED)
```

### Install

Verify it is on the PATH, and install it editable with pipx from the skill
directory if missing:

```bash
which docx || pipx install -e ~/gitsky/dotfiles/agentic/skills/docx
```

For development inside the skill directory, run via uv instead: `uv run docx scan
work/`, `uv run pytest`, `uv run ruff check`, `uv run ty check`.

`scan` is the map you edit against: each row is a top-level child of `<w:body>`
with its paragraph style (`Heading1`, `normal`, `italic`, …), any comment-range ids
it carries, and a text preview. Headings, italic helper/instruction paragraphs and
empty spacer paragraphs all show up so you can see exactly what to keep.

## The workflow that works

1. **Unpack with a backup.** `unpack` copies `app.docx` → `app.docx.backup` once
   (never overwrites an existing backup). Keep the true original untouched.
2. **Scan** to locate the blocks you'll change. Note their indices/offsets.
3. **Write a small build script** that imports `docx_surgeon`, reads a *pristine*
   copy of `document.xml`, applies your edits, and writes the working copy. Make it
   **idempotent**: read from a pristine `base/word/document.xml`, write to
   `work/word/document.xml`. Then you can re-run it freely while iterating on
   wording without re-extracting or stacking edits. Recompute offsets from a fresh
   scan whenever the document on disk has actually changed.
4. **Apply edits high-offset → low-offset** (`apply_edits` does this) so earlier
   offsets remain valid as you splice.
5. **Validate** (`validate`): XML well-formedness of both parts + comment-range
   balance.
6. **Pack** and finally `unzip -t app.docx` (pack already checks integrity).

When rewriting prose fields, **preserve the italic instruction/helper paragraphs**
and **empty spacer paragraphs and page breaks** — only replace the body paragraphs
that hold the answer. Match the body run properties with `sample_rpr(workdir)`
rather than hardcoding a font; the `<w:rPr>` (font, colour, `w:lang`) is
document-specific. Build paragraphs with `para(text, rpr, …)`.

## Word comments (flagging content for review)

Comments are excellent for marking invented facts, new references, or anything that
needs human verification. A comment has three parts that must stay consistent:

1. A `<w:comment w:id=N …>` element in `word/comments.xml` (build with
   `comment_block`). Append with `append_comments`.
2. An in-body **range**: `<w:commentRangeStart w:id="N"/>` before the text and
   `<w:commentRangeEnd w:id="N"/>` after it, followed by a run containing
   `<w:commentReference w:id="N"/>`. `para()` emits these when you pass
   `comment_start` / `comment_end`.
3. The plumbing: a relationship in `word/_rels/document.xml.rels` (type
   `…/comments`) and an override in `[Content_Types].xml`. `ensure_comments_part`
   creates `comments.xml` + both of these if the document has none yet.

Rules that keep Word happy (the validator checks these):

- Every id used in the body must have a **start, an end, and a reference**, and be
  **defined** in `comments.xml`. Sets must be equal.
- A comment may span **multiple paragraphs**: put `commentRangeStart` on the first
  paragraph and `commentRangeEnd` + the reference run on the last. For a
  single-paragraph comment, set both on the same paragraph.
- Editing the *text* inside a commented paragraph is fine — the range markers are
  separate elements around the run, so they survive a text replacement. But if you
  **replace a whole paragraph that carried a marker**, re-emit that marker (same id)
  on the replacement, or the ranges go unbalanced.
- New comment ids continue the existing sequence (scan for the current max).

## Character-limit fields

Form-style docs (grant applications, etc.) often state a limit like
"(2000 characters)" in the field heading. Count the **visible text** you place in
that field (sum of `len(text)` across its body paragraphs, excluding the italic
helper and heading) and keep it at/just under the limit. A build script that prints
`chars / limit / %` per field makes "get close to the limit" tractable and catches
overruns before packing.

## Gotchas

- **Backup before the first pack.** Re-zipping replaces the file; keep
  `app.docx.backup` and don't overwrite it on re-runs.
- **`[Content_Types].xml` must be the first archive entry**; use `ZIP_DEFLATED`.
  `pack` handles both.
- **UTF-8 everywhere.** Danish/diacritic characters (ø, æ, å, ü) must round-trip;
  read/write with `encoding="utf-8"`. When sorting references or names, fold
  diacritics for the sort key (`unicodedata.normalize('NFKD', …)`), or `ü`/`å`
  sort after `z`.
- **Parsing a fragment** (a single `<w:p>…`) with an XML library fails on undefined
  namespace prefixes. Wrap it: `<x {nsdecl}>{fragment}</x>` using the `xmlns:*`
  declarations from the `<w:document …>` tag (`iter_blocks` does this).
- **Text may be split across runs.** A sentence can be several `<w:r><w:t>` runs, so
  a substring search can miss it. Text you *authored* via `para()` is a single run,
  so round-trip edits to your own content are safe; for pre-existing text, check the
  run structure (`scan --json`, then inspect `raw[start:end]`) before string-matching.
- **Disambiguate same author+year citations** with `2024a` / `2024b` in both the
  in-text marker and the reference list.
- **Don't trust an edit you didn't verify.** Always `validate` and `unzip -t`, and
  re-`scan` to confirm the change landed where intended.

## Example: rewrite one field and flag it

```python
from pathlib import Path
import docx_surgeon as dx

base = Path("base/word/document.xml")              # pristine source (idempotent)
work = Path("work")
raw = dx.read(path=base)
rpr = dx.sample_rpr(workdir=work)                  # match body style
blk = next(b for b in dx.iter_blocks(raw=raw)      # find the field's body paragraph
           if b["text"].startswith("Old answer text"))
new = dx.para(text="New, longer answer.", rpr=rpr, comment_start=18, comment_end=18)
out = dx.apply_edits(raw=raw, edits=[(blk["start"], blk["end"], new)])
dx.write(path=dx.document_path(workdir=work), text=out)
dx.ensure_comments_part(workdir=work)
dx.append_comments(workdir=work, blocks=[
    dx.comment_block(comment_id=18, text="New claim - please verify.",
                     author="Reviewer", initials="RV")])
# then:  docx validate work/  &&  docx pack work/ app.docx
```
