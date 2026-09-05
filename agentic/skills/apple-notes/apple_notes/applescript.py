"""The AppleScript bridge: everything in this package talks to Notes through here.

Design constraints, all measured on macOS 26.6.2 against a 439-note library:

* **One ``osascript`` process per logical operation, never one per note.** Each
  ``osascript`` launch is a fresh IPC session costing roughly 200 ms; a
  per-note loop over a few hundred notes would take minutes. Inside one
  process, a property fetch is a single Apple event (~1-5 ms), so we fetch
  *lists* -- ``get name of notes of f`` -- instead of looping over notes.
* **Arguments are passed through ``argv``**, never interpolated into the script
  text. Titles and bodies written by an agent therefore cannot break out of a
  string literal or inject AppleScript.
* **Bulk text travels through a temp file**, read back with ``read … as «class
  utf8»``, because note bodies can exceed ``ARG_MAX``.
* **Output is field/record separated** with ``character id 31`` / ``character
  id 30`` and joined with ``text item delimiters``. Bodies contain newlines and
  tabs, so those are unusable as separators, and ``set out to out & x`` in a
  loop is quadratic.
* **Dates are assembled from ``year``/``month``/… integers.** ``date string``
  and ``time string`` are locale-dependent, and a date that fails to parse
  would silently drop notes from the index.
* **Folders are enumerated flat.** ``folders of <account>`` returns every
  folder in the account including nested ones, while ``folders of <folder>``
  returns genuine children — walking both would visit each note twice (the
  same folder id appears in both). The flat list visits every note exactly
  once, which is verified against ``count notes`` by ``notes doctor``.
"""

from __future__ import annotations

import os
import re
import subprocess
import tempfile
import time
import typing as t

OSASCRIPT = "/usr/bin/osascript"

# Field and record separators. Note text legitimately contains newlines and
# tabs, so only control characters that cannot appear in prose are usable.
US = "\x1f"  # unit separator -- between fields
RS = "\x1e"  # record separator -- between records

DEFAULT_TIMEOUT = 120
BODY_TIMEOUT = 600

# Apple events worth retrying: the app was launching, busy, or the event timed
# out. All transient on a Mac where Notes.app is starting or still syncing.
#
# These are only ever *safe* for read-only scripts. Every mutation script below
# keeps firing Apple events *after* the write (``id of n``, ``name of n``, the
# ``notePath`` container walk), so a write that fails part-way is
# indistinguishable from a transient failure, and a retry re-runs the mutation
# itself — and a second ``delete`` on a note already in Recently Deleted
# erases it for good. Mutations therefore pass ``retries=0``; see :func:`run`.
_RETRY_CODES = {-600, -609, -1712, -1713, -108, 12}

_ERROR_RE = re.compile(
    r"^(?:[^:\n]+:\d+:\d+: )?(?:execution|syntax) error: (?P<msg>.*?)\s*\((?P<code>-?\d+)\)\s*$",
    re.MULTILINE,
)


class AppleScriptError(RuntimeError):
    """An ``osascript`` failure, carrying the message Notes actually said."""

    def __init__(self, message: str, code: int | None = None) -> None:
        self.code = code
        super().__init__(
            message if code is None else f"{message} (AppleScript error {code})"
        )


# ---------------------------------------------------------------------------
# AppleScript building blocks
# ---------------------------------------------------------------------------

