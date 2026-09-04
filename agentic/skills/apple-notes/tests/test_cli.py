#!/usr/bin/env python3
"""Deterministic tests for the ``notes`` CLI.

DEVIATION FROM ``create-a-skill``
--------------------------------
This skill deliberately has **no** ``tests/test.ts`` prompt-iteration harness.
That harness runs 22 English/Danish prompts through ``pi -p`` and an LLM
evaluator, which is the right way to tune a *web-lookup* skill's trigger
phrases. A local Notes tool has real, irreversible side effects (it edits the
user's notes) and no interesting trigger ambiguity, so an LLM-in-the-loop
sweep would only add cost and risk. Instead these are ordinary deterministic
pytest cases over the real Notes.app library, plus offline unit checks.

    uv run --python 3.12 pytest -q          # or: uv run --python 3.12 python tests/test_cli.py

SAFETY — read before touching these tests
-----------------------------------------
These tests run against the developer's real Notes library. Therefore:

* every note they create, modify, move, or delete is titled
  ``pi-skill-test <session id> …`` and lives in a scratch folder named
  ``pi-skill-test-scratch-<session id>``;
* nothing is ever deleted without ``--yes``, no bulk delete is ever run, and
  the teardown deletes only the notes this session created;
* the count stays in single digits per run;
* the teardown deletes the notes this session created and then deletes them
  again from Recently Deleted to purge them, asserting that no
  ``pi-skill-test `` note survives anywhere (`delete` alone only moves a note
  to Recently Deleted, where Notes keeps it for about 30 days).

Embedding-dependent tests are skipped when the local embedder does not answer;
a dead endpoint has its own tests, which assert graceful failure.
"""

from __future__ import annotations

import contextlib
import json
import os
import sqlite3
import subprocess
import sys
import time
import typing as t
import urllib.error
import urllib.request
import uuid
from dataclasses import dataclass
from pathlib import Path

import pytest

SKILL_DIR = Path(__file__).resolve().parent.parent
if str(SKILL_DIR) not in sys.path:
    sys.path.insert(0, str(SKILL_DIR))

from apple_notes import applescript, index
from apple_notes import main as cli

SESSION = f"{time.strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:6]}"
PREFIX = f"pi-skill-test {SESSION} "
SCRATCH = f"pi-skill-test-scratch-{SESSION}"
DEAD_ENDPOINT = "http://127.0.0.1:1/v1"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


@dataclass
class Result:
    argv: tuple[str, ...]
    code: int
    out: str
    err: str

    @property
    def json(self) -> t.Any:
        return json.loads(self.out)

    def ok(self) -> Result:
        assert self.code == 0, (
            f"notes {' '.join(self.argv)} exited {self.code}\n{self.out}{self.err}"
        )
        return self


def run_cli(*argv: str) -> Result:
    """Invoke the CLI in-process, capturing both streams."""
    out: list[str] = []
    err: list[str] = []
    with contextlib.redirect_stdout(_Sink(out)), contextlib.redirect_stderr(_Sink(err)):
        code = cli.main(list(argv))
    return Result(argv, code, "".join(out), "".join(err))


class _Sink:
    def __init__(self, into: list[str]) -> None:
        self.into = into

    def write(self, text: str) -> int:
        self.into.append(text)
        return len(text)

    def flush(self) -> None:  # pragma: no cover - text is appended directly
        pass


def title(suffix: str) -> str:
    return f"{PREFIX}{suffix}"


def find_by_title(wanted: str) -> list[dict[str, str]]:
    return [row for row in applescript.note_metadata() if row["title"] == wanted]


def osascript(line: str) -> str:
    return subprocess.run(
        ["/usr/bin/osascript", "-e", line],
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    ).stdout.strip()


def endpoint_up(base_url: str | None = None) -> bool:
    url = f"{(base_url or index.base_url()).rstrip('/')}/models"
    try:
        with urllib.request.urlopen(url, timeout=3.0) as resp:
            return resp.status == 200
    except (urllib.error.URLError, OSError, ValueError):
        return False


