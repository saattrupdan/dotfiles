# docx

Formatting-preserving, surgical editing of Microsoft Word `.docx` files. Edits the
raw OOXML of `word/document.xml` in place — replacing only the spans you target —
so styles, page breaks, headers/footers and Word's revision metadata stay intact.
Use it to fill in or revise documents (grant applications, forms, reports) instead
of regenerating them and losing the layout.

## Requirements

- Python 3.12+ (standard library only — no runtime third-party packages).
- Install the CLI: `pipx install -e <path-to-docx-skill>` (or run from source with
  `uv run docx ...`).

## Quickstart

```bash
which docx || pipx install -e ~/gitsky/dotfiles/agentic/skills/docx

docx unpack app.docx work/   # extract + one-time app.docx.backup
docx scan   work/            # map of every body block (style, comment ids, text)
# ...edit work/word/document.xml surgically (string replace or offset spans)...
docx validate work/          # XML well-formed + comment ranges balanced
docx pack   work/ app.docx   # re-zip in place
```

## Commands

| Command | Purpose |
|---|---|
| `unpack <docx> <dir>` | Unzip to `<dir>`; copy `<docx>.backup` once (never overwrites). |
| `scan <dir> [--json]` | List top-level body blocks with index, style, comment ids, byte offsets, text. |
| `ensure-comments <dir>` | Create `word/comments.xml` + relationship + content-type if the doc has none. |
| `validate <dir>` | Check both XML parts are well-formed and every comment range is balanced & defined. |
| `pack <dir> <docx>` | Re-zip (`[Content_Types].xml` first, `ZIP_DEFLATED`) and verify archive integrity. |

The `docx_surgeon` package is also importable for per-document build scripts:
`sample_rpr`, `iter_blocks`, `para`, `comment_block`, `apply_edits`,
`replace_once`, `ensure_comments_part`, `append_comments`, `validate`, `pack`.

Tests: `uv run pytest`. Lint/format/types: `uv run ruff check`,
`uv run ruff format`, `uv run ty check`.

See `SKILL.md` for the full workflow, comment rules, and gotchas.
