# media-dk

One `media` CLI for Danish broadcast media — **DR** (dr.dk) and **TV 2**
(tv2.dk). Merges the former `dr-dk` and `tv2-dk` skills.

DR is read via the `__NEXT_DATA__` JSON embedded in its news pages; TV 2 via the
internal `decks` API. All content is free and anonymous.

## Requirements

- `media` CLI — standard library only (`pipx install -e .`)
- Internet access to `www.dr.dk` and `decks.services.tv2.dk`

## Quick start

```bash
media news                              # latest from DR + TV 2
media news --source dr --section indland
media search regering                   # recent headlines containing "regering"
media search klima energi --match all   # both words
```

Add `--json` to any command for structured output.

## Commands

| Command | Purpose |
|---|---|
| `news [--source dr\|tv2\|all] [--section S]` | Latest news headlines |
| `search TERM… [--source …] [--match any\|all]` | Keyword search over recent content |

## Notes

- Neither broadcaster has a public search API (DR's `/soeg` is HTML-only and
  robots-blocked; TV 2 has none). `search` is a **keyword filter over the
  current/recent feeds**, not a full-archive search — the result header shows how
  many recent items were swept.
- DR's `dr.dk/` home page has no `__NEXT_DATA__`; `/nyheder` is the entry point.
- No DRTV / TV 2 Play video (geo-blocked, out of scope).