_HELPERS = """
on pad2(n)
  set t to (n as text)
  if (length of t) < 2 then set t to "0" & t
  return t
end pad2

on isoDate(d)
  return ((year of d) as text) & "-" & my pad2((month of d) as integer) & "-" & my pad2(day of d) & "T" & my pad2(hours of d) & ":" & my pad2(minutes of d) & ":" & my pad2(seconds of d)
end isoDate

on joinRecords(out)
  set AppleScript's text item delimiters to (character id 30)
  set s to out as text
  set AppleScript's text item delimiters to ""
  return s
end joinRecords

-- Folder ids, names and parent ids for one account, in three bulk fetches
-- plus one event per folder for the container.
on folderTable(acctName)
  tell application "Notes"
    set theAccount to account acctName
    set fIds to (get id of folders of theAccount)
    set fNames to (get name of folders of theAccount)
    set parentIds to {}
    repeat with i from 1 to (count of fIds)
      set cid to ""
      try
        set c to container of (folder id (item i of fIds))
        if (class of c) is folder then set cid to (id of c) as text
      end try
      set end of parentIds to cid
    end repeat
  end tell
  return {fIds, fNames, parentIds}
end folderTable

on folderPath(theId, fIds, fNames, parentIds)
  set idx to 0
  repeat with k from 1 to (count of fIds)
    if (item k of fIds) is theId then
      set idx to k
      exit repeat
    end if
  end repeat
  if idx is 0 then return ""
  set p to (item idx of fNames as text)
  set pid to item idx of parentIds
  set guard to 0
  repeat while pid is not "" and guard < 12
    set guard to guard + 1
    set found to 0
    repeat with k from 1 to (count of fIds)
      if (item k of fIds) is pid then
        set found to k
        exit repeat
      end if
    end repeat
    if found is 0 then exit repeat
    set p to ((item found of fNames as text) & "/" & p)
    set pid to item found of parentIds
  end repeat
  return p
end folderPath

-- Path and account of a single note, walking up its containers. One event per
-- level, so this is only used where one note is touched.
on notePath(n)
  tell application "Notes"
    set c to container of n
    set p to (name of c) as text
    set acctName to ""
    set guard to 0
    repeat while guard < 12
      set guard to guard + 1
      try
        set parentC to container of c
        if (class of parentC) is folder then
          set p to ((name of parentC) as text) & "/" & p
          set c to parentC
        else if (class of parentC) is account then
          set acctName to (name of parentC) as text
          exit repeat
        else
          exit repeat
        end if
      on error
        exit repeat
      end try
    end repeat
  end tell
  return {p, acctName}
end notePath

-- "Notes" or "Research/TrustLLM" -> a folder specifier.
on resolveFolder(acctName, folderName)
  tell application "Notes"
    if folderName does not contain "/" then return folder folderName of account acctName
    set theTarget to account acctName
    repeat with part in (text items of folderName)
      set theTarget to folder (part as text) of theTarget
    end repeat
    return theTarget
  end tell
end resolveFolder

on replaceText(subject, findStr, replaceStr)
  set AppleScript's text item delimiters to findStr
  set parts to text items of subject
  set AppleScript's text item delimiters to replaceStr
  set out to parts as text
  set AppleScript's text item delimiters to ""
  return out
end replaceText

on readBodyFile(thePath)
  return (read (POSIX file thePath) as \u00abclass utf8\u00bb)
end readBodyFile
"""


def _script(body: str) -> str:
    return _HELPERS + body


_META_SCRIPT = _script(
    """
on run argv
  set wantBodies to ((count of argv) > 0 and (item 1 of argv) is "bodies")
  set sep to (character id 31)
  set out to {}
  repeat with acct in (my accountNames())
    set {fIds, fNames, parentIds} to my folderTable(acct)
    tell application "Notes"
      repeat with i from 1 to (count of fIds)
        set fPath to my folderPath(item i of fIds, fIds, fNames, parentIds)
        try
          -- The plural reference has to appear inline in each `get`. Binding
          -- `set noteList to notes of …` first materialises a list of object
          -- specifiers, and `get id of noteList` on that list fails with -1728.
          set noteIds to (get id of notes of (folder id (item i of fIds)))
          set nn to count of noteIds
          if nn > 0 then
            set nNames to (get name of notes of (folder id (item i of fIds)))
            set nMod to (get modification date of notes of (folder id (item i of fIds)))
            if wantBodies then
              set nText to (get plaintext of notes of (folder id (item i of fIds)))
            else
              set nText to {}
            end if
            repeat with j from 1 to nn
              set rec to acct & sep & fPath & sep & (item j of noteIds as text) & sep & (item j of nNames as text) & sep & my isoDate(item j of nMod)
              if wantBodies then set rec to rec & sep & (item j of nText as text)
              set end of out to rec & (character id 30)
            end repeat
          end if
        on error errMsg number errNum
          set end of out to "ERROR" & sep & "folder " & fPath & ": " & errMsg & " (" & errNum & ")" & (character id 30)
        end try
      end repeat
    end tell
  end repeat
  return my joinRecords(out)
end run

on accountNames()
  tell application "Notes" to return (get name of accounts)
end accountNames
"""
)

