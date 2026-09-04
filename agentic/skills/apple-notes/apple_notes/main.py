#!/usr/bin/env python3
"""``notes`` — CRUD and semantic search over Apple Notes, through AppleScript only.

Subcommands:

- ``notes list`` / ``get`` / ``folders``        read
- ``notes create`` / ``update`` / ``append`` / ``delete`` / ``mv``   write
- ``notes index`` / ``search`` / ``find``       the local search index
- ``notes doctor``                              what is broken right now

Notes.app exposes no search API, so lexical and semantic search are served from
a local SQLite index; everything else talks to the live app. Standard library
only, no Full Disk Access, no ``NoteStore.sqlite``. See ./SKILL.md.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import sys
import typing as t
import urllib.error
from pathlib import Path

from . import applescript, index
from .applescript import AppleScriptError

ID_PREFIX = "x-coredata://"


class UsageError(RuntimeError):
    """A wrong-command error, reported without a traceback."""


# ---------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------


def _emit(
    payload: t.Any, args: argparse.Namespace, render: t.Callable[[t.Any], None]
) -> None:
    if getattr(args, "json", False):
        print(json.dumps(payload, indent=2, ensure_ascii=False))
    else:
        render(payload)


# ---------------------------------------------------------------------------
# Note resolution
# ---------------------------------------------------------------------------


def resolve_id(args: argparse.Namespace) -> str:
    """Pick exactly one note id from ``<id>`` and/or ``--title``.

    Ids are the reliable handle. Titles are not unique, and AppleScript's own
    ``first note whose name is X`` resolves a duplicated title to whichever
    copy the store happens to hit first -- so an ambiguous title is refused
    here rather than guessed at.
    """
    explicit = getattr(args, "id", None)
    title = getattr(args, "title", None)
    if explicit:
        if not explicit.startswith(ID_PREFIX):
            raise UsageError(
                f"{explicit!r} is not a note id (expected x-coredata://…/ICNote/pNNN); use --title for a title"
            )
        return explicit
    if title:
        matches = applescript.ids_by_title(title)
        if not matches:
            raise UsageError(
                f"no note titled {title!r}. Find the id with: notes search {title.split()[0] if title.split() else '…'}"
            )
        if len(matches) > 1:
            lines = "\n".join(
                f"  {m['id']}  [{m['account']}/{m['folder']}]" for m in matches[:10]
            )
            raise UsageError(
                f"{len(matches)} notes are titled {title!r}; titles are not unique. Pick an id:\n{lines}"
            )
        return matches[0]["id"]
    raise UsageError("give a note id (from `notes list`) or --title")


def _read_body(args: argparse.Namespace) -> str | None:
    """Collect body text from --body / --body-file / --stdin."""
    given = [bool(args.body), bool(args.body_file), bool(args.stdin)]
    if sum(given) > 1:
        raise UsageError("--body, --body-file and --stdin are mutually exclusive")
    if args.body:
        return args.body
    if args.body_file:
        return Path(args.body_file).expanduser().read_text(encoding="utf-8")
    if args.stdin:
        return sys.stdin.read()
    return None


def _guard_attachments(note_id: str, *, force: bool) -> dict[str, t.Any]:
    """Return the current note, refusing a rewrite of one that has attachments."""
    current = applescript.get_note(note_id)
    count = current.get("attachments", 0)
    if count and not force:
        raise UsageError(
            f"{current['title']!r} carries {count} attachment(s). Re-writing the body rewrites the "
            "note's HTML, which can drop them. Pass --force to do it anyway, or add a new note instead."
        )
    return current


_RICH_TAG_RE = re.compile(r"<(?!/?(?:div|br)\b)[a-zA-Z]")


def _warn_if_rich(note_id: str) -> None:
    """Warn that a full-body replace will flatten formatted text.

    Only called once attachments are ruled out, because fetching `body` from a
    note with media drags the base64 payload across the wire.
    """
    html = applescript.get_note(note_id, html=True).get("body", "")
    if _RICH_TAG_RE.search(html):
        print(
            "warning: this note contains rich formatting (headings, bold, lists); "
            "a full-body update replaces it with plain text",
            file=sys.stderr,
        )
    if html.count("<div><br></div>") >= 3:
        print(
            "warning: the body already holds several empty <div><br></div> blocks; "
            "repeated HTML writes accumulate them and nothing removes them except editing in Notes",
            file=sys.stderr,
        )


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------


def cmd_list(args: argparse.Namespace) -> None:
    rows = applescript.note_metadata()
    if not args.include_deleted:
        rows = [row for row in rows if not index.is_excluded(row["folder"])]
    if args.folder:
        rows = [row for row in rows if index.folder_matches(row["folder"], args.folder)]
    if args.modified_since:
        floor = f"{args.modified_since}T00:00:00"
        rows = [row for row in rows if row["modified"] >= floor]
    rows.sort(key=lambda row: row["modified"], reverse=True)
    total = len(rows)
    rows = rows[: args.limit] if args.limit else rows
    payload = [
        {
            "id": row["id"],
            "title": row["title"],
            "folder": row["folder"],
            "account": row["account"],
            "modified": row["modified"],
        }
        for row in rows
    ]

    def render(payload: list[dict[str, str]]) -> None:
        print(f"# {len(payload)} of {total} note(s)")
        for row in payload:
            print(f"{row['modified']}  {row['folder']}  {row['title']}  {row['id']}")

    _emit(payload, args, render)


def cmd_get(args: argparse.Namespace) -> None:
    note_id = resolve_id(args)
    note = applescript.get_note(note_id, html=args.html)

    def render(note: dict[str, t.Any]) -> None:
        print(f"title:     {note['title']}")
        print(f"folder:    {note['account']}/{note['folder']}")
        print(f"modified:  {note['modified']}")
        print(f"created:   {note['created']}")
        if note.get("attachments"):
            print(f"attach:    {note['attachments']} file(s)")
        if note.get("shared"):
            print("shared:    yes")
        print(f"id:        {note['id']}")
        print()
        print(note["body"] if args.html else note["plaintext"].rstrip("\n"))

    _emit(note, args, render)


def cmd_create(args: argparse.Namespace) -> None:
    body = _read_body(args)
    if body is None:
        raise UsageError("give a body with --body, --body-file, or --stdin")
    note = applescript.create_note(
        title=args.title, body=body, folder=args.folder, account=args.account
    )
    if note["title"] != args.title:
        print(
            f"warning: Notes reports the title as {note['title']!r}, not {args.title!r}",
            file=sys.stderr,
        )

    def render(note: dict[str, str]) -> None:
        print(f"created:   {note['title']}")
        print(f"folder:    {note['account']}/{note['folder']}")
        print(f"id:        {note['id']}")

    _emit(note, args, render)


def _write(args: argparse.Namespace, mode: str) -> None:
    note_id = resolve_id(args)
    body = _read_body(args)
    new_title = getattr(args, "rename", None)
    if body is None and not new_title:
        raise UsageError(
            "nothing to do: give --body, --body-file, --stdin, or --rename"
        )
    if body is not None:
        _guard_attachments(note_id, force=args.force)
        if mode == "replace" and not args.force:
            _warn_if_rich(note_id)
    result = applescript.update_note(
        note_id,
        body=body,
        title=new_title,
        mode=mode if body is not None else "none",
    )
    expected = new_title or result["title_before"]
    if result["title"] != expected:
        print(
            f"warning: Notes reports the title as {result['title']!r}, not {expected!r} -- writing a "
            "body makes Notes re-derive the title from its first line",
            file=sys.stderr,
        )
    lost = result["attachments_before"] - result["attachments_after"]
    if lost > 0:
        print(
            f"warning: {lost} attachment(s) disappeared from this note during the rewrite",
            file=sys.stderr,
        )

    def render(result: dict[str, str]) -> None:
        print(f"updated:   {result['title']}")
        print(f"folder:    {result['account']}/{result['folder']}")
        print(f"modified:  {result['modified']}")
        print(f"id:        {note_id}")

    _emit({"id": note_id, **result}, args, render)


def cmd_update(args: argparse.Namespace) -> None:
    """Replace a note's whole body (destructive to rich formatting)."""
    _write(args, "replace")