HAS_ENDPOINT = endpoint_up()
needs_endpoint = pytest.mark.skipif(
    not HAS_ENDPOINT, reason=f"no embedder at {index.base_url()}"
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(scope="session")
def live_db(tmp_path_factory: pytest.TempPathFactory) -> Path:
    """Notes with a scratch folder, and a session-scoped temp index."""
    db = tmp_path_factory.mktemp("apple-notes") / "index.sqlite"
    os.environ["NOTES_DB"] = str(db)
    osascript(
        'tell application "Notes" to tell account "iCloud" to '
        f'make new folder with properties {{name:"{SCRATCH}"}}'
    )
    assert SCRATCH in {folder["path"] for folder in applescript.folders()}
    yield db
    # Teardown: delete every note this session created, then the scratch folder.
    for row in applescript.note_metadata():
        if row["title"].startswith(PREFIX):
            run_cli("delete", row["id"], "--yes")
    # `delete` only moves a note to Recently Deleted, where it stays queryable
    # for ~30 days. These notes were created minutes ago by this very session,
    # so a second delete purges them rather than leaving one row per test run
    # behind in the user's Recently Deleted.
    for row in applescript.note_metadata():
        if row["title"].startswith(PREFIX) and index.is_excluded(row["folder"]):
            run_cli("delete", row["id"], "--yes")
    leftover = [
        row for row in applescript.note_metadata() if row["title"].startswith(PREFIX)
    ]
    assert leftover == [], f"test notes survived teardown: {leftover}"
    osascript(
        f'tell application "Notes" to delete (first folder whose name is "{SCRATCH}")'
    )
    assert SCRATCH not in {folder["path"] for folder in applescript.folders()}
    os.environ.pop("NOTES_DB", None)


@pytest.fixture()
def scratch_note(live_db: Path) -> dict[str, str]:
    """A note in the scratch folder, created fresh for one test."""
    note = run_cli(
        "create",
        "--title",
        title("note"),
        "--body",
        "alpha beta gamma",
        "-f",
        SCRATCH,
        "--json",
    ).json
    assert note["title"] == title("note")
    return note


@pytest.fixture()
def isolated_db(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """An index of our own, so a unit test never reads the shared one."""
    db = tmp_path / "index.sqlite"
    monkeypatch.setenv("NOTES_DB", str(db))
    return db


def seed(conn: sqlite3.Connection, rows: list[tuple[str, list[float]]]) -> None:
    conn.executescript(index.SCHEMA)
    if index.has_fts5(conn):
        conn.executescript(index.FTS_SCHEMA)
    for note_id, vector in rows:
        conn.execute(
            "INSERT INTO notes(id, title, folder, account, modified, body, body_hash, embedding, model, dims, indexed_at)"
            " VALUES(?,?,?,?,?,?,?,?,?,?,?)",
            (
                note_id,
                f"note {note_id}",
                "Notes",
                "iCloud",
                "2026-01-01T00:00:00",
                f"body of {note_id}",
                "hash",
                index.pack(vector),
                index.model(),
                len(vector),
                "2026-01-01T00:00:00",
            ),
        )
        if index.has_fts5(conn):
            conn.execute(
                "INSERT INTO notes_fts(note_id, title, body) VALUES(?,?,?)",
                (note_id, note_id, f"body of {note_id}"),
            )
    conn.commit()


# ---------------------------------------------------------------------------
# Read paths
# ---------------------------------------------------------------------------


def test_list_shows_ids_folders_and_dates(live_db: Path) -> None:
    run_cli(
        "create", "--title", title("listed"), "--body", "one\ntwo\nthree", "-f", SCRATCH
    ).ok()
    rows = run_cli("list", "-f", SCRATCH, "-n", "0", "--json").ok().json
    mine = [row for row in rows if row["title"] == title("listed")]
    assert len(mine) == 1, mine
    row = mine[0]
    assert row["folder"] == SCRATCH
    assert row["id"].startswith("x-coredata://") and "/ICNote/p" in row["id"]
    assert row["account"] == "iCloud"
    assert row["modified"].startswith("20") and "T" in row["modified"]

    human = run_cli("list", "-f", SCRATCH, "-n", "5").ok().out
    assert "# " in human and row["id"] in human


def test_list_newest_first_and_modified_since(live_db: Path) -> None:
    rows = run_cli("list", "-n", "0", "--json").ok().json
    assert rows, "the library came back empty"
    dates = [row["modified"] for row in rows]
    assert dates == sorted(dates, reverse=True), "list is not newest-first"
    today = (
        run_cli(
            "list", "--modified-since", time.strftime("%Y-%m-%d"), "-n", "0", "--json"
        )
        .ok()
        .json
    )
    assert all(row["modified"][:10] >= time.strftime("%Y-%m-%d") for row in today)


def test_get_by_id_and_html(live_db: Path) -> None:
    note = (
        run_cli(
            "create",
            "--title",
            title("readable"),
            "--body",
            "line one\nline two & <three>",
            "-f",
            SCRATCH,
            "--json",
        )
        .ok()
        .json
    )
    got = run_cli("get", note["id"], "--json").ok().json
    assert got["title"] == title("readable")
    assert got["folder"] == SCRATCH
    assert got["plaintext"] == "line one\nline two & <three>"
    assert got["attachments"] == 0
    assert got["created"].startswith("20")

    html = run_cli("get", note["id"], "--html", "--json").ok().json["body"]
    # Notes serialises entities *without* the trailing semicolon (`&amp`, `&lt`).
    # It is stable -- feeding that HTML back yields the same plaintext -- but it
    # is not valid HTML, so never re-parse what --html returned.
    assert "&amp" in html and "&lt" in html and "<div>" in html, html
    assert "& <" not in html, "raw text must not appear unescaped in the body"

    human = run_cli("get", note["id"]).ok().out
    assert "line one" in human and note["id"] in human


def test_get_missing_id_fails_loudly(live_db: Path) -> None:
    result = run_cli(
        "get", "x-coredata://00000000-0000-0000-0000-000000000000/ICNote/p999999"
    )
    assert result.code != 0
    assert "no note with id" in result.err


def test_get_rejects_non_id_as_positional(live_db: Path) -> None:
    result = run_cli("get", "some words that are not an id")
    assert result.code != 0 and "--title" in result.err


def test_folders_listing(live_db: Path) -> None:
    rows = run_cli("folders", "--json").ok().json
    paths = {row["path"] for row in rows}
    assert SCRATCH in paths
    assert "Notes" in paths, "the built-in Notes folder is always there"
    nested = [row for row in rows if "/" in row["path"]]
    assert all(row["notes"] >= 0 for row in rows)
    if nested:
        assert nested, "nested folders should be reported with full paths"
    deleted = run_cli("folders", "--include-deleted", "--json").ok().json
    assert len(deleted) >= len(rows)


# ---------------------------------------------------------------------------
# Write paths
# ---------------------------------------------------------------------------


def test_create_get_update_append_round_trip(scratch_note: dict[str, str]) -> None:
    note_id = scratch_note["id"]

    updated = (
        run_cli("update", note_id, "--body", "replaced\nsecond & <line>", "--json")
        .ok()
        .json
    )
    assert updated["title"] == title("note"), "a body write must not change the title"
    assert (
        run_cli("get", note_id, "--json").ok().json["plaintext"].startswith("replaced")
    )

    # append and prepend splice into the existing body
    run_cli("append", note_id, "--body", "appended tail", "--json").ok()
    run_cli("append", note_id, "--body", "headed line", "--before", "--json").ok()
    text = run_cli("get", note_id, "--json").ok().json["plaintext"]
    assert text.startswith("headed line"), text
    assert "replaced" in text
    assert "appended tail" in text
    assert (
        text.index("headed line") < text.index("replaced") < text.index("appended tail")
    )


def test_create_from_file_and_stdin(
    live_db: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    body = tmp_path / "body.txt"
    body.write_text("from a file\nsecond line\n", encoding="utf-8")
    note = (
        run_cli(
            "create",
            "--title",
            title("from-file"),
            "--body-file",
            str(body),
            "-f",
            SCRATCH,
            "--json",
        )
        .ok()
        .json
    )
    assert (
        run_cli("get", note["id"], "--json")
        .ok()
        .json["plaintext"]
        .startswith("from a file")
    )

    monkeypatch.setattr(sys, "stdin", _StdinStub("from stdin & <tags>"))
    result = run_cli(
        "create", "--title", title("from-stdin"), "--stdin", "-f", SCRATCH, "--json"
    )
    note_id = result.ok().json["id"]
    assert (
        run_cli("get", note_id, "--json")
        .ok()
        .json["plaintext"]
        .startswith("from stdin & <tags>")
    )
    run_cli("delete", note_id, "--yes")


class _StdinStub:
    def __init__(self, text: str) -> None:
        self._text = text

    def read(self) -> str:
        return self._text


def test_create_needs_a_body(live_db: Path) -> None:
    result = run_cli("create", "--title", title("empty"), "-f", SCRATCH)
    assert result.code != 0 and "body" in result.err


def test_title_derivation_is_overridden(live_db: Path) -> None:
    """Notes derives a title from the body's first line; we must override it."""
    note = (
        run_cli(
            "create",
            "--title",
            title("kept-title"),
            "--body",
            "This Line Looks Like A Title\nbody text",
            "-f",
            SCRATCH,
            "--json",
        )
        .ok()
        .json
    )
    assert note["title"] == title("kept-title")
    assert run_cli("get", note["id"], "--json").ok().json["title"] == title(
        "kept-title"
    )


def test_rename_keeps_body(live_db: Path) -> None:
    note = (
        run_cli(
            "create",
            "--title",
            title("rename-me"),
            "--body",
            "keep me",
            "-f",
            SCRATCH,
            "--json",
        )
        .ok()
        .json
    )
    renamed = (
        run_cli("update", note["id"], "--rename", title("renamed"), "--json").ok().json
    )
    assert renamed["title"] == title("renamed")
    assert (
        run_cli("get", note["id"], "--json")
        .ok()
        .json["plaintext"]
        .startswith("keep me")
    )


def test_ambiguous_title_is_refused_but_ids_resolve(live_db: Path) -> None:
    twin = title("twin")
    first = (
        run_cli(
            "create",
            "--title",
            twin,
            "--body",
            "first twin body",
            "-f",
            SCRATCH,
            "--json",
        )
        .ok()
        .json
    )
    second = (
        run_cli(
            "create",
            "--title",
            twin,
            "--body",
            "second twin body",
            "-f",
            SCRATCH,
            "--json",
        )
        .ok()
        .json
    )
    assert first["id"] != second["id"]
    assert len(find_by_title(twin)) == 2, "the duplicate was not actually created"

    # A title that matches two notes must never silently resolve to one of them.
    ambiguous = run_cli("get", "--title", twin)
    assert ambiguous.code != 0
    assert "not unique" in ambiguous.err
    assert first["id"] in ambiguous.err and second["id"] in ambiguous.err

    # Both ids still resolve individually, to different content.
    assert (
        run_cli("get", first["id"], "--json")
        .ok()
        .json["plaintext"]
        .startswith("first twin")
    )
    assert (
        run_cli("get", second["id"], "--json")
        .ok()
        .json["plaintext"]
        .startswith("second twin")
    )
    unique = (
        run_cli(
            "create",
            "--title",
            title("sole"),
            "--body",
            "only one of me",
            "-f",
            SCRATCH,
            "--json",
        )
        .ok()
        .json
    )
    assert (
        run_cli("get", "--title", title("sole"), "--json").ok().json["id"]
        == unique["id"]
    )


def test_unknown_title_fails_loudly(live_db: Path) -> None:
    result = run_cli("get", "--title", title("never-created"))
    assert result.code != 0 and "no note titled" in result.err


def test_mv_and_delete(live_db: Path) -> None:
    note = (
        run_cli(
            "create",
            "--title",
            title("mover"),
            "--body",
            "moving around",
            "-f",
            SCRATCH,
            "--json",
        )
        .ok()
        .json
    )
    moved = run_cli("mv", note["id"], "-f", "Notes", "--json").ok().json
    assert moved["folder"] == "Notes"
    assert any(
        row["id"] == note["id"]
        for row in run_cli("list", "-f", "Notes", "-n", "0", "--json").ok().json
    )

    refused = run_cli("delete", note["id"])
    assert refused.code != 0 and "--yes" in refused.err
    assert any(row["id"] == note["id"] for row in applescript.note_metadata()), (
        "delete without --yes must not delete"
    )

    deleted = run_cli("delete", note["id"], "--yes", "--json").ok().json
    assert deleted["folder"] == "Notes"
    live_ids = {
        row["id"]
        for row in applescript.note_metadata()
        if not index.is_excluded(row["folder"])
    }
    assert note["id"] not in live_ids, "the note should no longer be in a normal folder"
    assert any(row["id"] == note["id"] for row in applescript.note_metadata()), (
        "it should still exist in Recently Deleted"
    )


# ---------------------------------------------------------------------------
# Index, lexical search, semantics
# ---------------------------------------------------------------------------


@needs_endpoint
def test_index_build_then_incremental_noop(live_db: Path) -> None:
    note = (
        run_cli(
            "create",
            "--title",
            title("indexable"),
            "--body",
            "zyphraspex semantic probe marker",
            "-f",
            SCRATCH,
            "--json",
        )
        .ok()
        .json
    )

    built = run_cli("index", "--json").ok().json
    assert built["seen"] > 0
    assert built["index"]["notes"] == built["seen"]
    assert built["index"]["embedded"] == built["index"]["notes"], (
        "every note should have a vector"
    )
    assert built["index"]["dims"] == 896, (
        f"expected the configured dims, got {built['index']['dims']}"
    )
    assert built["added"] >= 1

    again = run_cli("index", "--json").ok().json
    assert again["added"] == 0 and again["updated"] == 0, "a re-run must be a no-op"
    assert again["unchanged"] == again["seen"]
    assert again["seconds_total"] < 30, (
        "incremental sync should be seconds, not minutes"
    )
    print(
        f"\n# incremental no-op over {again['seen']} notes took {again['seconds_total']:.1f}s "
        f"(metadata {again['seconds_metadata']:.1f}s)"
    )

    # The new note is now visible to both search paths.
    assert any(
        row["id"] == note["id"]
        for row in run_cli("search", "zyphraspex", "--no-sync", "--json")
        .ok()
        .json["results"]
    )
    found = (
        run_cli("find", "zyphraspex semantic probe marker", "-n", "5", "--json")
        .ok()
        .json
    )
    assert any(row["id"] == note["id"] for row in found["results"]), found["results"]


@needs_endpoint
def test_search_lexical_all_and_any(live_db: Path) -> None:
    run_cli(
        "create", "--title", title("lex-a"), "--body", "quokka wombat", "-f", SCRATCH
    ).ok()
    run_cli(
        "create", "--title", title("lex-b"), "--body", "quokka only", "-f", SCRATCH
    ).ok()
    run_cli("index", "--json").ok()

    both = (
        run_cli("search", "quokka", "wombat", "--match", "all", "--no-sync", "--json")
        .ok()
        .json["results"]
    )
    either = (
        run_cli("search", "quokka", "wombat", "--match", "any", "--no-sync", "--json")
        .ok()
        .json["results"]
    )
    assert len(both) <= len(either)
    titled = {row["title"] for row in either}
    assert title("lex-a") in titled or title("lex-b") in titled, either
    for row in either:
        assert row["id"].startswith("x-coredata://")
        assert "body" not in row, "hits must not drag whole note bodies into the output"
        assert row["snippet"], "lexical hits should carry a snippet"


@needs_endpoint
def test_find_ranks_and_reports_scores(live_db: Path) -> None:
    run_cli(
        "create",
        "--title",
        title("sem-target"),
        "--body",
        "The fjords of Norway are deep and cold.",
        "-f",
        SCRATCH,
    ).ok()
    run_cli("index", "--json").ok()
    result = run_cli("find", "norwegian fjords cold water", "-n", "3", "--json").ok()
    payload = result.json
    scores = [row["score"] for row in payload["results"]]
    assert scores == sorted(scores, reverse=True), "results must be ranked by score"
    assert payload["index"]["embedded"] > 0
    assert all(row["id"].startswith("x-coredata://") for row in payload["results"])
    # Scores are only comparable within this model, and a code embedder on prose
    # never reaches the 0.8 a text model would -- assert the band, not a match.
    assert max(scores) < 0.85, scores

    human = run_cli("find", "norwegian fjords", "-n", "2").ok().out
    assert "# 2 result(s)" in human and "0." in human

    # --min-score above everything must be able to empty the result set.
    assert (
        run_cli("find", "norwegian fjords", "-n", "3", "--min-score", "0.99", "--json")
        .ok()
        .json["results"]
        == []
    )


def test_find_without_vectors_reports_why(
    isolated_db: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("NOTES_EMBED_BASE_URL", DEAD_ENDPOINT)
    result = run_cli("find", "anything at all", "--no-sync")
    assert result.code != 0
    assert "index" in result.err.lower()


def test_index_survives_dead_endpoint(
    isolated_db: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The text must still land in the index when the embedder is down."""
    monkeypatch.setenv("NOTES_EMBED_BASE_URL", DEAD_ENDPOINT)
    built = run_cli("index", "--json").ok().json
    assert built["embed_errors"], "a dead endpoint must be reported, not swallowed"
    assert built["embedded"] == 0
    assert built["index"]["with_body"] == built["index"]["notes"], (
        "text indexing must not depend on the server"
    )

    hits = (
        run_cli("search", "Notes", "--no-sync", "-n", "5", "--json")
        .ok()
        .json["results"]
    )
    assert hits, "lexical search must work with no embeddings at all"
    assert (
        run_cli("search", "Notes", "--no-sync", "--json").ok().json["sync"] is None
    ), "--no-sync must not report a sync"
    failed = run_cli("find", "anything", "--no-sync")
    assert failed.code != 0 and "notes index" in failed.err, failed.err


@needs_endpoint
def test_index_detects_a_changed_note(live_db: Path) -> None:
    note = (
        run_cli(
            "create",
            "--title",
            title("mutating"),
            "--body",
            "first version of the text",
            "-f",
            SCRATCH,
            "--json",
        )
        .ok()
        .json
    )
    run_cli("index", "--json").ok()
    run_cli(
        "update", note["id"], "--body", "second version, distinctly worded", "--json"
    ).ok()
    synced = run_cli("index", "--json").ok().json
    assert synced["updated"] >= 1, "an edited note must be re-indexed"
    hits = run_cli("search", "distinctly", "--no-sync", "--json").ok().json["results"]
    assert any(row["id"] == note["id"] for row in hits), hits


@needs_endpoint
def test_search_refreshes_the_index_itself(live_db: Path) -> None:
    """`search` must never answer from an index that predates the note.

    Regression guard: `search` used to build the index only when the table was
    completely empty, so text added after the last `notes index` was reported
    as "0 matches" -- a miss that looks exactly like a real answer.
    """
    note = (
        run_cli(
            "create",
            "--title",
            title("stale-guard"),
            "--body",
            "the first plumbusverse marker",
            "-f",
            SCRATCH,
            "--json",
        )
        .ok()
        .json
    )
    run_cli("index", "--json").ok()

    # Change the note without touching `notes index` afterwards.
    run_cli(
        "append", note["id"], "--body", "appended twosockel later text", "--json"
    ).ok()

    hits = run_cli("search", "twosockel", "--json").ok()
    assert any(row["id"] == note["id"] for row in hits.json["results"]), hits
    assert hits.json["sync"] is not None, "search must report the refresh it did"

    # The human path must render the payload too, not just the JSON one.
    human = run_cli("search", "twosockel").ok().out
    assert "# 0 match" not in human, human
    assert "match(es) for any(twosockel)" in human, human
    assert "index synced" in human, human
    assert note["id"] in human, human


def test_mixed_models_are_not_ranked_together(
    isolated_db: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    conn = index.connect(isolated_db)
    seed(conn, [("id-a", [1.0, 0.0]), ("id-b", [0.0, 1.0])])
    index.set_meta(conn, "model", "some-other-embedder")
    index.set_meta(conn, "dims", "2")
    conn.commit()
    conn.close()

    result = run_cli("find", "anything", "--no-sync")
    assert result.code != 0 and "index --full" in result.err, result.err


def test_cosine_ranks_a_handmade_corpus(
    isolated_db: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Hand-made vectors, so ranking is checked without trusting any model."""
    conn = index.connect(isolated_db)
    seed(
        conn,
        [
            ("near", [1.0, 0.0, 0.0]),
            ("side", [0.8, 0.6, 0.0]),
            ("far", [0.0, 0.0, 1.0]),
        ],
    )
    conn.close()
    monkeypatch.setattr(index, "embed", lambda texts, **kwargs: [[1.0, 0.0, 0.0]])

    hits = index.find_similar(index.connect(isolated_db), "query", limit=3)
    assert [hit["id"] for hit in hits] == ["near", "side", "far"], hits
    assert hits[0]["score"] == pytest.approx(1.0, abs=1e-4)
    assert hits[1]["score"] == pytest.approx(0.8, abs=1e-4)
    assert hits[2]["score"] == pytest.approx(0.0, abs=1e-4)
    assert [
        hit["id"]
        for hit in index.find_similar(
            index.connect(isolated_db), "q", limit=3, min_score=0.5
        )
    ] == ["near", "side"]
    assert index.cosine([3.0, 4.0], [3.0, 4.0]) == pytest.approx(1.0)
    assert index.cosine([1.0, 0.0], [0.0, 5.0]) == pytest.approx(0.0)
    assert index.cosine([0.0, 0.0], [1.0, 1.0]) == 0.0, (
        "a zero vector must not divide by zero"
    )


def test_index_records_model_and_dims(
    isolated_db: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        index, "embed", lambda texts, **kwargs: [[1.0, 2.0, 2.0] for _ in texts]
    )
    run_cli("index", "--full", "--json").ok()
    conn = index.connect(isolated_db)
    assert index.get_meta(conn, "model") == index.model()
    assert index.get_meta(conn, "dims") == "3"
    row = conn.execute(
        "SELECT dims, model, length(embedding) FROM notes LIMIT 1"
    ).fetchone()
    assert row == (3, index.model(), 12), row
    conn.close()


def test_incremental_sync_prunes_deleted_notes(
    isolated_db: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        index, "embed", lambda texts, **kwargs: [[1.0, 0.0] for _ in texts]
    )
    monkeypatch.setattr(
        applescript,
        "note_metadata",
        lambda **kw: [
            {
                "account": "iCloud",
                "folder": "Notes",
                "id": "id-1",
                "title": "one",
                "modified": "2026-01-01T00:00:00",
            }
        ],
    )
    conn = index.connect(isolated_db)
    index.sync(conn, full=True)
    assert conn.execute("SELECT COUNT(*) FROM notes").fetchone()[0] == 1
    monkeypatch.setattr(applescript, "note_metadata", lambda **kw: [])
    index.sync(conn)
    assert conn.execute("SELECT COUNT(*) FROM notes").fetchone()[0] == 0, (
        "a note that vanished must leave the index"
    )
    conn.close()


def test_recently_deleted_is_excluded_by_default(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    assert index.is_excluded("Recently Deleted")
    assert index.is_excluded("Recently Deleted/Subfolder")
    assert not index.is_excluded("Notes")
    monkeypatch.setenv("NOTES_EXCLUDE_FOLDERS", "Archive")
    assert index.is_excluded("Archive")
    assert not index.is_excluded("Recently Deleted")


# ---------------------------------------------------------------------------
# Doctor
# ---------------------------------------------------------------------------


def test_doctor_reports_the_whole_picture(isolated_db: Path) -> None:
    report = run_cli("doctor", "--json").ok().json
    assert report["osascript"] is True
    assert report["notes"]["reachable"] is True
    assert report["notes"]["accounts"], "at least one account should answer"
    assert report["db"].endswith("index.sqlite")
    assert "index" in report and report["index"]["lexical"] in {"fts5", "like"}
    assert isinstance(report["embeddings"].get("ok"), bool)
    assert report["index"]["notes"] == 0
    assert report["hints"], "an empty index should produce at least one hint"


def test_doctor_names_the_failure_when_the_embedder_is_down(
    isolated_db: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("NOTES_EMBED_BASE_URL", DEAD_ENDPOINT)
    report = run_cli("doctor", "--json").ok().json
    assert report["embeddings"]["ok"] is False
    assert "cannot reach" in report["embeddings"]["error"]
    assert any("127.0.0.1" in hint for hint in report["hints"]), report["hints"]


def test_refuses_the_system_python(monkeypatch: pytest.MonkeyPatch) -> None:
    """The macOS system interpreter is 3.9 and cannot run this package."""
    monkeypatch.setattr(cli.sys, "version_info", (3, 9, 6, "final", 0))
    result = run_cli("list")
    assert result.code == 2 and "3.12" in result.err and "uv" in result.err


def test_help_lists_every_command() -> None:
    out: list[str] = []
    with contextlib.redirect_stdout(_Sink(out)), pytest.raises(SystemExit):
        cli.main(["--help"])
    text = "".join(out)
    for cmd in (
        "list",
        "get",
        "create",
        "update",
        "append",
        "delete",
        "mv",
        "folders",
        "search",
        "find",
        "index",
        "doctor",
    ):
        assert cmd in text, f"{cmd} missing from --help"


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-v"]))
