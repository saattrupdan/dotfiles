---
name: apple-notes
description: Read, write, and semantically search the user's Apple Notes on macOS via the `notes` CLI (AppleScript only, no Full Disk Access). Use to list/get/create/update/append/move/delete notes, enumerate folders, keyword-search the whole library, or find notes by meaning rather than by keyword.
last-updated: 2026-09-05
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
`x-coredata://6E9256B3-…/ICNote/p841`. **Use it.** Every command that names a
note (`get`, `update`, `append`, `delete`, `mv`) also accepts `--title`, but
titles are *not unique* in Notes, and AppleScript's own
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
new title; `--title` only ever *resolves* — and passing **both** an id and
`--title` is only allowed when they name the same note, so a stale `--title`
can never be silently ignored.

By-name lookup is scoped like `list`: copies sitting in **Recently Deleted**
are skipped, so a note you just deleted does not resolve by title (pass
`--include-deleted` to name one anyway).

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

**Every write is attempted exactly once.** A mutation keeps firing Apple events
*after* the change (`id of n`, `name of n`, the folder walk), so a timeout after
a write is indistinguishable from "the write never happened" — retrying would
run the mutation again, and a second `delete` on a note already in Recently
Deleted erases it. So writes are never retried: if one fails, check the note's
state before re-running it. Reads do retry, because they are safe to repeat.

**`update`/`append` save what they replace first.** Before any write that
changes the body, the note's previous plaintext is dropped in
`~/Library/Application Support/apple-notes/undo/` as `<stamp>-<id>.txt` (the
newest ~50 are kept; override the directory with `NOTES_UNDO_DIR`) and the path
is printed as the `undo:` line and under `undo.path` in `--json`. Put it back
with `notes update <id> --body-file <that file>` — the file is the old body
verbatim, with no header. It is a file and deliberately *not* a table in the
index: that database is documented as a cache where deleting it loses nothing,
and undo history must survive an `rm` of a cache. To look around, plain `ls -t`
of that directory is the interface. A rename-only `update` writes no file (the
body was not touched, and the old title is in the output as `title_before`), and
`delete` needs none — Recently Deleted *is* the recovery path.

**An empty body is treated as no body.** `notes update <id> --stdin < /dev/null`
and an empty `--body-file` are refused as "nothing to do" rather than writing an
empty note; pass `--force` when emptying a note is the actual goal. `--rename ""`
is refused for the same reason (it would strip the title).

`--body` text is **escaped and rendered literally** (`_to_html`: escape `& < >`,
newlines to `<br>`, wrapped in one `<div>`), so there is no way to write rich
text — bold, headings or real lists — through this CLI. Use `append` to preserve
formatting that is already there, and accept that anything you add is plain text.

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
similarity, printing rank, score, modified, folder, id and a snippet. With
`--json` both return `{keywords|query, results, index, sync, stale}`; the hits
are under `results`.

**Bare keywords are prefix-matched.** FTS5 matches whole tokens, so an unstemmed
query used to be a silent lie: `notes search euroev` returned a clean-looking
`# 0 match(es)` while `euroeval` sat in 78 notes. A keyword is now handed to
FTS5 as `"<keyword>"*`, which finds every word that *starts* with it and costs
nothing on a whole word. (The star has to sit outside the quotes — `"euroev"*`
is 78 hits, `"euroev*"` is 0.) A keyword that already carries FTS5 syntax
(a quote, parentheses, `:`, `^`, or a bare `AND`/`OR`/`NEAR`) is passed through
untouched, so `notes search '"euroev"*'` still means what you typed. When a
query matches nothing, `search` says so on stderr with the `notes find` fallback
next to it — a zero is never just a zero.

**Both `search` and `find` refresh the index first** (unless `--no-sync`): an
incremental refresh over 439 notes costs ~2 s (measured 1.9–2.2 s), of which
essentially all of it is the single metadata `osascript` call, and re-embedding
is free unless something changed. A cold `notes index --full` over 439 notes
took 12 s (2 s reading, 10 s embedding). Refreshing before querying matters:
answering "0 matches" from an index that predates the note you were asked about
is indistinguishable from a genuine miss. Use `--no-sync` when you want the
answer from what is already indexed and nothing else.

