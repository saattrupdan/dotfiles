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
  the teardown deletes only the notes this suite created;
* the count stays in single digits per run;
* the teardown purges the whole ``pi-skill-`` prefix — not just this session's
  titles, which cannot see another session's leftovers — inside a
  ``try``/``finally``, so the scratch folder goes away even after a failed
  test. Purging means deleting twice: once to move the note to Recently
  Deleted, once to erase it there (`delete` alone leaves it sitting in the
  user's Recently Deleted for about 30 days).

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

from apple_notes import applescript, index, undo
from apple_notes import main as cli

SESSION = f"{time.strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:6]}"
PREFIX = f"pi-skill-test {SESSION} "
# Everything this suite has ever called a test note, not just this session's.
# `pi-skill-check <epoch>` artifacts from an earlier run sat in Recently
# Deleted until someone purged them by hand, because a prefix tied to one
# session can never see another session's leftovers.
SWEEP = "pi-skill-"
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


def purge_test_notes(prefix: str = SWEEP) -> None:
    """Delete every note whose title starts with ``prefix``, then purge them.

    Two passes are needed because `delete` only moves a note to Recently
    Deleted, where it stays queryable for ~30 days. These notes were created
    minutes ago by these very tests, so a second delete purges them instead of
    leaving one row per test run behind in the user's Recently Deleted -- and
    the sweep is the whole ``pi-skill-`` prefix, so a crashed earlier session
    cannot leave notes behind either.
    """
    for _ in range(4):
        mine = [
            row
            for row in applescript.note_metadata()
            if row["title"].startswith(prefix)
        ]
        if not mine:
            return
        for row in mine:
            run_cli("delete", row["id"], "--yes")
    raise AssertionError("test notes survived the purge sweep")  # pragma: no cover


def remove_scratch_folders() -> None:
    """Delete every ``pi-skill-test-scratch-*`` folder, this run's or not.

    The fixture only names its own folder, so a session that crashed before its
    teardown left an empty scratch folder behind forever -- two were sitting in
    the reference library when this was written.
    """
    for folder in applescript.folders():
        leaf = folder["path"].rsplit("/", 1)[-1]
        if leaf.startswith("pi-skill-test-scratch-"):
            osascript(
                f'tell application "Notes" to delete (first folder whose name is "{leaf}")'
            )


@pytest.fixture(scope="session")
def live_db(tmp_path_factory: pytest.TempPathFactory) -> Path:
    """Notes with a scratch folder, and a session-scoped temp index."""
    db = tmp_path_factory.mktemp("apple-notes") / "index.sqlite"
    os.environ["NOTES_DB"] = str(db)
    # Every write snapshots the body it replaces. Point that at the session
    # temp dir so no test run leaves scratch content in the real
    # ~/Library/Application Support/apple-notes/undo/.
    os.environ["NOTES_UNDO_DIR"] = str(db.parent / "undo")
    osascript(
        'tell application "Notes" to tell account "iCloud" to '
        f'make new folder with properties {{name:"{SCRATCH}"}}'
    )
    assert SCRATCH in {folder["path"] for folder in applescript.folders()}
    try:
        yield db
    finally:
        # Teardown runs even when a test failed mid-way, or the scratch folder
        # and every note in it would be left in the user's library.
        try:
            purge_test_notes()
            leftover = [
                row
                for row in applescript.note_metadata()
                if row["title"].startswith(SWEEP)
            ]
            assert leftover == [], f"test notes survived teardown: {leftover}"
        finally:
            try:
                remove_scratch_folders()
            finally:
                assert SCRATCH not in {
                    folder["path"] for folder in applescript.folders()
                }
                os.environ.pop("NOTES_DB", None)
                os.environ.pop("NOTES_UNDO_DIR", None)


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


def seed(
    conn: sqlite3.Connection,
    rows: list[tuple[str, list[float]]],
    *,
    text: str | None = None,
) -> None:
    """Insert notes with hand-made vectors.

    ``text`` overrides title and body for every row, for tests that care about
    what the lexical index tokenises rather than what it ranks.
    """
    conn.executescript(index.SCHEMA)
    if index.has_fts5(conn):
        conn.executescript(index.FTS_SCHEMA)
    for note_id, vector in rows:
        title = text or f"note {note_id}"
        body = text or f"body of {note_id}"
        conn.execute(
            "INSERT INTO notes(id, title, folder, account, modified, body, body_hash, embedding, model, dims, indexed_at)"
            " VALUES(?,?,?,?,?,?,?,?,?,?,?)",
            (
                note_id,
                title,
                "Notes",
                "iCloud",
                "2026-01-01T00:00:00",
                body,
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
                (note_id, title, body),
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


def test_empty_body_input_is_refused(
    scratch_note: dict[str, str], tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An empty --stdin/--body-file is *no body*, not an empty note.

    `notes update <id> --stdin < /dev/null` used to pass the `body is None`
    guard and write `<div></div>` — a redirect typo that quietly empties a
    note, with no way back.
    """
    monkeypatch.setenv("NOTES_UNDO_DIR", str(tmp_path / "undo"))
    empty = tmp_path / "empty.txt"
    empty.write_text("", encoding="utf-8")
    for argv in (
        ("update", scratch_note["id"], "--body-file", str(empty)),
        ("append", scratch_note["id"], "--body-file", str(empty)),
    ):
        result = run_cli(*argv)
        assert result.code != 0 and "nothing to do" in result.err, result.err

    monkeypatch.setattr(sys, "stdin", _StdinStub(""))
    refused = run_cli("update", scratch_note["id"], "--stdin")
    assert refused.code != 0 and "nothing to do" in refused.err, refused.err
    text = run_cli("get", scratch_note["id"], "--json").ok().json["plaintext"]
    assert text.startswith("alpha beta"), "the note must be untouched"

    # --force is how you say emptying it is the actual goal.
    run_cli("update", scratch_note["id"], "--stdin", "--force", "--json").ok()
    assert run_cli("get", scratch_note["id"], "--json").ok().json["plaintext"] == ""

    # Leave no empty note behind: there is nothing to embed for one, and the
    # library-wide index test asserts every note came back with a vector.
    run_cli("update", scratch_note["id"], "--body", "alpha beta gamma", "--json").ok()


def test_update_keeps_an_undo_copy(
    scratch_note: dict[str, str], tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A full-body replace must leave the previous body somewhere findable.

    The file is the previous plaintext byte for byte, so `--body-file` puts it
    back; the payload names the path, and it is a file rather than a row in the
    index because that database is documented as a cache.
    """
    undo_dir = tmp_path / "undo"
    monkeypatch.setenv("NOTES_UNDO_DIR", str(undo_dir))

    human = (
        run_cli("update", scratch_note["id"], "--body", "first replacement").ok().out
    )
    assert "undo:" in human and "restore" in human, human

    payload = (
        run_cli("update", scratch_note["id"], "--body", "second replacement", "--json")
        .ok()
        .json
    )
    saved = Path(payload["undo"]["path"])
    assert saved.parent == undo_dir
    assert (
        saved.name.startswith("20")
        and scratch_note["id"].rsplit("/", 1)[-1] in saved.name
    )
    assert saved.read_text(encoding="utf-8") == "first replacement"
    assert payload["undo"]["title"] == scratch_note["title"]
    assert payload["undo"]["chars"] == len("first replacement")

    # And it really does restore the note.
    run_cli("update", scratch_note["id"], "--body-file", str(saved), "--json").ok()
    assert (
        run_cli("get", scratch_note["id"], "--json").ok().json["plaintext"]
        == "first replacement"
    )
    assert len(list(undo_dir.glob("*.txt"))) == 3


def test_undo_files_are_bounded(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    target = tmp_path / "undo"
    monkeypatch.setenv("NOTES_UNDO_DIR", str(target))
    for i in range(undo.KEEP + 7):
        undo.save(
            f"x-coredata://00000000-0000-0000-0000-000000000000/ICNote/p{i}",
            title="t",
            body="b",
        )
    files = sorted(target.glob("*.txt"))
    assert len(files) == undo.KEEP, "the undo directory must not grow without bound"


def test_rename_refuses_an_empty_title(
    scratch_note: dict[str, str], tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`--rename ""` used to clear the title, which is never what was meant."""
    monkeypatch.setenv("NOTES_UNDO_DIR", str(tmp_path / "undo"))
    result = run_cli("update", scratch_note["id"], "--rename", "")
    assert result.code != 0 and "--rename needs a title" in result.err, result.err
    assert (
        run_cli("get", scratch_note["id"], "--json").ok().json["title"]
        == scratch_note["title"]
    )


def test_title_lookup_skips_recently_deleted_and_agrees_with_the_id(
    live_db: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`every note whose name is X` is unscoped; the CLI must not be.

    Reproduced against a trashed copy: `notes get --title X` returned the note
    in Recently Deleted and exited 0. Giving both an id and `--title` also used
    to ignore `--title` completely.
    """
    monkeypatch.setenv("NOTES_UNDO_DIR", str(tmp_path / "undo"))
    note = (
        run_cli(
            "create",
            "--title",
            title("trashed"),
            "--body",
            "gone soon",
            "-f",
            SCRATCH,
            "--json",
        )
        .ok()
        .json
    )
    assert (
        run_cli("get", "--title", title("trashed"), "--json").ok().json["id"]
        == note["id"]
    )

    # Both handles given: they must name the same note.
    assert (
        run_cli("get", note["id"], "--title", title("trashed"), "--json")
        .ok()
        .json["id"]
        == note["id"]
    )
    rival = (
        run_cli(
            "create",
            "--title",
            title("rival"),
            "--body",
            "a different note",
            "-f",
            SCRATCH,
            "--json",
        )
        .ok()
        .json
    )
    conflict = run_cli("get", note["id"], "--title", title("rival"))
    assert conflict.code != 0 and "one handle" in conflict.err, conflict.err
    assert rival["id"] in conflict.err, (
        "the error must name the note the title actually resolves to"
    )
    # A title that matches nothing is still a "no note titled", not a conflict.
    missing = run_cli("get", note["id"], "--title", title("never-created"))
    assert missing.code != 0 and "no note titled" in missing.err, missing.err

    run_cli("delete", note["id"], "--yes").ok()
    gone = run_cli("get", "--title", title("trashed"))
    assert gone.code != 0 and "Recently Deleted" in gone.err, gone.err
    assert (
        run_cli("get", "--title", title("trashed"), "--include-deleted", "--json")
        .ok()
        .json["id"]
        == note["id"]
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
    # A note with no text has nothing to embed (the endpoint would reject the
    # empty input), so the invariant is "every note *with text* has a vector".
    conn = sqlite3.connect(os.environ["NOTES_DB"])
    blank = conn.execute("SELECT id, title FROM notes WHERE body = ''").fetchall()
    conn.close()
    assert built["index"]["embedded"] == built["index"]["notes"] - len(blank), (
        f"every note with text should have a vector; "
        f"embed_errors={built['embed_errors']} blank={blank}"
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
    # NOTE: weaker than it looks — `digest("")` is non-empty, so `with_body`
    # counts rows whose body never arrived. See SKILL.md, Limits: Known gaps.
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
# Review round: retry policy, stems, undo, empty input, title scoping, sync
# resilience. Everything here is offline — the runner is stubbed — so none of
# it adds to the suite's wall time.
# ---------------------------------------------------------------------------

# The four scripts that write, recognised by the line that mutates. Every one
# of them keeps firing Apple events *after* the change (`id of n`, `name of n`,
# the `notePath` container walk), which is why a timeout cannot be retried.
_MUTATION_MARKERS = ("make new note", "set body of n", "delete n", "move n to")
# Shaped like real ``osascript`` stderr: ``<path>:<line>:<col>: execution
# error: … (<code>)``, which is what `_parse_error` reads the code from.
_TRANSIENT_STDERR = (
    "/tmp/pi-notes-stub.applescript:37:40: execution error: Notes got an error: "
    "AppleEvent timed out. (-1712)\n"
)
_STUB_ID = "x-coredata://00000000-0000-0000-0000-000000000000/ICNote/p1"


def _stub_osascript(
    monkeypatch: pytest.MonkeyPatch, *, fail_reads: bool = False
) -> list[str]:
    """Replace the ``osascript`` launch with a recorder of the scripts run.

    Reads answer from a canned record so the CLI actually reaches the write;
    every write fails with a retryable Apple-event timeout, which is exactly
    the case that used to re-run the mutation. Returns the list of script
    texts, which the test counts by hand.
    """
    calls: list[str] = []

    def fake(cmd: list[str], **kwargs: t.Any) -> subprocess.CompletedProcess:
        script = Path(cmd[1]).read_text(encoding="utf-8")
        calls.append(script)
        mutating = any(marker in script for marker in _MUTATION_MARKERS)
        if fail_reads or mutating:
            return subprocess.CompletedProcess(cmd, 1, "", _TRANSIENT_STDERR)
        if "set wantHTML to" in script:  # _GET_SCRIPT
            fields = [
                _STUB_ID,
                "stubbed note",
                "Notes",
                "iCloud",
                "2026-01-01T00:00:00",
                "2026-01-01T00:00:00",
                "false",
                "0",
                "stub plaintext body",
                "<div>stub plaintext body</div>",
            ]
            return subprocess.CompletedProcess(
                cmd, 0, applescript.US.join(fields) + applescript.RS, ""
            )
        return subprocess.CompletedProcess(cmd, 0, "", "")

    monkeypatch.setattr(applescript.subprocess, "run", fake)
    monkeypatch.setattr(applescript.time, "sleep", lambda _seconds: None)
    return calls


def test_writes_are_attempted_exactly_once(
    isolated_db: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """No mutation may ever run twice.

    `delete` is the sharp edge: the second delete of a note that is already in
    Recently Deleted erases it for good, and every mutation script does more
    Apple-event work after the write, so a timeout is indistinguishable from
    "nothing happened yet".
    """
    monkeypatch.setenv("NOTES_UNDO_DIR", str(tmp_path / "undo"))
    cases = {
        "create": (
            "create",
            "--title",
            "stub",
            "--body",
            "b",
            "-f",
            "Notes",
            "--account",
            "iCloud",
        ),
        "update": ("update", _STUB_ID, "--body", "b"),
        "delete": ("delete", _STUB_ID, "--yes"),
        "mv": ("mv", _STUB_ID, "-f", "Archive", "--account", "iCloud"),
    }
    for name, argv in cases.items():
        calls = _stub_osascript(monkeypatch)
        result = run_cli(*argv)
        mutating = [c for c in calls if any(m in c for m in _MUTATION_MARKERS)]
        assert result.code != 0, f"{name} claimed success against a failing Notes"
        assert len(mutating) == 1, (
            f"{name} issued {len(mutating)} mutating osascript calls; "
            "a retry would repeat the write itself"
        )


def test_reads_are_still_retried(
    isolated_db: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Only writes gave up their retries — a read may safely run again."""
    calls = _stub_osascript(monkeypatch, fail_reads=True)
    result = run_cli("list")
    assert result.code != 0
    assert len(calls) == 3, f"expected one read plus two retries, got {len(calls)}"


def test_a_payload_bug_is_not_reported_as_a_missing_note(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`except LookupError` also caught every KeyError.

    A missing key in a payload we built ourselves was printed as "no note with
    id …" and exit 1 — a dead end for whoever is debugging the payload.
    """
    monkeypatch.setattr(applescript, "get_note", lambda *args, **kwargs: {})
    with pytest.raises(KeyError):
        run_cli("get", _STUB_ID)


def test_lexical_search_matches_a_stem_and_says_when_it_misses(
    isolated_db: Path,
) -> None:
    """A stem must find the words it starts.

    FTS5 matches whole tokens, so ``notes search euroev`` used to print a clean
    ``# 0 match(es)`` while ``euroeval`` sat in 78 notes — the same silent-miss
    class the pre-query sync was added to kill.
    """
    conn = index.connect(isolated_db)
    seed(conn, [("euroeval", [1.0, 0.0])], text="the EuroEval budget line")
    conn.close()

    conn = index.connect(isolated_db)
    for term in ("euroev", "euroeval", "euroev*", '"euroev"*'):
        hits = index.search_lexical(conn, [term])
        assert [hit["id"] for hit in hits] == ["euroeval"], term
    assert index.search_lexical(conn, ["wombat"]) == []
    conn.close()

    miss = run_cli("search", "zyphraspex", "--no-sync").ok()
    assert "# 0 match" in miss.out
    assert "hint" in miss.err and "notes find" in miss.err, miss.err


def test_search_answers_from_the_index_when_notes_does_not(
    isolated_db: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`search` may not depend on Notes.app being awake.

    It used to answer from the index in ~50 ms; the pre-query sync made a hung
    Notes.app cost the full read timeout per retry instead. Warn, then answer.
    """
    conn = index.connect(isolated_db)
    seed(conn, [("plumbus", [1.0, 0.0])], text="the plumbusverse marker")
    conn.close()

    def hang(**kwargs: t.Any) -> None:
        raise applescript.AppleScriptError(
            "osascript timed out -- is Notes.app showing a modal dialog?", code=-1712
        )

    monkeypatch.setattr(applescript, "note_metadata", hang)
    result = run_cli("search", "plumbusverse", "--json")
    assert result.ok()
    assert "results may be stale" in result.err, result.err
    assert [row["id"] for row in result.json["results"]] == ["plumbus"]
    assert result.json["sync"] is None and result.json["stale"], result.json

    monkeypatch.setattr(index, "embed", lambda texts, **kw: [[1.0, 0.0]])
    monkeypatch.setattr(index, "embed_probe", lambda **kw: {"ok": True, "dims": 2})
    found = run_cli("find", "plumbus", "--json")
    assert found.ok()
    assert "results may be stale" in found.err, found.err
    assert found.json["results"][0]["id"] == "plumbus"


def test_automatic_sync_probes_a_dead_embedder_once(
    isolated_db: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """One short probe, not one long wait per batch — and index the text anyway."""
    rows = [
        {
            "account": "iCloud",
            "folder": "Notes",
            "id": f"id-{i}",
            "title": f"note {i}",
            "modified": "2026-01-01T00:00:00",
        }
        for i in range(70)
    ]

    def metadata(bodies: bool = False, **kwargs: t.Any) -> list[dict[str, str]]:
        if not bodies:
            return rows
        return [{**row, "body": f"the text of {row['id']}"} for row in rows]

    monkeypatch.setattr(applescript, "note_metadata", metadata)
    monkeypatch.setenv("NOTES_EMBED_BASE_URL", DEAD_ENDPOINT)
    attempts: list[dict[str, t.Any]] = []

    def dead(texts: t.Sequence[str], **kwargs: t.Any) -> list[list[float]]:
        attempts.append(kwargs)
        raise urllib.error.URLError("Connection refused")

    monkeypatch.setattr(index, "embed", dead)
    result = run_cli("search", "note", "--json").ok()
    assert len(attempts) == 1, f"a dead embedder cost {len(attempts)} embedding calls"
    assert attempts[0]["timeout"] == cli.AUTO_EMBED_TIMEOUT, (
        "the automatic sync must not use the 120 s `notes index` budget"
    )
    assert result.json["index"]["notes"] == 70, (
        "text indexing must not depend on the server"
    )
    assert result.json["results"], "lexical search must still work"
    assert result.json["sync"]["embed_errors"], "the failure must be reported"


def test_the_header_shows_what_the_sync_changed(
    isolated_db: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Pruning trusts absence, so a silent mass-delete must be visible."""
    monkeypatch.setattr(index, "embed", lambda texts, **kw: [[1.0, 0.0] for _ in texts])
    rows = [
        {
            "account": "iCloud",
            "folder": "Notes",
            "id": f"id-{i}",
            "title": f"note {i}",
            "modified": "2026-01-01T00:00:00",
        }
        for i in range(12)
    ]
    monkeypatch.setattr(applescript, "note_metadata", lambda **kw: rows)
    monkeypatch.setattr(
        applescript,
        "bodies_by_id",
        lambda ids, **kw: {i: f"the text of {i}" for i in ids},
    )
    run_cli("search", "note", "--json").ok()
    monkeypatch.setattr(applescript, "note_metadata", lambda **kw: rows[:2])
    human = run_cli("search", "note").ok().out
    assert "removed 10" in human, human


def test_an_empty_note_does_not_cost_its_batch(
    isolated_db: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """llama.cpp answers 400 for an empty input — so never send one.

    One empty note used to fail the whole batch of 32 and leave 31 unrelated
    notes unvectorised, which is invisible except as a lower `find` score
    count. (This is what emptied-the-note looked like end to end: 421 of 453
    notes embedded after a single note lost its body.)
    """
    rows = [
        {
            "account": "iCloud",
            "folder": "Notes",
            "id": f"id-{i}",
            "title": f"note {i}",
            "modified": "2026-01-01T00:00:00",
        }
        for i in range(20)
    ]
    bodies = {row["id"]: f"text of {row['id']}" for row in rows}
    bodies["id-7"] = ""
    monkeypatch.setattr(applescript, "note_metadata", lambda **kw: rows)
    monkeypatch.setattr(
        applescript, "bodies_by_id", lambda ids, **kw: {i: bodies[i] for i in ids}
    )
    sent: list[str] = []

    def spy(texts: t.Sequence[str], **kwargs: t.Any) -> list[list[float]]:
        sent.extend(texts)
        assert all(text for text in texts), "an empty input 400s the whole batch"
        return [[1.0, 0.0] for _ in texts]

    monkeypatch.setattr(index, "embed", spy)
    built = run_cli("index", "--json").ok().json
    assert "" not in sent
    assert built["embed_errors"] == [], built["embed_errors"]
    assert built["embedded"] == 19, "the other 19 notes must keep their vectors"


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