def cmd_append(args: argparse.Namespace) -> None:
    """Splice text into a note without touching what is already there."""
    _write(args, "prepend" if args.before else "append")


def cmd_delete(args: argparse.Namespace) -> None:
    note_id = resolve_id(args)
    if not args.yes:
        note = applescript.get_note(note_id)
        raise UsageError(
            f"refusing to delete {note['title']!r} ({note['account']}/{note['folder']}) without --yes. "
            "The note is moved to Recently Deleted, where it stays until Notes purges it."
        )
    result = applescript.delete_note(note_id)

    def render(result: dict[str, str]) -> None:
        print(f"deleted:   {result['title']}")
        print(f"from:      {result['account']}/{result['folder']}")
        print("note:      moved to Recently Deleted (not erased)")

    _emit({"id": note_id, **result}, args, render)


def cmd_mv(args: argparse.Namespace) -> None:
    note_id = resolve_id(args)
    result = applescript.move_note(note_id, args.folder, account=args.account)

    def render(result: dict[str, str]) -> None:
        print(f"moved:     {note_id}")
        print(f"to:        {result['account']}/{result['folder']}")

    _emit({"id": note_id, **result}, args, render)


def cmd_folders(args: argparse.Namespace) -> None:
    rows = applescript.folders()
    if not args.include_deleted:
        rows = [row for row in rows if not index.is_excluded(row["path"])]
    rows.sort(key=lambda row: (row["account"], row["path"]))

    def render(rows: list[dict[str, t.Any]]) -> None:
        print(f"# {len(rows)} folder(s)")
        for row in rows:
            print(f"{row['notes']:>5}  {row['account']}/{row['path']}")

    _emit(rows, args, render)