_FOLDER_SCRIPT = _script(
    """
on run argv
  set sep to (character id 31)
  set out to {}
  repeat with acct in (my accountNames())
    set {fIds, fNames, parentIds} to my folderTable(acct)
    tell application "Notes"
      repeat with i from 1 to (count of fIds)
        set fPath to my folderPath(item i of fIds, fIds, fNames, parentIds)
        set end of out to acct & sep & fPath & sep & (item i of fIds as text) & sep & (count of (notes of (folder id (item i of fIds)))) & (character id 30)
      end repeat
    end tell
  end repeat
  return my joinRecords(out)
end run

on accountNames()
  tell application "Notes" to return (get name of accounts)
end accountNames
"""
)

_ACCOUNT_SCRIPT = _script(
    """
on run argv
  set sep to (character id 31)
  set out to {}
  tell application "Notes"
    repeat with a in accounts
      set end of out to ((name of a) as text) & sep & (count of (notes of a)) & sep & (count of (folders of a)) & (character id 30)
    end repeat
  end tell
  return my joinRecords(out)
end run
"""
)

# Bodies for a specific set of ids: one event per note, but inside a single
# process, which is what the "never one osascript per note" rule is about.
_BODY_SCRIPT = _script(
    """
on run argv
  set sep to (character id 31)
  set out to {}
  tell application "Notes"
    repeat with i from 1 to (count of argv)
      set theID to item i of argv
      try
        set n to note id theID
        set p to plaintext of n
        set end of out to theID & sep & p & (character id 30)
      on error errMsg number errNum
        set end of out to "ERROR" & sep & theID & sep & "reading " & theID & ": " & errMsg & " (" & errNum & ")" & (character id 30)
      end try
    end repeat
  end tell
  return my joinRecords(out)
end run
"""
)

_GET_SCRIPT = _script(
    """
on run argv
  set sep to (character id 31)
  set wantHTML to ((count of argv) > 1 and (item 2 of argv) is "html")
  tell application "Notes"
    set n to note id (item 1 of argv)
    set nId to (id of n) as text
    set nTitle to (name of n) as text
    set nMod to my isoDate(modification date of n)
    set nCreated to my isoDate(creation date of n)
    set nShared to (shared of n) as text
    set nAttachments to (count of (attachments of n))
    set nText to (plaintext of n)
    set {fPath, acctName} to my notePath(n)
    set rec to nId & sep & nTitle & sep & fPath & sep & acctName & sep & nMod & sep & nCreated & sep & nShared & sep & nAttachments & sep & nText
    if wantHTML then
      set nBody to (body of n)
      set rec to rec & sep & nBody
    end if
    return rec & (character id 30)
  end tell
end run
"""
)

# `every note whose name is X` returns *all* matches, which is the only way to
# notice that a title is ambiguous. `first note whose name is X` -- the usual
# one-liner -- quietly picks one of them, which is why ids are preferred.
_TITLE_SCRIPT = _script(
    """
on run argv
  set sep to (character id 31)
  set out to {}
  tell application "Notes"
    set found to (every note whose name is (item 1 of argv))
    repeat with n in found
      set {fPath, acctName} to my notePath(n)
      set end of out to ((id of n) as text) & sep & fPath & sep & acctName & (character id 30)
    end repeat
  end tell
  return my joinRecords(out)
end run
"""
)

_CREATE_SCRIPT = _script(
    """
on run argv
  set sep to (character id 31)
  set acctName to item 1 of argv
  set theTitle to item 2 of argv
  set bodyHTML to my readBodyFile(item 3 of argv)
  tell application "Notes"
    set theFolder to my resolveFolder(acctName, item 4 of argv)
    set n to make new note at theFolder with properties {body:bodyHTML}
    -- Notes derives `name` from the first line of `body` (verified: a note
    -- created with only a body lands with the title "Body Derived Title
    -- Line"), so the title is set *after* the body and read back.
    set name of n to theTitle
    set {fPath, gotAcct} to my notePath(n)
    return ((id of n) as text) & sep & (name of n) & sep & fPath & sep & gotAcct & sep & (my isoDate(modification date of n)) & (character id 30)
  end tell
end run
"""
)