The refresh is not allowed to *own* the query, though: the automatic sync gets a
20 s budget for the metadata read and 10 s per embedding batch, and gives up on
the first embedding failure. If Notes.app does not answer, or the embedder is
down, you get a loud `warning: results may be stale, …` on stderr and the answer
from whatever is already indexed — `search` still answers in milliseconds rather
than waiting minutes on a server that is not there. The refresh counts are in
the header (`added`/`updated` when nonzero, `removed` whenever anything moved)
because pruning trusts absence from the listing: if a folder answers with zero
notes, its rows leave the index, and that must be visible.

### Index and configuration

```bash
notes index            # incremental: only new/changed notes are read and embedded
notes index --full     # drop the index and re-read everything
notes doctor           # what is reachable, how stale the index is, and what to do
```

The index lives at `~/Library/Application Support/apple-notes/index.sqlite`
and is a pure cache — `rm` it and nothing is lost but the embedding round. That
is also why the undo files from `update`/`append` are plain files next to it and
not rows inside it.

| Environment variable | Default | Meaning |
| --- | --- | --- |
| `NOTES_EMBED_BASE_URL` | `http://127.0.0.1:8080/v1` | OpenAI-compatible endpoint serving `/embeddings` |
| `NOTES_EMBED_MODEL` | `jina-code-embeddings-0.5b` | model alias to send |
| `NOTES_DB` | `~/Library/Application Support/apple-notes/index.sqlite` | index location |
| `NOTES_UNDO_DIR` | `~/Library/Application Support/apple-notes/undo` | where `update`/`append` keep previous bodies |
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

**Only the first `--max-chars` characters (6000 by default) are embedded**, while
the whole body stays in the index for `search`. With a `--pooling last` embedder
the representation is dominated by the end of the window it was given, so text
past 6000 characters is simply invisible to `find` — one note in the 439-note
reference library (7638 characters) is already over the line. `search` still
finds it; raise `--max-chars` if `find` must. A note whose plaintext is **empty**
is left out of the embedding request entirely — the endpoint answers 400 for an
empty input, which would fail every other note in its batch — so such a note
never shows up in `find`, while `search` still matches its title. (Whitespace
alone is tokenised normally and keeps its vector.)

## Common tasks

**"What did I write about X?"** — `notes find "<X in your words>" -n 8`; use
`search` instead if you remember the exact word or need an exact phrase.

**"Summarise my notes from last week"** — `notes list --modified-since
$(date -v-7d +%F) --json`, then `notes get` each id.

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
  measures 0.566 / 0.684 / 0.766 (best non-self match over 3 probes). The whole
  library lands in a band a few tenths wide, and its *ceiling* is that max: on
  this library the single best match there is scores 0.766, so a threshold of
  0.75 admits roughly one note and 0.8 admits none. So **`find` applies no
  absolute threshold by default** — scores are printed for ranking, and
  `--min-score` has no default value on purpose. Scores are only comparable
  within this model and this index; comparing a 0.61 to a 0.58 is meaningful,
  comparing 0.61 to "0.6 is a good match" is not. Swapping in a text embedding
  model is the real fix, which is exactly why the alias, dims and base URL are
  configurable and recorded in the index.
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
  Attachments are only counted (the `attachments` property, fetched by
  `get`/`update` before and after a rewrite) so that they can be protected, not
  read or written.

### Known gaps

Raised in review, reproduced, and **not** fixed — do not assume these are
handled:

- **No probe-vector hash guard** (`index.py`, `vector_mismatch`). The guard
  compares the *alias* and the dimensionality only. Serve a different GGUF, or
  the same GGUF with `--pooling mean` instead of `--pooling last`, under the
  same alias and width, and `find` silently mixes two vector spaces and ranks
  garbage. A hash of a fixed probe string's vector would catch it; it does not
  exist yet.
- **`stats()["with_body"]` over-reports.** `digest("")` is the SHA-256 of the
  empty string, not the empty string, so `body_hash <> ''` is true for a note
  whose body never arrived. A test that asserted on it was vacuous for the same
  reason. Nothing depends on it for correctness, but do not read it as "bodies
  are present".
- **`has_fts5()` runs CREATE/DROP inside `stats()`.** It probes by creating and
  dropping a throwaway table on every call, so a transient failure there can
  leave `notes_fts` un-refreshed while `notes` is fine — a stale lexical answer
  with a healthy-looking index.
- **`unpack()` does not validate its blob.** It hands any length to
  `array.frombytes`; a `dims * 4 == len(blob)` assert would turn a truncated
  blob into an error instead of a silently short vector (and `zip(...,
  strict=False)` in `cosine` would then score it against a longer query as if
  nothing happened).