def cmd_index(args: argparse.Namespace) -> None:
    conn = index.connect()
    try:
        if args.full:
            mismatch = None
        else:
            mismatch = index.vector_mismatch(conn)
        if mismatch:
            raise UsageError(
                f"{mismatch['reason']}. Run `notes index --full` to rebuild against "
                f"model={index.model()} (stored: {mismatch.get('stored_model')} / "
                f"{mismatch.get('stored_dims')} dims, current: {mismatch.get('current_model')} / "
                f"{mismatch.get('current_dims')} dims)."
            )
        result = index.sync(
            conn,
            full=args.full,
            batch=args.batch,
            max_chars=args.max_chars,
            quiet=args.json,
        )
        result["index"] = index.stats(conn)
    finally:
        conn.close()

    def render(result: dict[str, t.Any]) -> None:
        idx = result["index"]
        print(
            f"# {'full rebuild' if result['full'] else 'incremental'} — {result['seen']} note(s) seen"
        )
        print(
            f"  added {result['added']}  updated {result['updated']}  removed {result['removed']}  "
            f"unchanged {result['unchanged']}"
        )
        print(
            f"  embedded {result['embedded']} in {result['seconds_embedding']:.1f}s "
            f"(metadata {result['seconds_metadata']:.1f}s, bodies {result['seconds_bodies']:.1f}s, "
            f"total {result['seconds_total']:.1f}s)"
        )
        print(
            f"  lexical: {idx['lexical']}  vectors: {idx['embedded']}/{idx['notes']}  model: {idx['model']} ({idx['dims']} dims)"
        )
        for err in result["embed_errors"]:
            print(f"  warning: {err}", file=sys.stderr)

    _emit(result, args, render)


def cmd_search(args: argparse.Namespace) -> None:
    conn = index.connect()
    try:
        # Refresh before querying, exactly like `find`: answering "0 matches"
        # from an index that predates the note the caller is asking about is
        # the worst possible failure for a tool driven by an agent, because an
        # empty result set looks like a real answer.
        sync_info: dict[str, t.Any] | None = None
        if not args.no_sync:
            sync_info = index.sync(conn, quiet=args.json)
        if index.stats(conn)["notes"] == 0:
            raise UsageError(
                "index is empty. Run: notes index"
                if args.no_sync
                else "Notes.app reports no notes to index"
            )
        hits = index.search_lexical(
            conn, args.keywords, match=args.match, limit=args.limit, folder=args.folder
        )
        info = index.stats(conn)
    finally:
        conn.close()

    def render(payload: dict[str, t.Any]) -> None:
        hits = payload["results"]
        timing = ""
        if sync_info is not None:
            timing = f", index synced in {sync_info['seconds_total']:.1f}s"
        print(
            f"# {len(hits)} match(es) for {args.match}({', '.join(args.keywords)}) over {info['notes']} indexed note(s) [{info['lexical']}]{timing}"
        )
        for hit in hits:
            print(f"{hit['modified']}  {hit['folder']}  {hit['id']}")
            print(f"        {hit['title']}")
            if hit.get("snippet"):
                print(f"        {hit['snippet']}")

    _emit(
        {
            "keywords": args.keywords,
            "match": args.match,
            "results": hits,
            "index": info,
            "sync": sync_info,
        },
        args,
        render,
    )