_UPDATE_SCRIPT = _script(
    """
on run argv
  set sep to (character id 31)
  set theID to item 1 of argv
  set mode to item 2 of argv
  set bodyHTML to ""
  if mode is not "none" then set bodyHTML to my readBodyFile(item 3 of argv)
  tell application "Notes"
    set n to note id theID
    set beforeCount to (count of (attachments of n))
    -- Writing `body` makes Notes re-derive the title from the body's first
    -- line, so the old title is captured here and put back below unless a new
    -- one was supplied.
    set oldTitle to (name of n) as text
    if mode is "append" then
      set body of n to ((body of n) & bodyHTML)
    else if mode is "prepend" then
      set body of n to (bodyHTML & (body of n))
    else if mode is "replace" then
      set body of n to bodyHTML
    end if
    if (count of argv) > 3 then
      set name of n to (item 4 of argv)
    else if mode is not "none" then
      set name of n to oldTitle
    end if
    set afterCount to (count of (attachments of n))
    set newTitle to (name of n) as text
    set newMod to my isoDate(modification date of n)
    set newText to (plaintext of n)
    set {fPath, acctName} to my notePath(n)
    return newTitle & sep & fPath & sep & acctName & sep & newMod & sep & beforeCount & sep & afterCount & sep & oldTitle & sep & newText & (character id 30)
  end tell
end run
"""
)

_DELETE_SCRIPT = _script(
    """
on run argv
  set sep to (character id 31)
  tell application "Notes"
    set n to note id (item 1 of argv)
    set {fPath, acctName} to my notePath(n)
    set nTitle to (name of n) as text
    delete n
    return nTitle & sep & fPath & sep & acctName & (character id 30)
  end tell
end run
"""
)

_MOVE_SCRIPT = _script(
    """
on run argv
  set sep to (character id 31)
  set theID to item 1 of argv
  tell application "Notes"
    set n to note id theID
    move n to (my resolveFolder(item 2 of argv, item 3 of argv))
    set {fPath, gotAcct} to my notePath(n)
    return fPath & sep & gotAcct & (character id 30)
  end tell
end run
"""
)


# ---------------------------------------------------------------------------
# Runner
# ---------------------------------------------------------------------------


def run(
    script: str,
    args: t.Sequence[str] = (),
    *,
    timeout: float = DEFAULT_TIMEOUT,
    retries: int = 2,
) -> str:
    """Run ``script`` with ``args`` through ``osascript`` and return stdout.

    ``args`` arrive as ``on run argv`` parameters, so nothing here is
    shell-quoted or AppleScript-quoted and no user text can escape its string.
    Transient Apple-event failures are retried with backoff; every other
    failure raises with the message Notes actually produced.

    ``retries=0`` is mandatory for anything that writes: the retry set covers
    timeouts, and a mutation script does further Apple-event work *after* the
    write, so a timeout can never be told apart from "the write never
    happened". Reads keep the default.
    """
    fd, path = tempfile.mkstemp(prefix="pi-notes-", suffix=".applescript")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(script)
        last: AppleScriptError | None = None
        for attempt in range(retries + 1):
            try:
                proc = subprocess.run(
                    [OSASCRIPT, path, *args],
                    capture_output=True,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    timeout=timeout,
                    check=False,
                )
            except subprocess.TimeoutExpired as exc:
                raise AppleScriptError(
                    f"osascript timed out after {timeout:g}s -- is Notes.app showing a modal dialog?"
                ) from exc
            if proc.returncode == 0:
                return proc.stdout
            err = _parse_error(proc.stderr, proc.returncode)
            transient = (
                err.code in _RETRY_CODES or _TRANSIENT_RE.search(str(err)) is not None
            )
            if transient and attempt < retries:
                last = err
                time.sleep(0.4 * (2**attempt))
                continue
            raise err
        raise last  # pragma: no cover -- every path returns or raises
    finally:
        try:
            os.unlink(path)
        except OSError:  # pragma: no cover
            pass


_TRANSIENT_RE = re.compile(r"isn.t running|not responding|busy", re.IGNORECASE)


def _parse_error(stderr: str, returncode: int) -> AppleScriptError:
    text = (stderr or "").strip()
    match = _ERROR_RE.search(text)
    if match:
        msg = match.group("msg")
        msg = msg.removeprefix("Notes got an error: ")
        return AppleScriptError(msg, code=int(match.group("code")))
    return AppleScriptError(text or f"osascript exited with {returncode}")


def _records(raw: str) -> list[list[str]]:
    """Split runner output into records.

    ``osascript`` appends a newline to whatever the script returns; because
    every record ends with ``RS``, that newline lands in the discarded final
    element and can never masquerade as a note field.
    """
    out = []
    for rec in raw.split(RS):
        rec = rec.removesuffix("\n")
        if rec:
            out.append(rec.split(US))
    return out


def _raise_if_error(records: list[list[str]], what: str) -> None:
    for fields in records:
        if fields and fields[0] == "ERROR":
            raise AppleScriptError(f"Notes failed while reading {what}: {fields[1]}")


