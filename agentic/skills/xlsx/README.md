# xlsx

Formatting-preserving, surgical editing of Microsoft Excel `.xlsx` files. Edits the
raw OOXML of `xl/worksheets/sheetN.xml` in place — replacing or inserting only the
cells you target — so styles, charts, data validations, conditional formatting,
named ranges and the workbook's calc settings stay intact. Use it to fill in or
revise spreadsheets (bid sheets, budgets, forms) instead of regenerating them with
openpyxl and losing everything it does not round-trip.

## Requirements

- Python 3.12+ (standard library only — no runtime third-party packages).
- Install the CLI: `pipx install -e <path-to-xlsx-skill>` (or run from source with
  `uv run xlsx ...`).

## Quickstart

```bash
which xlsx || pipx install -e ~/gitsky/dotfiles/agentic/skills/xlsx

xlsx unpack book.xlsx work/        # extract + one-time book.xlsx.backup
xlsx sheets work/                  # tab order -> name, sheetId, part path
xlsx scan   work/ "Sheet1"         # cells: ref, style id, formula flag, value
xlsx set    work/ "Sheet1" B13 8000000 --recalc   # set a value, force recalc
xlsx validate work/                # every XML part well-formed
xlsx pack   work/ book.xlsx        # re-zip in place
```

## Commands

| Command | Purpose |
|---|---|
| `unpack <xlsx> <dir>` | Unzip to `<dir>`; copy `<xlsx>.backup` once (never overwrites). |
| `sheets <dir>` | List worksheets in tab order with sheetId and part path. |
| `scan <dir> <sheet> [--style N,M] [--all] [--json]` | Dump cells: address, style id, formula flag, resolved value. |
| `fills <dir>` | Resolve the fill palette to RGB and show which style ids use each fill. |
| `set <dir> <sheet> <ref> <value> [--type ...] [--style N] [--recalc]` | Set or insert one cell. |
| `recalc <dir>` | Set `fullCalcOnLoad` so Excel recomputes formulas on open. |
| `validate <dir>` | Check every `.xml`/`.rels` part is well-formed. |
| `pack <dir> <xlsx>` | Re-zip (`[Content_Types].xml` first, `ZIP_DEFLATED`) and verify integrity. |

`<sheet>` accepts a display name, a 1-based tab index, or a part filename
(`sheet2.xml`). `set --type` is one of `auto` (number if it parses, else inline
string), `number`, `string`, `formula`, `shared`, `bool`.

The `xlsx_surgeon` package is also importable for per-workbook build scripts:
`list_sheets`, `sheet_path`, `shared_strings`, `iter_cells`, `fill_palette`,
`set_cell`, `enable_full_calc`, `validate`, `pack`.

Tests: `uv run pytest`. Lint/format/types: `uv run ruff check`,
`uv run ruff format`, `uv run ty check`.

See `SKILL.md` for the full workflow, the blue-fields recipe, and gotchas.
