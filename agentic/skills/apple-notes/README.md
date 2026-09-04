# apple-notes

A `notes` CLI for Apple Notes on macOS: create, read, update, append, move and
delete notes, enumerate folders, and search the whole library — by keyword or
by meaning. Everything talks to Notes.app through `osascript`, so it needs no
Full Disk Access and never reads `NoteStore.sqlite`.

Standard library only, no daemon, no third-party MCP server.

## Requirements

- macOS with Notes.app, and Python **3.12+** — the system `/usr/bin/python3` is
  3.9 and cannot run this package.

  ```bash
  uv tool install -e .            # installs the `notes` command
  # or, without installing, from this directory:
  uv run --python 3.12 notes list
  ```

- For semantic `find` only: an OpenAI-compatible embedding endpoint, by default
  `http://127.0.0.1:8080/v1` serving `jina-code-embeddings-0.5b` (896 dims).
  Any local `llama-server -m <model> --embeddings --pooling last --port 8080`
  works; nothing else needs the network.

## Quick start

```bash
notes doctor                              # accounts, index state, endpoint
notes list -n 10                          # the 10 newest notes, with ids
notes get x-coredata://…/ICNote/p841      # one note as text
notes search euroeval budget              # keywords, whole library (local index)
notes find "how much did the demo cost"   # meaning, not keywords
notes create --title "Standup" --body "Shipped the indexer" -f Notes
notes append x-coredata://…/ICNote/p841 --body "Follow-up: merged"
```

Add `--json` to any command for structured output.

## Commands

| Command | Purpose |
| --- | --- |
| `list [-f FOLDER] [-n N] [--modified-since DATE]` | id, title, folder, modified |
| `get ID [--html]` | one note, plaintext or raw HTML |
| `create --title T (--body\|--body-file\|--stdin) [-f FOLDER]` | new note |
| `update ID (--body\|--body-file\|--stdin) [--rename NEW]` | full body replace (flattens formatting) |
| `append ID (--body\|…) [--before]` | splice in, keep what is there |
| `delete ID --yes` | move to Recently Deleted |
| `mv ID -f FOLDER` | move note |
| `folders` | accounts and folders, nested paths |
| `search KEYWORDS… [--match any\|all]` | keyword search from the local index |
| `find "query" [-n N] [-f FOLDER] [--min-score S] [--no-sync]` | semantic search, cosine-ranked |
| `index [--full] [--batch N] [--max-chars N]` | build/refresh the index |
| `doctor` | reachability, index freshness, endpoint, hints |

## Configuration

| Variable | Default |
| --- | --- |
| `NOTES_EMBED_BASE_URL` | `http://127.0.0.1:8080/v1` |
| `NOTES_EMBED_MODEL` | `jina-code-embeddings-0.5b` |
| `NOTES_DB` | `~/Library/Application Support/apple-notes/index.sqlite` |
| `NOTES_EXCLUDE_FOLDERS` | Recently Deleted (and its localised names) |

## Notes

- **Prefer note ids over titles.** Titles are not unique; AppleScript's own
  by-title lookup silently picks one duplicate. This CLI detects ambiguity and
  refuses instead of guessing.
- `find` refreshes the index first (~1.5 s incremental over 439 notes);
  `--no-sync` skips that. A cold `index --full` took 12 s.
- The index is a cache. Deleting it costs one re-index, nothing else.
- `update` replaces a note's whole body and flattens rich formatting; `append`
  does not. Both refuse to run on a note with attachments without `--force`.
- The configured embedder is a *code* model used on prose, so scores sit in a
  narrow band (measured 0.37–0.74 elsewhere, 0.57–0.77 here) and 0.75+ is
  effectively unreachable — `find` therefore has no default `--min-score`.
  See `SKILL.md` for the full limits.

## Development

```bash
uv run --python 3.12 pytest -q          # ~90 s: runs against live Notes (safety rules in tests/test_cli.py)
uv run ruff format .
uv run ruff check .
```

The test suite deliberately has no `tests/test.ts` LLM-prompt harness — see the
comment at the top of `tests/test_cli.py` for why.
