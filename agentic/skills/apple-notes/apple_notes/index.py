"""The local SQLite index: incremental note metadata, embeddings, and search.

Notes.app has no search API — there is nothing to call for "find notes about
X". So the library is mirrored into a local index and *this* package does the
matching: SQLite/FTS5 for keywords, cosine over float32 vectors for semantic
``find``. 439 notes x 896 dims is ~400k multiplications, which is tens of
milliseconds in plain Python — fast enough that numpy would buy nothing and
cost a dependency.

The index lives at ``~/Library/Application Support/apple-notes/index.sqlite``
(override with ``NOTES_DB``). It is a cache: deleting it loses nothing but the
first-index round of embedding time.
"""

from __future__ import annotations

import array
import datetime as dt
import hashlib
import json
import math
import os
import sqlite3
import statistics
import sys
import time
import typing as t
import urllib.error
import urllib.request
from pathlib import Path

from . import applescript

DEFAULT_BASE_URL = "http://127.0.0.1:8080/v1"
DEFAULT_MODEL = "jina-code-embeddings-0.5b"
DEFAULT_MAX_CHARS = 6000
USER_AGENT = "apple-notes-cli"

# Above this many changed notes it is cheaper to re-read the library in one
# bulk pass than to fetch bodies by id: a per-note `plaintext` event costs
# ~45 ms, so 150 ids take ~7 s while the whole 439-note library arrives with
# its bodies in ~2 s (measured). Fewer changes than this means few round trips
# either way, and the metadata already in hand stays authoritative.
BULK_BODY_THRESHOLD = 32

# Notes' system folders, whose names are localised when the account is set up.
# Recently Deleted would otherwise dominate every query with half-dead notes:
# `delete` moves a note there and it stays reachable through `every note`.
# Override with NOTES_EXCLUDE_FOLDERS (colon-separated paths).
DEFAULT_EXCLUDED = (
    "Recently Deleted",
    "Senest slettet",
    "Zuletzt gelöscht",
    "Récemment supprimés",
    "Nylig slettet",
    "Raderat nyligen",
    "Trecent slettet",
    "Di recente eliminazione",
)

SCHEMA = """
CREATE TABLE IF NOT EXISTS notes (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL DEFAULT '',
  folder       TEXT NOT NULL DEFAULT '',
  account      TEXT NOT NULL DEFAULT '',
  modified     TEXT NOT NULL DEFAULT '',
  body         TEXT NOT NULL DEFAULT '',
  body_hash    TEXT NOT NULL DEFAULT '',
  embedding    BLOB,
  model        TEXT,
  dims         INTEGER,
  indexed_at   TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
"""

FTS_SCHEMA = """
CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
  note_id UNINDEXED,
  title,
  body,
  tokenize = 'unicode61 remove_diacritics 2'
);
"""


class IndexError_(RuntimeError):
    """Raised when the index cannot answer a question it was asked."""


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------


def base_url() -> str:
    return os.environ.get("NOTES_EMBED_BASE_URL", DEFAULT_BASE_URL).rstrip("/")


def model() -> str:
    return os.environ.get("NOTES_EMBED_MODEL", DEFAULT_MODEL)


def db_path() -> Path:
    override = os.environ.get("NOTES_DB")
    if override:
        return Path(override).expanduser()
    return (
        Path.home() / "Library" / "Application Support" / "apple-notes" / "index.sqlite"
    )


def excluded_folders() -> tuple[str, ...]:
    override = os.environ.get("NOTES_EXCLUDE_FOLDERS")
    if override:
        return tuple(p for p in override.split(":") if p)
    return DEFAULT_EXCLUDED


def is_excluded(path: str) -> bool:
    """Whether a folder path is a system folder that should be skipped.

    Compared case-insensitively against the whole path and every ancestor, so
    ``Recently Deleted`` also hides anything nested under it.
    """
    parts = [p.casefold() for p in path.split("/")]
    return any(part in {e.casefold() for e in excluded_folders()} for part in parts)


# ---------------------------------------------------------------------------
# Storage
# ---------------------------------------------------------------------------


def has_fts5(conn: sqlite3.Connection) -> bool:
    try:
        conn.execute("CREATE VIRTUAL TABLE IF NOT EXISTS _fts_probe USING fts5(x)")
    except sqlite3.OperationalError:
        return False
    conn.execute("DROP TABLE IF EXISTS _fts_probe")
    return True


def connect(path: str | os.PathLike[str] | None = None) -> sqlite3.Connection:
    """Open (creating if necessary) the index database."""
    target = Path(path).expanduser() if path is not None else db_path()
    target.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(target)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.executescript(SCHEMA)
    if has_fts5(conn):
        conn.executescript(FTS_SCHEMA)
    conn.commit()
    return conn


