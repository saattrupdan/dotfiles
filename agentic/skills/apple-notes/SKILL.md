---
name: apple-notes
description: Read, write, and semantically search the user's Apple Notes on macOS via the `notes` CLI (AppleScript only, no Full Disk Access). Use to list/get/create/update/append/move/delete notes, enumerate folders, keyword-search the whole library, or find notes by meaning rather than by keyword.
last-updated: 2026-09-04
---

# apple-notes

One `notes` CLI over the user's Apple Notes. Everything goes through
AppleScript (`/usr/bin/osascript` → Notes.app), so it needs no Full Disk Access
and never touches `~/Library/Group Containers/group.com.apple.notes/NoteStore.sqlite`.
Keyword and semantic search are served from a local SQLite index that this CLI
owns, because Notes.app exposes no search API at all.

This is a deliberately small replacement for the third-party Notes MCP servers:
no dependencies, no daemon, one binary you can read.

## CLI

```bash
notes <command> [options]
```

### Prerequisites

```bash
which notes || (cd <path-to-this-skill> && uv tool install -e .)   # or: uv run --python 3.12 notes …
```

Standard library only, and **Python 3.12+** — the system `/usr/bin/python3` is
3.9 and cannot run this package. Every command takes `--json` for structured
output. Semantic search needs an OpenAI-compatible embedding endpoint (see
[Embeddings](#embeddings)); everything else works without one.

macOS only. Notes.app must be installed; the first call may trigger the
Automation permission prompt.

## Commands

| Command | What it does |
| --- | --- |
| `notes list [-f FOLDER] [-n N] [--modified-since DATE]` | id, title, folder, modification date (newest first) |
| `notes get ID [--html]` | one note: metadata + plaintext (or the raw HTML `body`) |
| `notes create --title T (--body TEXT \| --body-file P \| --stdin) [-f FOLDER]` | new note |
| `notes update ID (--body … \| --body-file … \| --stdin) [--rename NEW]` | **full body replace** (destroys formatting) |
| `notes append ID (--body … \| …) [--before]` | splice text in, keeping the rest |
| `notes delete ID --yes` | move to Recently Deleted |
| `notes mv ID -f FOLDER` | move to another folder |
| `notes folders` | accounts and folders with full nested paths |
| `notes search KEYWORDS… [--match any\|all]` | whole-library keyword search (local index — the fast path) |
| `notes find "query" [-n 10] [-f FOLDER] [--min-score S] [--no-sync]` | semantic search: embed, cosine-rank, snippet |
| `notes index [--full] [--batch N] [--max-chars N]` | build or refresh the index |
| `notes doctor` | accounts, index freshness, embedding endpoint, hints |

### Resolve notes by id, not by title

`list` and `search` print an id like
`x-coredata://6E9256B3-…/ICNote/p841`. **Use it.** Every command also accepts
`--title`, but titles are *not unique* in Notes, and AppleScript's own
`first note whose name is X` silently resolves a duplicated title to whichever
copy the store hits first. This CLI looks up **all** matches
(`every note whose name is X`) and refuses to guess:

```console
$ notes get --title "Meeting"
error: 3 notes are titled 'Meeting'; titles are not unique. Pick an id:
  x-coredata://…/ICNote/p412  [iCloud/Notes]
  x-coredata://…/ICNote/p871  [iCloud/Research/TrustLLM]
  …
```

A title that matches exactly one note resolves fine, and a title that matches
nothing is an error, never an empty result. `--rename NEW` (on `update`) sets a
new title; `--title` only ever *resolves*.

### Reading

```bash
notes list -n 10                              # the 10 newest notes
notes list -f Research/TrustLLM -n 0          # every note in one folder (path or leaf name)
notes list --modified-since 2026-08-01        # since a date
notes get x-coredata://…/ICNote/p841          # plaintext body + metadata
notes get x-coredata://…/ICNote/p841 --html   # the raw HTML body (see Limits: never round-trip it)
notes folders                                 # where the notes live
```

`list` hits the live app: one `osascript` call enumerates the whole library
(439 notes in ~1.7 s on the reference Mac). Recently Deleted is skipped unless
you ask for it with `--include-deleted`.

### Writing

```bash
notes create --title "Standup 2026-09-04" --body "Shipped the indexer
Blocked on the reviewer queue" -f Notes
notes create --title "Imported" --body-file ./notes.txt --json
cat draft.txt | notes create --title "Draft" --stdin

notes update  x-coredata://…/ICNote/p841 --body "New whole body"   # replaces everything
notes update  x-coredata://…/ICNote/p841 --rename "Renamed"        # rename only
notes append  x-coredata://…/ICNote/p841 --body "Follow-up: merged"
notes append  x-coredata://…/ICNote/p841 --body "TL;DR at top" --before
notes mv      x-coredata://…/ICNote/p841 -f Research/TrustLLM
notes delete  x-coredata://…/ICNote/p841 --yes
```

`append`/`prepend` splice HTML into the existing body, so bold text, headings
and lists survive; `update` replaces the body with plain text and flattens all
of it. Both refuse to run on a note that has attachments unless you pass
`--force`, because rewriting the HTML can drop them — and if any do vanish, the
CLI compares the attachment count before and after and warns on stderr.

`delete` without `--yes` prints what it *would* delete and does nothing. With
`--yes` it moves the note to **Recently Deleted** — the note is not erased, and
Notes keeps it for ~30 days. `delete` on a note that is already in Recently
Deleted erases it for good.

Dates are local-time ISO-8601 (`2026-09-04T16:16:36`), assembled from Notes'
date components rather than from `date string`, which would be locale-dependent.

### Searching

```bash
notes search euroeval budget                    # any keyword (FTS5, ranked)
notes search euroeval budget --match all -n 5   # both keywords
notes find "how much did the Geomatic demo cost" -n 5
notes find "flight bookings" --folder Travels -n 3 --json
```

`search` is lexical and served entirely from the local index — it never asks
Notes.app per note. `find` embeds your query and ranks notes by cosine
similarity, printing rank, score, modified, folder, id and a snippet.

**`find` refreshes the index first** (unless `--no-sync`): an incremental
refresh over 439 notes costs ~1.5 s, of which ~1.5 s is the single metadata
`osascript` call and re-embedding is free unless something changed. A cold
`notes index --full` over 439 notes took 12 s (2 s reading, 10 s embedding).
If the index is empty, `search` builds it too. Use `--no-sync` when you want
the answer from what is already indexed and nothing else.

### Index and configuration

```bash
notes index            # incremental: only new/changed notes are read and embedded
notes index --full     # drop the index and re-read everything
notes doctor           # what is reachable, how stale the index is, and what to do
```

The index lives at `~/Library/Application Support/apple-notes/index.sqlite`
and is a pure cache — `rm` it and nothing is lost but the embedding round.

| Environment variable | Default | Meaning |
| --- | --- | --- |
| `NOTES_EMBED_BASE_URL` | `http://127.0.0.1:8080/v1` | OpenAI-compatible endpoint serving `/embeddings` |
| `NOTES_EMBED_MODEL` | `jina-code-embeddings-0.5b` | model alias to send |
| `NOTES_DB` | `~/Library/Application Support/apple-notes/index.sqlite` | index location |
| `NOTES_EXCLUDE_FOLDERS` | `Recently Deleted` (+ localised names) | colon-separated folder paths to skip |

Use `127.0.0.1`, **not** `host.docker.internal` — that name does not resolve on
the host itself. A local server that serves the default config:

```bash
llama-server -m <model.gguf> --embeddings --pooling last --alias jina-code-embeddings-0.5b --port 8080
```

`notes doctor` reports the served aliases and the vector width, and compares
them with what the index recorded. If the alias or the dimensionality changed,
`find` refuses to rank — mixing vectors from two models in one ranking is worse
than no ranking — and tells you to run `notes index --full`.

## Common tasks

**"What did I write about X?"** — `notes find "<X in your words>" -n 8`; use
`search` instead if you remember the exact word or need an exact phrase.

**"Summarise my notes from last week"** — `notes list --modified-since
$(date -v-7h +%F) --json`, then `notes get` each id.

**"Add this to my note about Y"** — `notes append <id> --body "…"` after finding
the id with `notes find Y` or `notes search Y`. Never `update` unless the user
asked for the whole body to be replaced.

**"Make a todo list in Notes"** — write plain lines: `notes create --title
"Errands" --body "- [ ] buy milk\n- [ ] post a letter"`. Those lines are
searchable and parseable, because Notes cannot create real checklists here
(Limits).

**"Is my search index working?"** — `notes doctor`. Every failure it prints
comes with a hint.

## How it works

**AppleScript, one process per logical operation.** Each `osascript` launch is
a fresh IPC session at roughly 200 ms, so nothing in this package loops over
notes across processes. Metadata for the whole library arrives in a single
call: accounts → folders → notes, with each folder's notes fetched as *lists*
(`get name of notes of folder …`, one Apple event each) rather than per note.
Bodies for a changed handful arrive by id inside one process.

**Folder paths come from the folder walk, not from the note.** `folders of
<account>` returns every folder in the account *flattened, nested ones
included*, while `folders of <folder>` returns genuine children — walking both
would visit every note twice. The flat list is enumerated exactly once (the
sum over folders equals `count notes`) and each folder's real path is rebuilt
by walking its `container` ids.

**Serialization.** Fields are separated by `character id 31` and records by
`character id 30`, joined with `text item delimiters`. Bodies contain newlines
and tabs, so those cannot be separators, and `set out to out & x` in a loop is
quadratic. Arguments travel in `argv` (never interpolated into the script), and
bodies too large for `argv` go through a temp file read as `«class utf8»`, so
nothing an agent writes can break out of a string.

**The index.** One SQLite table keyed by note id — title, folder path, account,
modification date, plaintext, body hash, float32 embedding blob, model alias,
dims, `indexed_at` — plus an FTS5 table over title and body for keywords (with
an automatic `LIKE` fallback when the interpreter has no FTS5). Incremental
sync diffs on `(id, modification date)` and fetches and re-embeds bodies only
for notes that are new or changed; notes that vanished from the library are
pruned. `plaintext` is what gets indexed and searched; `body` (HTML) is only
read for `--html`. Cosine ranking is pure Python — 439 × 896 dims is ~400k
multiplications, tens of milliseconds, so numpy would buy nothing.

## Limits

- **The configured embedder is a *code* model applied to prose.** On News
  Fetcher's prose corpus the same model produced nearest-neighbour cosines of
  min 0.371 / median 0.532 / max 0.735; on this Mac's 439 notes `notes doctor`
  measures 0.566 / 0.684 / 0.766 (best non-self match over 3 probes).
  Everything is compressed into a narrow band and 0.75+ is effectively
  unreachable. So **`find` applies no absolute threshold by default** — scores
  are printed for ranking, and `--min-score` has no default value on purpose.
  Scores are only comparable within this model and this index; comparing a 0.61
  to a 0.58 is meaningful, comparing 0.61 to "0.6 is a good match" is not.
  Swapping in a text embedding model is the real fix, which is exactly why the
  alias, dims and base URL are configurable and recorded in the index.
- **Checklists cannot be created programmatically.** Notes stores a checklist
  as a protobuf paragraph style, and AppleScript's `body` strips
  `<input type="checkbox">` — measured: a body written as
  `<div><input type="checkbox"> buy milk</div>` comes back as `<div>buy
  milk</div>`. A bulleted list (`<ul><li>`) is the closest thing that survives,
  and a literal `- [ ] item` line is searchable and parseable if you need
  todos.
- **A full-body `update` is destructive.** It replaces the note's HTML with
  plain text, so headings, bold and lists are flattened, and on a note with
  attachments it can drop them (the CLI refuses without `--force` and warns if
  the count changed). `get --html` returns inline media as a base64 `data:`
  blob (measured: one note's body carried 5 images and several hundred KB), so
  **never round-trip an HTML body you fetched with `--html`** — fetch, edit,
  write back is not a safe operation.
- **Notes serialises HTML entities without the trailing semicolon.** A body
  containing `&` reads back as `&amp`; this is stable under round trips but is
  not valid HTML, so do not parse `--html` output with an HTML parser.
- **Repeated HTML writes accumulate `<div><br></div>`** artifacts that later
  updates cannot remove; only editing in Notes clears them. `update` warns when
  a body already has several.
- **Notes.app must not be showing a modal** (a sharing or sign-in sheet blocks
  every Apple event, and the call times out instead of returning empty).
- **There is no full-text index inside Notes.app**, hence this local index. A
  fresh machine needs one `notes index` run (~12 s per 400 notes with a local
  embedder) before `search`/`find` are useful.
- **Notes' system folder names are localised**, so "Recently Deleted" may be
  "Senest slettet" elsewhere; several spellings are excluded by default and
  `NOTES_EXCLUDE_FOLDERS` overrides the list.
- **Bulk property reads can fail on huge folders**: `get body of notes of
  folder X` on a 169-note folder errors with -1741, which is why bodies are
  never fetched in bulk per folder unless the whole library is being read at
  once (that path is fine, measured).
- **No tags, no attachments API, no shared-note management, no Reminders.**
  Attachments are only detected (via the `attachments` count and U+FFFC in
  plaintext) so that they can be protected, not read or written.