def cmd_find(args: argparse.Namespace) -> None:
    conn = index.connect()
    try:
        sync_info: dict[str, t.Any] | None = None
        if not args.no_sync:
            sync_info = index.sync(conn, quiet=args.json)
        mismatch = index.vector_mismatch(conn)
        if mismatch:
            raise UsageError(
                f"{mismatch['reason']}; refusing to mix vectors in one ranking. "
                f"Rebuild with: notes index --full (stored {mismatch.get('stored_model')} "
                f"{mismatch.get('stored_dims')} dims vs configured {mismatch.get('current_model')} "
                f"{mismatch.get('current_dims')} dims)"
            )
        hits = index.find_similar(
            conn,
            args.query,
            limit=args.limit,
            min_score=args.min_score,
            folder=args.folder,
        )
        info = index.stats(conn)
    finally:
        conn.close()

    def render(payload: dict[str, t.Any]) -> None:
        hits = payload["results"]
        timing = ""
        if payload["sync"] is not None:
            timing = f", index synced in {payload['sync']['seconds_total']:.1f}s"
        print(
            f"# {len(hits)} result(s) for {args.query!r} — {info['embedded']}/{info['notes']} notes vectorised "
            f"with {info['model']} ({info['dims']} dims){timing}"
        )
        for rank, hit in enumerate(hits, start=1):
            print(
                f"{rank:>3}  {hit['score']:.4f}  {hit['modified']}  {hit['folder']}  {hit['id']}"
            )
            print(f"        {hit['title']}")
            if hit.get("snippet"):
                print(f"        {hit['snippet']}")

    _emit(
        {"query": args.query, "results": hits, "index": info, "sync": sync_info},
        args,
        render,
    )


def cmd_doctor(args: argparse.Namespace) -> None:
    report: dict[str, t.Any] = {"os": os.uname().sysname, "db": str(index.db_path())}
    hints: list[str] = []
    report["osascript"] = Path(applescript.OSASCRIPT).exists()
    if not report["osascript"]:
        hints.append("/usr/bin/osascript is missing; this CLI only works on macOS.")

    accounts: list[dict[str, t.Any]] = []
    try:
        accounts = applescript.accounts()
        report["notes"] = {"reachable": True, "accounts": accounts}
    except AppleScriptError as exc:
        report["notes"] = {"reachable": False, "error": str(exc)}
        hints.append(
            "Notes.app did not answer. Open Notes once and answer the "
            '"control Apple Events" prompt, then grant Automation permission in '
            "System Settings > Privacy & Security > Automation."
        )

    conn = None
    try:
        conn = index.connect()
        report["index"] = index.stats(conn)
        if accounts:
            report["index_diff"] = index.diff_vs_notes(conn)
    except sqlite3.Error as exc:  # pragma: no cover - corrupt or unwritable DB
        report["index"] = {"error": f"{type(exc).__name__}: {exc}"}
        hints.append(
            f"The index at {index.db_path()} is unusable. Delete it and run: notes index"
        )

    probe = index.embed_probe()
    report["embeddings"] = probe
    if not probe.get("ok"):
        hints.append(
            f"No embeddings from {index.base_url()}. Start the server, e.g. "
            "llama-server -m <model> --embeddings --pooling last --host 127.0.0.1 --port 8080 "
            "--alias <name>, or point NOTES_EMBED_BASE_URL at whatever serves /v1/embeddings "
            "(127.0.0.1, not host.docker.internal, which does not resolve on the host)."
        )
    if conn is not None and probe.get("ok") and report.get("index", {}).get("embedded"):
        mismatch = index.vector_mismatch(conn)
        if mismatch:
            report["embeddings"]["mismatch"] = mismatch
            hints.append(
                f"Stored vectors do not match the endpoint ({mismatch['reason']}). Rebuild: notes index --full"
            )

    if report.get("index_diff", {}).get("missing") or report.get("index_diff", {}).get(
        "stale"
    ):
        hints.append("The index is behind the library. Run: notes index")
    if conn is not None:
        if report.get("index", {}).get("lexical") == "like":
            hints.append(
                "This interpreter has no FTS5, so keyword search falls back to LIKE (slower, no relevance ranking)."
            )
        report["score_profile"] = index.score_profile(conn)
        if report.get("score_profile"):
            report["score_profile"]["note"] = (
                "best-match cosine when querying indexed notes against themselves; "
                "treat scores as comparable only within this model"
            )
        conn.close()

    report["hints"] = hints

    def render(report: dict[str, t.Any]) -> None:
        print(f"# notes doctor — {report['db']}")
        if report["notes"].get("reachable"):
            for acct in report["notes"]["accounts"]:
                print(
                    f"  account {acct['name']}: {acct['notes']} notes, {acct['folders']} folders"
                )
        else:
            print(f"  account ERROR: {report['notes']['error']}")
        idx = report.get("index", {})
        if "error" in idx:
            print(f"  index ERROR: {idx['error']}")
        else:
            print(
                f"  index: {idx['notes']} rows ({idx['embedded']} with vectors), "
                f"model {idx['model']} ({idx['dims']} dims), lexical {idx['lexical']}, "
                f"last built {idx['indexed_at'] or 'never'}"
            )
            diff = report.get("index_diff")
            if diff:
                print(
                    f"  vs Notes.app: {diff['notes']} live, {diff['indexed']} indexed, "
                    f"{diff['missing']} missing, {diff['stale']} stale, {diff['extra']} extra"
                )
        emb = report["embeddings"]
        if emb.get("ok"):
            print(
                f"  embeddings: {emb['base_url']} serving {emb['dims']} dims as {index.model()} — {', '.join(emb['served_models'])}"
            )
        else:
            print(f"  embeddings: {emb['base_url']} — {emb['error']}")
        if report.get("score_profile"):
            prof = report["score_profile"]
            print(
                f"  score band: min {prof['min']} / median {prof['median']} / max {prof['max']} over {prof['probes']} probes"
            )
        for hint in hints:
            print(f"  hint: {hint}")

    _emit(report, args, render)


# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------


def _body_opts(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--body", help="body text")
    parser.add_argument("--body-file", help="read the body from a file")
    parser.add_argument("--stdin", action="store_true", help="read the body from stdin")


def _note_target(
    parser: argparse.ArgumentParser, *, title_help: str | None = None
) -> None:
    """Both note handles: the id positional and the ``--title`` fallback.

    The positional is optional so that ``notes get --title X`` parses; which of
    the two is present is decided by :func:`resolve_id`, which also refuses an
    ambiguous title.
    """
    parser.add_argument(
        "id", nargs="?", metavar="ID", help="note id (x-coredata://…/ICNote/pNNN)"
    )
    parser.add_argument(
        "--title",
        help=title_help
        or "resolve by title instead — only safe when titles are unique",
    )


def _add_json(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--json", action="store_true", help="structured JSON output")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="notes",
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    sub = parser.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("list", help="list notes (id, title, folder, modified)")
    p.add_argument(
        "-f", "--folder", help="restrict to a folder (path, or its last component)"
    )
    p.add_argument(
        "-n",
        "--limit",
        type=int,
        default=25,
        help="newest N notes (default 25, 0 for all)",
    )
    p.add_argument(
        "--modified-since",
        metavar="YYYY-MM-DD",
        help="only notes modified on or after this date",
    )
    p.add_argument(
        "--include-deleted", action="store_true", help="include Recently Deleted"
    )
    _add_json(p)
    p.set_defaults(func=cmd_list)

    p = sub.add_parser("get", help="print one note")
    _note_target(p)
    p.add_argument(
        "--html",
        action="store_true",
        help="the raw HTML `body` property instead of plaintext",
    )
    _add_json(p)
    p.set_defaults(func=cmd_get)

    p = sub.add_parser("create", help="create a note")
    p.add_argument("--title", required=True)
    _body_opts(p)
    p.add_argument(
        "-f", "--folder", default="Notes", help="destination folder (default: Notes)"
    )
    p.add_argument("--account", help="account name (default: the first account)")
    _add_json(p)
    p.set_defaults(func=cmd_create)

    p = sub.add_parser("update", help="replace a note's whole body")
    _note_target(p)
    p.add_argument(
        "--rename",
        metavar="NEW",
        help="give the note a new title (--title only resolves it)",
    )
    _body_opts(p)
    p.add_argument(
        "--force", action="store_true", help="proceed even if the note has attachments"
    )
    _add_json(p)
    p.set_defaults(func=cmd_update)

    p = sub.add_parser("append", help="add to a note, keeping what is there")
    _note_target(p)
    _body_opts(p)
    p.add_argument(
        "--before", action="store_true", help="insert at the top instead of the end"
    )
    p.add_argument(
        "--force", action="store_true", help="proceed even if the note has attachments"
    )
    _add_json(p)
    p.set_defaults(func=cmd_append)

    p = sub.add_parser("delete", help="move a note to Recently Deleted")
    _note_target(p)
    p.add_argument(
        "--yes", action="store_true", help="required; without it nothing happens"
    )
    _add_json(p)
    p.set_defaults(func=cmd_delete)

    p = sub.add_parser("mv", help="move a note to another folder")
    _note_target(p)
    p.add_argument(
        "-f",
        "--folder",
        required=True,
        help="destination folder path, e.g. Research/TrustLLM",
    )
    p.add_argument("--account", help="account name (default: the first account)")
    _add_json(p)
    p.set_defaults(func=cmd_mv)

    p = sub.add_parser("folders", help="list accounts and folders with full paths")
    p.add_argument(
        "--include-deleted", action="store_true", help="include Recently Deleted"
    )
    _add_json(p)
    p.set_defaults(func=cmd_folders)

    p = sub.add_parser("search", help="whole-library keyword search (local index)")
    p.add_argument("keywords", nargs="+", metavar="KEYWORD")
    p.add_argument(
        "--match",
        choices=["any", "all"],
        default="any",
        help="any keyword or all of them (default any)",
    )
    p.add_argument("-n", "--limit", type=int, default=20)
    p.add_argument("-f", "--folder", help="restrict to a folder")
    p.add_argument(
        "--no-sync",
        action="store_true",
        help="skip the incremental index refresh (results may be stale)",
    )
    _add_json(p)
    p.set_defaults(func=cmd_search)

    p = sub.add_parser("find", help="semantic search: embed the query, rank by cosine")
    p.add_argument("query")
    p.add_argument("-n", "--limit", type=int, default=10)
    p.add_argument("-f", "--folder", help="restrict to a folder")
    p.add_argument(
        "--min-score",
        type=float,
        default=None,
        help="drop results below this cosine (no default — see SKILL.md)",
    )
    p.add_argument(
        "--no-sync", action="store_true", help="skip the incremental index refresh"
    )
    _add_json(p)
    p.set_defaults(func=cmd_find)

    p = sub.add_parser("index", help="build or refresh the local index")
    p.add_argument(
        "--full", action="store_true", help="drop the index and re-read every note"
    )
    p.add_argument(
        "--batch", type=int, default=32, help="notes per embedding request (default 32)"
    )
    p.add_argument(
        "--max-chars",
        type=int,
        default=index.DEFAULT_MAX_CHARS,
        help="characters handed to the embedder (default 6000)",
    )
    _add_json(p)
    p.set_defaults(func=cmd_index)

    p = sub.add_parser("doctor", help="report what is reachable and what is stale")
    _add_json(p)
    p.set_defaults(func=cmd_doctor)

    return parser


def main(argv: t.Sequence[str] | None = None) -> int:
    # Not dead code: `requires-python` stops *packaging* on 3.9, but the file can
    # still be run by the macOS system interpreter, where it would die on
    # something obscure like `zip(strict=True)` instead of saying this.
    if sys.version_info < (3, 12):  # noqa: UP036
        print(
            f"error: notes needs Python 3.12+, this is {sys.version.split()[0]} "
            f"({'Python ' + sys.version.split()[0]}, {sys.executable}). Run `uv run --python 3.12 notes …` "
            "or install it with `uv tool install -e .` -- the macOS system /usr/bin/python3 is 3.9 "
            "and cannot run this package.",
            file=sys.stderr,
        )
        return 2
    args = build_parser().parse_args(list(argv) if argv is not None else None)
    if sys.platform != "darwin":  # pragma: no cover - guard for non-mac hosts
        print(
            "error: notes requires macOS (it drives /usr/bin/osascript)",
            file=sys.stderr,
        )
        return 2
    try:
        args.func(args)
    except UsageError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    except LookupError:
        print(f"error: no note with id {getattr(args, 'id', '?')}", file=sys.stderr)
        print("hint: find the id with `notes list` or `notes search`", file=sys.stderr)
        return 1
    except AppleScriptError as exc:
        print(f"error: {exc}", file=sys.stderr)
        if exc.code == -1743:
            print(
                "hint: grant Automation permission to this process in System Settings > Privacy & Security > Automation",
                file=sys.stderr,
            )
        return 1
    except index.IndexError_ as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    except (
        urllib.error.URLError
    ) as exc:  # pragma: no cover - find() reports its own errors
        print(f"error: {index.http_error_text(exc)}", file=sys.stderr)
        return 1
    except BrokenPipeError:  # pragma: no cover - piping into head
        return 0
    return 0


if __name__ == "__main__":
    sys.exit(main())