# ---------------------------------------------------------------------------
# Queries
# ---------------------------------------------------------------------------


def note_metadata(
    *, bodies: bool = False, timeout: float = BODY_TIMEOUT
) -> list[dict[str, str]]:
    """Metadata (and optionally plaintext) for every note, in ONE call.

    Each row has ``account``, ``folder``, ``id``, ``title``, ``modified`` and,
    when ``bodies`` is set, ``body``.
    """
    args = ["bodies"] if bodies else []
    records = _records(run(_META_SCRIPT, args, timeout=timeout))
    _raise_if_error(records, "the note listing")
    rows: list[dict[str, str]] = []
    for fields in records:
        if len(fields) < 5:
            raise AppleScriptError(f"malformed metadata record: {len(fields)} field(s)")
        row = dict(
            zip(
                ("account", "folder", "id", "title", "modified"),
                fields[:5],
                strict=True,
            )
        )
        if bodies:
            row["body"] = fields[5] if len(fields) > 5 else ""
        rows.append(row)
    return rows


def folders() -> list[dict[str, t.Any]]:
    """Every folder, with its real nested path and note count."""
    records = _records(run(_FOLDER_SCRIPT))
    _raise_if_error(records, "the folder listing")
    return [
        {
            "account": f[0],
            "path": f[1],
            "id": f[2],
            "notes": int(f[3]) if len(f) > 3 and f[3].isdigit() else 0,
        }
        for f in records
        if len(f) >= 3
    ]


def accounts() -> list[dict[str, t.Any]]:
    """The accounts Notes can reach, with note and folder counts."""
    records = _records(run(_ACCOUNT_SCRIPT))
    _raise_if_error(records, "the account listing")
    return [
        {
            "name": f[0],
            "notes": int(f[1]) if f[1].isdigit() else 0,
            "folders": int(f[2]) if len(f) > 2 and f[2].isdigit() else 0,
        }
        for f in records
        if len(f) >= 2
    ]


def get_note(
    note_id: str, *, html: bool = False, timeout: float = BODY_TIMEOUT
) -> dict[str, t.Any]:
    """Read one note by its ``x-coredata://`` id."""
    try:
        records = _records(
            run(_GET_SCRIPT, [note_id, "html" if html else "text"], timeout=timeout)
        )
    except AppleScriptError as exc:
        raise _missing(exc, note_id) from exc
    _raise_if_error(records, f"note {note_id}")
    if not records:
        raise LookupError(note_id)
    f = records[0]
    if len(f) < 9:
        raise AppleScriptError(f"malformed note record: {len(f)} field(s)")
    out: dict[str, t.Any] = {
        "id": f[0],
        "title": f[1],
        "folder": f[2],
        "account": f[3],
        "modified": f[4],
        "created": f[5],
        "shared": f[6] == "true",
        "attachments": int(f[7]) if f[7].isdigit() else 0,
        "plaintext": f[8],
    }
    if html:
        out["body"] = f[9] if len(f) > 9 else ""
    return out


def bodies_by_id(
    ids: t.Sequence[str], *, chunk: int = 150, timeout: float = BODY_TIMEOUT
) -> dict[str, str]:
    """Fetch ``plaintext`` for the given ids, ``chunk`` ids per osascript call."""
    out: dict[str, str] = {}
    ids = list(ids)
    for start in range(0, len(ids), chunk):
        batch = ids[start : start + chunk]
        records = _records(run(_BODY_SCRIPT, batch, timeout=timeout))
        _raise_if_error(records, "a note body")
        for fields in records:
            if len(fields) >= 2:
                out[fields[0]] = fields[1]
    return out


def ids_by_title(title: str) -> list[dict[str, str]]:
    """Every note whose title is exactly ``title`` -- titles are not unique."""
    records = _records(run(_TITLE_SCRIPT, [title]))
    _raise_if_error(records, f"the title lookup for {title!r}")
    return [
        {"id": f[0], "folder": f[1], "account": f[2]} for f in records if len(f) >= 3
    ]


