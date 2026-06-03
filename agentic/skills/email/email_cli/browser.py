"""Thin ``agent-browser`` subprocess driver used by the OWA backend.

``agent-browser`` runs a persistent daemon: commands sharing a ``--session-name``
reuse the same browser, tabs, cookies, and page context across separate CLI
invocations. That lets us authenticate once (interactively) and then run
same-origin ``fetch()`` calls inside the logged-in ``outlook.office.com`` page via
``eval``.

This module only knows how to talk to the CLI; OWA specifics live in
``backends/owa.py``.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

from .backends.base import BackendError

_CLI = "agent-browser"


class BrowserSession:
    """Drives one named ``agent-browser`` session for an account."""

    def __init__(self, *, session_name: str, state_path: Path) -> None:
        self._session = session_name
        self._state = state_path

    def _run(
        self,
        *args: str,
        headed: bool = False,
        stdin: str | None = None,
        timeout: int = 60,
    ) -> str:
        """Invoke ``agent-browser`` and return stdout, raising on failure."""
        cmd = [_CLI]
        if headed:
            cmd.append("--headed")
        cmd += ["--session-name", self._session]
        cmd += list(args)
        try:
            proc = subprocess.run(
                cmd,
                input=stdin,
                capture_output=True,
                text=True,
                timeout=timeout,
            )
        except FileNotFoundError as exc:
            raise BackendError(
                "agent-browser is not installed or not on PATH. Install it (see the "
                "agent-browser skill) — the OWA backend needs it."
            ) from exc
        except subprocess.TimeoutExpired as exc:
            raise BackendError(
                f"agent-browser timed out after {timeout}s on `{args[0]}`."
            ) from exc
        if proc.returncode != 0:
            detail = (proc.stderr or proc.stdout or "").strip()
            raise BackendError(f"agent-browser `{args[0]}` failed: {detail}")
        return proc.stdout

    # -- navigation ----------------------------------------------------------

    def open(self, url: str, *, headed: bool = False) -> None:
        """Open ``url`` in the session (reusing the persistent browser)."""
        self._run("open", url, headed=headed, timeout=90)

    def wait_load(self, state: str = "networkidle") -> None:
        """Wait for the current navigation to settle."""
        # Best-effort: never fail an operation just because the wait timed out.
        try:
            self._run("wait", "--load", state, timeout=60)
        except BackendError:
            pass

    # -- scripting -----------------------------------------------------------

    def eval_json(self, js: str, *, timeout: int = 90):
        """Evaluate ``js`` in the page and JSON-parse its result.

        The script's last expression should resolve to an object/array; ``agent-browser
        eval`` outputs JSON, which we parse here. If the JS explicitly returns
        ``JSON.stringify(...)``, the output will be double-encoded, so we parse twice
        when the first parse yields a string.
        """
        out = self._run("eval", "--stdin", stdin=js, timeout=timeout).strip()
        if not out:
            return None
        try:
            result = json.loads(out)
            # If JS returned JSON.stringify(...), agent-browser wraps it in quotes,
            # so the first parse gives us a string that needs a second parse.
            if isinstance(result, str):
                result = json.loads(result)
            return result
        except json.JSONDecodeError as exc:
            raise BackendError(
                "Could not parse agent-browser eval output as JSON "
                f"({exc}). First 500 chars:\n{out[:500]}"
            ) from exc

    # -- persistence ---------------------------------------------------------

    def state_save(self) -> None:
        """Persist cookies/storage to the account's state file (0600)."""
        self._state.parent.mkdir(mode=0o700, exist_ok=True)
        self._run("state", "save", str(self._state), timeout=30)
        try:
            self._state.chmod(0o600)
        except OSError:
            pass