def get_meta(conn: sqlite3.Connection, key: str) -> str | None:
    row = conn.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
    return row[0] if row else None


def set_meta(conn: sqlite3.Connection, key: str, value: str) -> None:
    conn.execute(
        "INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (key, value),
    )


def stats(conn: sqlite3.Connection) -> dict[str, t.Any]:
    total, embedded, with_body = conn.execute(
        "SELECT COUNT(*), SUM(embedding IS NOT NULL), SUM(body_hash <> '') FROM notes"
    ).fetchone()
    return {
        "notes": total or 0,
        "embedded": embedded or 0,
        "with_body": with_body or 0,
        "model": get_meta(conn, "model"),
        "dims": int(get_meta(conn, "dims") or 0) or None,
        "indexed_at": get_meta(conn, "indexed_at"),
        "lexical": "fts5" if has_fts5(conn) else "like",
        "path": str(db_path()),
    }


def pack(vec: t.Sequence[float]) -> bytes:
    return array.array("f", [float(x) for x in vec]).tobytes()


def unpack(blob: bytes) -> array.array:
    vec = array.array("f")
    vec.frombytes(blob)
    return vec


# ---------------------------------------------------------------------------
# Embeddings
# ---------------------------------------------------------------------------


def embed(texts: t.Sequence[str], *, timeout: float = 120.0) -> list[list[float]]:
    """Embed ``texts`` in one request against the configured OpenAI-compatible
    endpoint. llama.cpp accepts array input, so a batch is one HTTP round trip.
    """
    payload = json.dumps({"model": model(), "input": list(texts)}).encode()
    req = urllib.request.Request(
        f"{base_url()}/embeddings",
        data=payload,
        headers={"Content-Type": "application/json", "User-Agent": USER_AGENT},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    items = sorted(data["data"], key=lambda d: d.get("index", 0))
    out = [item["embedding"] for item in items]
    if len(out) != len(texts):
        raise IndexError_(
            f"endpoint returned {len(out)} vectors for {len(texts)} inputs"
        )
    return out


def embed_probe(*, timeout: float = 10.0) -> dict[str, t.Any]:
    """Ask the endpoint whether it is alive and what it is serving."""
    out: dict[str, t.Any] = {"base_url": base_url(), "configured_model": model()}
    try:
        with urllib.request.urlopen(
            urllib.request.Request(
                f"{base_url()}/models", headers={"User-Agent": USER_AGENT}
            ),
            timeout=timeout,
        ) as resp:
            listing = json.loads(resp.read().decode("utf-8"))
        out["served_models"] = sorted(m.get("id", "?") for m in listing.get("data", []))
    except (urllib.error.URLError, OSError, ValueError) as exc:
        out["ok"] = False
        out["error"] = http_error_text(exc)
        return out
    try:
        vec = embed(["ping"], timeout=timeout)[0]
    except (urllib.error.URLError, OSError, ValueError, KeyError, IndexError) as exc:
        out["ok"] = False
        out["error"] = http_error_text(exc)
        return out
    out["ok"] = True
    out["dims"] = len(vec)
    return out


def http_error_text(exc: Exception) -> str:
    if isinstance(exc, urllib.error.HTTPError):
        return f"HTTP {exc.code} from {base_url()}: {exc.read()[:200].decode('utf-8', 'replace')}"
    if isinstance(exc, (urllib.error.URLError, OSError)):
        reason = getattr(exc, "reason", exc)
        return f"cannot reach {base_url()}: {reason}"
    return f"{type(exc).__name__}: {exc}"


def cosine(a: t.Sequence[float], b: t.Sequence[float]) -> float:
    dot = na = nb = 0.0
    for x, y in zip(a, b, strict=False):
        dot += x * y
        na += x * x
        nb += y * y
    if na <= 0.0 or nb <= 0.0:
        return 0.0
    return dot / math.sqrt(na * nb)


# ---------------------------------------------------------------------------
# Model / dimension guard
# ---------------------------------------------------------------------------


def vector_mismatch(
    conn: sqlite3.Connection, *, probe: bool = True
) -> dict[str, t.Any] | None:
    """Describe a mismatch between the stored vectors and the configured model.

    Mixing vectors from two models (or two dimensionalities) into one ranking is
    worse than no ranking at all, so it is refused rather than averaged out.
    The alias is compared locally; the dimensionality needs the endpoint, and
    when it is unreachable ``find`` will fail on the query embedding anyway --
    so an unreachable endpoint is not reported as a mismatch.
    """
    stored_model = get_meta(conn, "model")
    stored_dims = get_meta(conn, "dims")
    if not stored_model or not stored_dims:
        return None
    current_dims = int(stored_dims)
    if probe:
        found = embed_probe(timeout=8.0)
        if found.get("ok"):
            current_dims = int(found["dims"])
    if stored_model != model() or current_dims != int(stored_dims):
        return {
            "reason": "stored vectors were produced by a different model or have different dimensions",
            "stored_model": stored_model,
            "stored_dims": int(stored_dims),
            "current_model": model(),
            "current_dims": current_dims,
        }
    return None


# ---------------------------------------------------------------------------
# Sync
# ---------------------------------------------------------------------------


def sync(
    conn: sqlite3.Connection,
    *,
    full: bool = False,
    batch: int = 32,
    max_chars: int = DEFAULT_MAX_CHARS,
    quiet: bool = False,
) -> dict[str, t.Any]:
    """Bring the index in line with Notes.

    Incremental by default: one osascript call enumerates every note's
    metadata, and bodies are fetched and re-embedded only for notes that are
    new or whose modification date moved. ``full`` drops every row and re-reads
    the library, fetching bodies inside the same osascript pass.
    """
    started = time.monotonic()
    result: dict[str, t.Any] = {
        "full": full,
        "seen": 0,
        "added": 0,
        "updated": 0,
        "removed": 0,
        "unchanged": 0,
        "embedded": 0,
        "embed_errors": [],
        "seconds_metadata": 0.0,
        "seconds_bodies": 0.0,
        "seconds_embedding": 0.0,
    }

    if full:
        conn.execute("DELETE FROM notes")
        if has_fts5(conn):
            conn.execute("DELETE FROM notes_fts")
        conn.commit()

    t0 = time.monotonic()
    metadata = [
        row
        for row in applescript.note_metadata(bodies=full)
        if not is_excluded(row["folder"])
    ]
    result["seconds_metadata"] = time.monotonic() - t0
    result["seen"] = len(metadata)

    known = {
        nid: (modified, _)
        for nid, modified, _ in conn.execute(
            "SELECT id, modified, body_hash FROM notes"
        )
    }
    live = {row["id"]: row for row in metadata}

    stale = [nid for nid in known if nid not in live]
    if stale:
        conn.executemany("DELETE FROM notes WHERE id = ?", [(nid,) for nid in stale])
        if has_fts5(conn):
            conn.executemany(
                "DELETE FROM notes_fts WHERE note_id = ?", [(nid,) for nid in stale]
            )
        result["removed"] = len(stale)
        conn.commit()

    changed = [
        row
        for row in metadata
        if row["id"] not in known or known[row["id"]][0] != row["modified"]
    ]
    result["unchanged"] = len(metadata) - len(changed)
    result["added"] = sum(1 for row in changed if row["id"] not in known)
    result["updated"] = len(changed) - result["added"]

    if changed:
        t0 = time.monotonic()
        if full or len(changed) >= BULK_BODY_THRESHOLD:
            bodies = {
                row["id"]: row.get("body", "")
                for row in applescript.note_metadata(bodies=True)
            }
        else:
            bodies = applescript.bodies_by_id([row["id"] for row in changed])
        result["seconds_bodies"] = time.monotonic() - t0

        # Embed in batches, keeping going if the endpoint dies mid-way: the
        # text still lands in the index so `search` works without a server.
        vectors: dict[str, list[float]] = {}
        t0 = time.monotonic()
        for start in range(0, len(changed), batch):
            chunk = changed[start : start + batch]
            texts = [truncate(bodies.get(row["id"], ""), max_chars) for row in chunk]
            try:
                for row, vec in zip(chunk, embed(texts), strict=True):
                    vectors[row["id"]] = vec
            except (
                urllib.error.URLError,
                OSError,
                ValueError,
                KeyError,
                IndexError,
            ) as exc:
                result["embed_errors"].append(
                    f"batch {start // batch + 1}: {http_error_text(exc)}"
                )
                if not quiet:
                    print(
                        f"# embedding batch {start // batch + 1} failed; indexing text only",
                        file=sys.stderr,
                    )
        result["seconds_embedding"] = time.monotonic() - t0
        result["embedded"] = len(vectors)

        now = stamp()
        dims = len(next(iter(vectors.values()))) if vectors else 0
        fts = has_fts5(conn)
        for row in changed:
            body = bodies.get(row["id"], "")
            vec = vectors.get(row["id"])
            stored_model = model() if vec else None
            conn.execute(
                """
                INSERT INTO notes(id, title, folder, account, modified, body, body_hash, embedding, model, dims, indexed_at)
                VALUES(?,?,?,?,?,?,?,?,?,?,?)
                ON CONFLICT(id) DO UPDATE SET
                  title=excluded.title, folder=excluded.folder, account=excluded.account,
                  modified=excluded.modified, body=excluded.body, body_hash=excluded.body_hash,
                  embedding=excluded.embedding, model=excluded.model, dims=excluded.dims,
                  indexed_at=excluded.indexed_at
                """,
                (
                    row["id"],
                    row["title"],
                    row["folder"],
                    row["account"],
                    row["modified"],
                    body,
                    digest(body),
                    pack(vec) if vec else None,
                    stored_model,
                    len(vec) if vec else None,
                    now,
                ),
            )
            if fts:
                conn.execute("DELETE FROM notes_fts WHERE note_id = ?", (row["id"],))
                conn.execute(
                    "INSERT INTO notes_fts(note_id, title, body) VALUES(?,?,?)",
                    (row["id"], row["title"], body),
                )
        conn.commit()
        if dims:
            set_meta(conn, "model", model())
            set_meta(conn, "dims", str(dims))

    set_meta(conn, "indexed_at", stamp())
    conn.commit()
    result["seconds_total"] = time.monotonic() - started
    return result


def stamp() -> str:
    """A local wall-clock stamp, naive on purpose.

    Everything in this package is compared against the local ISO-8601 strings
    AppleScript builds from Notes' own date components, so an aware timestamp
    with a UTC offset would never sort or compare alongside them.
    """
    return dt.datetime.now().isoformat(timespec="seconds")  # noqa: DTZ005


def digest(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def truncate(text: str, max_chars: int) -> str:
    """Cap the text handed to the embedder; the full text stays in the index."""
    if max_chars <= 0 or len(text) <= max_chars:
        return text
    return text[:max_chars]


def diff_vs_notes(conn: sqlite3.Connection) -> dict[str, t.Any]:
    """Compare the index against the live library (one metadata call)."""
    metadata = [
        row for row in applescript.note_metadata() if not is_excluded(row["folder"])
    ]
    live = {row["id"]: row["modified"] for row in metadata}
    stored = dict(conn.execute("SELECT id, modified FROM notes"))
    return {
        "notes": len(live),
        "indexed": len(stored),
        "missing": sum(1 for nid in live if nid not in stored),
        "stale": sum(1 for nid, mod in live.items() if stored.get(nid, mod) != mod),
        "extra": sum(1 for nid in stored if nid not in live),
    }


# ---------------------------------------------------------------------------
# Queries
# ---------------------------------------------------------------------------


def folder_matches(stored: str, wanted: str) -> bool:
    """Match a folder filter against a stored path, by path, leaf, or suffix."""
    if not wanted:
        return True
    a, b = stored.casefold(), wanted.casefold()
    return a == b or a.endswith("/" + b) or a.split("/")[-1] == b


def _where(folder: str | None) -> tuple[str, list[str]]:
    if folder:
        return " AND (lower(folder) = ? OR lower(folder) LIKE ?)", [
            folder.casefold(),
            "%" + "/" + folder.casefold(),
        ]
    return "", []


def search_lexical(
    conn: sqlite3.Connection,
    terms: t.Sequence[str],
    *,
    match: str = "any",
    limit: int = 20,
    folder: str | None = None,
) -> list[dict[str, t.Any]]:
    """Keyword search over the index. FTS5 when available, LIKE when not."""
    terms = [term for term in terms if term]
    if not terms:
        raise IndexError_("search needs at least one keyword")
    joiner = " AND " if match == "all" else " OR "
    clause = joiner.join('"' + term.replace('"', '""') + '"' for term in terms)
    sql = (
        "SELECT n.id, n.title, n.folder, n.account, n.modified, n.body, "
        "       snippet(notes_fts, 2, '', '', ' […] ', 12) AS snippet, "
        "       bm25(notes_fts) AS score "
        "FROM notes_fts JOIN notes n ON n.id = notes_fts.note_id "
        "WHERE notes_fts MATCH ?"
    )
    params: list[t.Any] = [clause]
    if folder:
        extra, extra_params = _where(folder)
        sql += extra.replace("folder", "n.folder")
        params += extra_params
    sql += " ORDER BY score LIMIT ?"
    params.append(max(limit, 1) * 4)
    conn.row_factory = sqlite3.Row
    try:
        hits = list(conn.execute(sql, params))
    except sqlite3.OperationalError:
        hits = _search_like(conn, terms, match=match, limit=limit, folder=folder)
        return hits
    finally:
        conn.row_factory = None
    out = [dict(hit) for hit in hits[:limit]]
    for hit in out:
        hit["snippet"] = (
            hit.get("snippet") or _preview(hit.get("body") or "", terms)
        ).strip()
        hit.pop("body", None)
    return out


def _search_like(
    conn: sqlite3.Connection,
    terms: t.Sequence[str],
    *,
    match: str,
    limit: int,
    folder: str | None,
) -> list[dict[str, t.Any]]:
    joiner = " AND " if match == "all" else " OR "
    conds = []
    params: list[t.Any] = []
    for term in terms:
        conds.append("(lower(title) LIKE ? OR lower(body) LIKE ?)")
        params += ["%" + term.casefold() + "%", "%" + term.casefold() + "%"]
    sql = (
        "SELECT id, title, folder, account, modified, body FROM notes WHERE "
        + joiner.join(conds)
    )
    if folder:
        extra, extra_params = _where(folder)
        sql += extra
        params += extra_params
    sql += " ORDER BY modified DESC LIMIT ?"
    params.append(limit)
    conn.row_factory = sqlite3.Row
    try:
        out = [dict(row) for row in conn.execute(sql, params)]
    finally:
        conn.row_factory = None
    for hit in out:
        hit["snippet"] = _preview(hit.get("body") or "", terms)
        hit.pop("body", None)
    return out


def _preview(text: str, terms: t.Sequence[str], width: int = 160) -> str:
    """A short window around the first term occurrence, else the opening."""
    folded = text.casefold()
    pos = -1
    for term in terms:
        pos = folded.find(term.casefold())
        if pos >= 0:
            break
    if pos < 0:
        return " ".join(text[:width].split())
    start = max(0, pos - width // 2)
    snippet = text[start : start + width]
    return ("…" if start > 0 else "") + " ".join(snippet.split())


def find_similar(
    conn: sqlite3.Connection,
    query: str,
    *,
    limit: int = 10,
    min_score: float | None = None,
    folder: str | None = None,
    max_chars: int = DEFAULT_MAX_CHARS,
) -> list[dict[str, t.Any]]:
    """Rank indexed notes by cosine similarity to an embedded query."""
    rows_ = conn.execute(
        "SELECT id, title, folder, account, modified, body, embedding, dims FROM notes "
        "WHERE embedding IS NOT NULL"
    ).fetchall()
    if not rows_:
        raise IndexError_("no vectors in the index -- run: notes index")
    if len({row[7] for row in rows_}) > 1:
        raise IndexError_(
            "the index holds vectors of mixed dimensions -- run: notes index --full"
        )
    query_vec = embed([truncate(query, max_chars)])[0]
    scored = []
    for row in rows_:
        if not folder_matches(row[2], folder or ""):
            continue
        score = cosine(query_vec, unpack(row[6]))
        if min_score is not None and score < min_score:
            continue
        scored.append((score, row))
    scored.sort(key=lambda pair: pair[0], reverse=True)
    out = []
    for score, row in scored[:limit]:
        out.append(
            {
                "id": row[0],
                "title": row[1],
                "folder": row[2],
                "account": row[3],
                "modified": row[4],
                "score": round(score, 4),
                "snippet": _preview(row[5] or "", query.split()),
            }
        )
    return out


def score_profile(
    conn: sqlite3.Connection, *, limit: int = 3
) -> dict[str, t.Any] | None:
    """Cosine spread of the library against itself on a few probes.

    Honest honesty check for ``--min-score``: each probe is scored against every
    *other* note, because a note matches itself at exactly 1.0 and that number
    would say nothing. With a code embedder on prose this model squashes the
    results into a narrow band, and a threshold near 0.8 matches nothing.
    """
    probes = conn.execute(
        "SELECT rowid, body FROM notes WHERE embedding IS NOT NULL AND length(body) > 80 LIMIT ?",
        (limit,),
    ).fetchall()
    if len(probes) < 2:
        return None
    corpus = [
        (row[0], unpack(row[1]))
        for row in conn.execute(
            "SELECT rowid, embedding FROM notes WHERE embedding IS NOT NULL"
        )
    ]
    scores: list[float] = []
    for own_id, body in probes:
        try:
            vec = embed([truncate(body, DEFAULT_MAX_CHARS)], timeout=30.0)[0]
        except (urllib.error.URLError, OSError, ValueError, KeyError, IndexError):
            return None
        scores.append(
            max(
                (cosine(vec, other) for rid, other in corpus if rid != own_id),
                default=0.0,
            )
        )
    return {
        "probes": len(scores),
        "min": round(min(scores), 3),
        "median": round(statistics.median(scores), 3),
        "max": round(max(scores), 3),
    }