def create_note(
    *, title: str, body: str, folder: str, account: str | None = None
) -> dict[str, str]:
    """Create a note, then set its title explicitly and read it back."""
    path = _write_temp(_to_html(body))
    try:
        records = _records(
            run(
                _CREATE_SCRIPT,
                [account or default_account(), title, path, folder],
                retries=0,
            )
        )
    finally:
        os.unlink(path)
    _raise_if_error(records, f"creating {title!r}")
    if not records or len(records[0]) < 5:
        raise AppleScriptError("Notes reported success but returned no note")
    f = records[0]
    return {
        "id": f[0],
        "title": f[1],
        "folder": f[2],
        "account": f[3],
        "modified": f[4],
    }


def update_note(
    note_id: str,
    *,
    body: str | None = None,
    title: str | None = None,
    mode: str = "replace",
) -> dict[str, str]:
    """Replace, append to, or prepend a note's body, optionally renaming it.

    ``mode`` is ``replace`` | ``append`` | ``prepend`` | ``none`` (rename only).
    Append and prepend splice HTML into the existing body so rich formatting
    survives; replace throws it away.
    """
    args = [
        note_id,
        mode if body is not None else "none",
        _write_temp(_to_html(body) if body is not None else ""),
    ]
    if title is not None:
        args.append(title)
    path = args[2]
    try:
        records = _records(run(_UPDATE_SCRIPT, args, retries=0))
    finally:
        os.unlink(path)
    _raise_if_error(records, f"updating {note_id}")
    if not records or len(records[0]) < 8:
        raise AppleScriptError("Notes reported success but returned nothing")
    f = records[0]
    return {
        "title": f[0],
        "folder": f[1],
        "account": f[2],
        "modified": f[3],
        "attachments_before": int(f[4]) if f[4].isdigit() else 0,
        "attachments_after": int(f[5]) if f[5].isdigit() else 0,
        "title_before": f[6],
        "plaintext": f[7],
    }


def delete_note(note_id: str) -> dict[str, str]:
    """Move a note to Recently Deleted, returning where it was."""
    try:
        # retries=0: a second `delete` on a note that is already in Recently
        # Deleted erases it permanently, so a timeout must never re-run this.
        records = _records(run(_DELETE_SCRIPT, [note_id], retries=0))
    except AppleScriptError as exc:
        raise _missing(exc, note_id) from exc
    _raise_if_error(records, f"deleting {note_id}")
    if not records or len(records[0]) < 3:
        raise AppleScriptError("Notes reported success but returned nothing")
    return {"title": records[0][0], "folder": records[0][1], "account": records[0][2]}


def move_note(
    note_id: str, folder: str, *, account: str | None = None
) -> dict[str, str]:
    """Move a note to ``folder`` (a path like ``Research/TrustLLM``)."""
    try:
        records = _records(
            run(
                _MOVE_SCRIPT,
                [note_id, account or default_account(), folder],
                retries=0,
            )
        )
    except AppleScriptError as exc:
        raise _missing(exc, note_id) from exc
    _raise_if_error(records, f"moving {note_id}")
    if not records:
        raise AppleScriptError("Notes reported success but returned nothing")
    return {"folder": records[0][0], "account": records[0][1]}


def _missing(exc: AppleScriptError, note_id: str) -> Exception:
    """Turn Notes' "can't get note id" into a LookupError, keeping real errors.

    A note that is gone is not an AppleScript failure worth a traceback, but a
    different error code must still surface as-is.
    """
    if exc.code == -1728 and "note id" in str(exc):
        return LookupError(note_id)
    return exc


def default_account() -> str:
    """The first account -- on a single-iCloud Mac, ``iCloud``."""
    accts = accounts()
    if not accts:
        raise AppleScriptError("Notes reports no accounts")
    return accts[0]["name"]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def escape_html(text: str) -> str:
    """Escape the three characters that are meaningful in a Notes HTML body.

    Writing ``&amp;`` is accepted and stored as ``&``. Reading it back gives
    ``&amp`` -- Notes serialises entities *without* the trailing semicolon
    (measured). The asymmetry is stable under round trips, but it means the
    output of ``get --html`` is not valid HTML and must never be re-parsed.
    """
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _to_html(body: str) -> str:
    """Plain text -> one ``<div>`` block with ``<br>`` line breaks.

    Notes re-serialises whatever it is given, so the round trip is stable, and
    a block element keeps Notes from reading the first line as a title.
    """
    normalised = body.replace("\r\n", "\n").replace("\r", "\n")
    return "<div>" + escape_html(normalised).replace("\n", "<br>") + "</div>"


def _write_temp(text: str) -> str:
    fd, path = tempfile.mkstemp(prefix="pi-notes-body-", suffix=".html")
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        fh.write(text)
    return path
