"""Filesystem undo store: one text file per body-overwriting write.

``notes update`` throws away the text it replaced, so the pre-write plaintext
is written to disk *before* the write and the path is reported on the way out.
`append` is included because it also re-serialises the body.

It deliberately lives on the filesystem and **not** in the index database:
SKILL.md documents ``index.sqlite`` as a cache where "deleting it loses
nothing", and undo history is exactly the thing that must survive an ``rm`` of
a cache. One file per entry keeps it inspectable with plain ``ls``/``cat`` and
restorable with plain ``notes update --body-file``.
"""

from __future__ import annotations

import datetime as dt
import os
import typing as t
from pathlib import Path

# How many previous versions to keep. Each file is a note body, so 50 is a few
# megabytes at worst and still covers "what did that note say yesterday".
KEEP = 50

_SUFFIX = ".txt"


def undo_dir() -> Path:
    """Where undo files live (override with ``NOTES_UNDO_DIR``)."""
    override = os.environ.get("NOTES_UNDO_DIR")
    if override:
        return Path(override).expanduser()
    return Path.home() / "Library" / "Application Support" / "apple-notes" / "undo"


def _name(note_id: str) -> str:
    """``<stamp>-<id>.txt`` — filesystem-safe, and sortable by age.

    A note id is ``x-coredata://<uuid>/ICNote/pNNN``, and ``/`` and ``:`` do
    not belong in a filename, so everything unsafe collapses to ``_``. The
    stamp carries microseconds because two updates of one note can land in the
    same second.
    """
    safe = "".join(c if c.isalnum() or c in "-._" else "_" for c in note_id)
    now = dt.datetime.now()  # noqa: DTZ005 - local wall clock, like index.stamp()
    stamp = now.strftime("%Y-%m-%dT%H-%M-%S-") + f"{now.microsecond:06d}"
    return f"{stamp}-{safe}{_SUFFIX}"


def save(note_id: str, *, title: str, body: str, keep: int = KEEP) -> dict[str, t.Any]:
    """Write the pre-write state of ``note_id`` out and describe where it went.

    The file holds the previous plaintext verbatim — no header, no wrapping —
    so ``notes update <id> --body-file <path>`` puts it back exactly. The title
    is not in the file (it is reported alongside the path) because a note's
    title is derived from its body's first line.
    """
    target = undo_dir()
    try:
        target.mkdir(parents=True, exist_ok=True)
        path = target / _name(note_id)
        path.write_text(body, encoding="utf-8")
        kept = prune(keep)
    except OSError as exc:
        raise OSError(
            f"could not write the undo copy under {target} ({exc}); refusing to "
            "overwrite the body with no way back. Free up space or point "
            "NOTES_UNDO_DIR somewhere writable."
        ) from exc
    return {"path": str(path), "title": title, "chars": len(body), "kept": kept}


def prune(keep: int = KEEP) -> int:
    """Delete all but the newest ``keep`` files; return how many remain."""
    target = undo_dir()
    try:
        files = sorted(
            (p for p in target.glob(f"*{_SUFFIX}") if p.is_file()),
            key=lambda p: p.stat().st_mtime,
            reverse=True,
        )
    except OSError:  # pragma: no cover - unreadable directory
        return 0
    for old in files[keep:]:
        try:
            old.unlink()
        except OSError:  # pragma: no cover - another process won the race
            pass
    return min(len(files), keep)
