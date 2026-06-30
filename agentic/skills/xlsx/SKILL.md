---
name: xlsx
description: Edit Microsoft Excel .xlsx files in place while preserving all formatting — surgical raw-OOXML cell editing that keeps styles, charts, data validations, formulas and named ranges intact. Use when filling in or revising .xlsx workbooks (bid sheets, budgets, forms, trackers) rather than regenerating them.
tagline: Formatting-preserving surgical editing of Excel .xlsx files
last-updated: 2026-06-30
autoload:
  tools:
    - read
    - write
    - edit
    - bash
  extensions:
    - .xlsx
---

# Editing .xlsx Files In Place

An `.xlsx` is a ZIP archive of XML parts. The sheet list is `xl/workbook.xml`; each
worksheet's cells live in `xl/worksheets/sheetN.xml`; text is pooled in
`xl/sharedStrings.xml`; formatting (fonts, fills, number formats) is in
`xl/styles.xml`. The goal of this skill is to **change the values a human entered
without disturbing the formulas, styles, fills, charts, data validations,
conditional formatting, named ranges or calc settings** that Excel cares about.

## Core principle: surgical raw-text editing, never re-serialise

Do **not** rewrite the workbook with `openpyxl` / `pandas`, and do **not** parse a
sheet with a generic XML library and write it back. openpyxl silently drops charts,
pivot tables, some data validations and VBA, and discards every cached formula
value; generic serialisers reorder attributes and normalise namespaces. Excel then
reports the file as repaired or shows blank cells where formulas used to be.
Instead treat each XML part as **raw UTF-8 text** and replace only the exact cells
you target. Everything you don't touch stays byte-identical.

## CLI

All mechanical steps go through the `xlsx` CLI (standard library only). The same
module is importable for per-workbook build scripts (see the example below).

```bash
xlsx unpack book.xlsx work/        # extract to work/, writes book.xlsx.backup once
xlsx sheets work/                  # tab order: index, name, sheetId, part path
xlsx scan   work/ "Sheet1"         # cells: ref, style id, formula flag, value
xlsx scan   work/ 2 --all --json   # by index; include empty styled cells; JSON
xlsx fills  work/                  # resolve fill palette to RGB + styles using each
xlsx set    work/ "Sheet1" B13 8000000        # set/insert one cell
xlsx recalc work/                  # force Excel to recompute formulas on open
xlsx validate work/                # every XML part well-formed
xlsx pack   work/ book.xlsx        # re-zip ([Content_Types].xml first, DEFLATED)
```

### Install

Verify it is on the PATH, and install it editable with pipx from the skill
directory if missing:

```bash
which xlsx || pipx install -e ~/gitsky/dotfiles/agentic/skills/xlsx
```

For development inside the skill directory, run via uv instead: `uv run xlsx scan
work/ 1`, `uv run pytest`, `uv run ruff check`, `uv run ty check`.

`scan` is the map you edit against: each row is one `<c>` cell with its address,
its style id (the `s=` attribute), an `f` flag if it holds a formula, and the
resolved value (shared strings and booleans are decoded for you). `--style N,M`
narrows output to cells using those style ids; `--all` adds empty-but-styled cells,
which is how you find blank input fields.

## The workflow that works

1. **Unpack with a backup.** `unpack` copies `book.xlsx` → `book.xlsx.backup` once
   (never overwrites an existing backup). Keep the true original untouched.
2. **`sheets`** to map tab names to part files, then **`scan`** the sheet you'll
   change to see cell addresses, styles and which cells are formulas.
3. **Set values** with `xlsx set` (one cell) or a small build script importing
   `xlsx_surgeon` (many cells). `set_cell` replaces an existing cell in place —
   **preserving its style** unless you override it — or inserts a new cell in the
   correct column/row position.
4. **`recalc`** (or `set --recalc`) whenever you changed any cell a formula reads.
5. **`validate`** that every XML part is well-formed.
6. **`pack`** and finally `unzip -t book.xlsx` (pack already checks integrity).

## Cell values: types matter

A worksheet cell is `<c r="B13" s="149">...</c>` where `s` is the style id. How the
value is stored depends on its type — `xlsx set --type` (or `set_cell(kind=...)`)
picks the right encoding:

- **number** — `<v>8000000</v>`. The default for anything that parses as a number.
- **string** — `t="inlineStr"><is><t>text</t></is>`. Prefer **inline strings** for
  new text: they live in the cell, so you never have to touch `sharedStrings.xml`
  or its `count`/`uniqueCount`. (Pre-existing text cells use `t="s"` with an index
  into the shared table — leave those as they are unless you're changing the text.)
- **formula** — `<f>B13/(1-B15)*B15</f>`, written **without** a cached `<v>`. Give
  the formula without a leading `=`.
- **shared** — `t="s"><v>214</v>`, where the value is an index into
  `sharedStrings.xml`. Use this only to point a cell at an existing pooled string
  (e.g. switching a dropdown answer to another allowed value).
- **bool** — `t="b"><v>1</v>`.

`auto` (the default) writes a number if the value parses as one, otherwise an
inline string.

## Formulas and recalculation (do not skip this)

Each formula cell stores a **cached result** next to the formula (`<f>…</f><v>…</v>`).
The moment you change an input a formula depends on, that cache is stale — Excel
will keep showing the old number until something forces a recompute. After any edit
to a formula input, run `xlsx recalc work/` (or `xlsx set … --recalc`). It sets
`fullCalcOnLoad="1"` on `<calcPr>` in `workbook.xml`, so Excel recalculates the
whole workbook on open. When you write a **new** formula with `set`, no `<v>` is
emitted, so recalc is likewise required for it to show a value.

## Finding fields by colour ("fill in the blue fields")

Forms often mark the cells a human should fill with a coloured fill. To act on
"the blue fields":

1. `xlsx fills work/` lists every fill with its resolved RGB (theme colours are
   looked up in `theme1.xml` and any tint applied) and **which style ids (`s=`)
   use it**. Pick the style ids whose fill reads blue (Office theme `accent1` is
   `#5B9BD5`; lighter tints like `#B4C7E7`/`#D9E2F3` are the usual input shades).
2. `xlsx scan work/ "Sheet1" --style 9,135,185,190 --all` lists exactly the cells
   carrying those styles — your input fields, including the empty ones.
3. `xlsx set` each one. Because `set_cell` preserves the cell's style, the blue
   fill stays after you write the value.

## Gotchas

- **Backup before the first pack.** Re-zipping replaces the file; keep
  `book.xlsx.backup` and don't overwrite it on re-runs.
- **`[Content_Types].xml` must be the first archive entry**; use `ZIP_DEFLATED`.
  `pack` handles both.
- **Recalc after editing formula inputs** — otherwise cached results stay stale and
  the sheet looks wrong (often full of `0`s) until a cell is touched. See above.
- **Don't renumber shared strings.** Adding text via `t="s"` would require keeping
  `sharedStrings.xml` and its `count`/`uniqueCount` consistent. Use inline strings
  for new text and avoid the whole problem.
- **Respect data validations.** A cell with a dropdown (data validation list) only
  accepts values from its list. When changing such a cell, set it to one of the
  allowed strings (often via `--type shared` pointing at the existing pooled value),
  not arbitrary text, or Excel flags it.
- **UTF-8 everywhere.** Danish/diacritic characters (ø, æ, å, ü) must round-trip;
  the CLI reads/writes UTF-8. Escape `&`, `<`, `>` in any text or formula you build
  by hand (`set_cell`/`escape` do this for you).
- **The `s=` style id is an index into `cellXfs`** in `styles.xml`, not a colour.
  Two cells with the same fill can have different style ids (different borders,
  number formats); `xlsx fills` groups style ids by fill so you catch them all.
- **Number formatting is a style, not the value.** Write `0.4`, not `40%` or
  `"5.333.333"`; the displayed format comes from the cell's style.
- **Don't trust an edit you didn't verify.** Always `validate` and `unzip -t`, and
  re-`scan` to confirm the change landed in the right cell.

## Example: fill several cells from a build script and force recalc

```python
from pathlib import Path
import xlsx_surgeon as xs

work = Path("work")
sheet = xs.sheet_path(workdir=work, sheet="2. Finansiering")  # name, index or file
raw = xs.read(path=sheet)

# Budget paid by the funder (excl. co-financing); dependent cells recompute on open.
raw = xs.set_cell(raw=raw, ref="B13", value="8000000")                 # number
raw = xs.set_cell(raw=raw, ref="B25", value="AI Lab", kind="string")   # inline text
xs.write(path=sheet, text=raw)

xs.enable_full_calc(workdir=work)   # <-- formulas reading B13 refresh on open
# then:  xlsx validate work/  &&  xlsx pack work/ book.xlsx
```
