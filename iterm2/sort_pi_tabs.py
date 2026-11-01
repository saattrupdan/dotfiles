#!/usr/bin/env python3
"""Keep Pi-backed iTerm2 tabs in attention order within each window."""

import asyncio
import fcntl
import logging
import tempfile
import time
from pathlib import Path

import iterm2

MARKER = "user.pi_agent_sort_status"
POLL_INTERVAL = 2
RANK = {
    "need_input": 0,
    "error": 0,
    "finished": 1,
    "working": 2,
    "starting": 2,
    "idle": 3,
}
NON_PI_RANK = 4
LOGGER = logging.getLogger(__name__)


def main() -> None:
    """Run one sorter per user while iTerm2 is open."""
    logging.basicConfig(level=logging.INFO)
    lock_path = Path(tempfile.gettempdir()) / "pi-iterm-tab-sorter.lock"
    with lock_path.open("w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            LOGGER.info("Pi tab sorter is already running")
            return
        iterm2.run_forever(sort_tabs)


async def sort_tabs(connection: iterm2.Connection) -> None:
    """Refresh iTerm2's layout and sort each ungrouped window periodically.

    Args:
        connection:
            Live iTerm2 Python API connection.
    """
    while True:
        try:
            app = await iterm2.async_get_app(connection)
            if app is not None:
                for window in app.windows:
                    await sort_window(window=window, now=int(time.time()))
        except (iterm2.RPCException, OSError):
            LOGGER.exception("Could not refresh iTerm2 tab order")
        await asyncio.sleep(POLL_INTERVAL)


async def sort_window(window: iterm2.Window, now: int) -> bool:
    """Sort a window by Pi status, preserving ties and the selected tab.

    Args:
        window:
            Window whose existing tabs may be reordered.
        now:
            Current Unix time used to expire stale Pi markers.

    Returns:
        Whether the window's tab order changed.
    """
    if len(window.tabs) < 2 or window.tab_groups:
        return False

    tabs = list(window.tabs)
    ranks = []
    for tab in tabs:
        session_ranks = [
            _marker_rank(await session.async_get_variable(MARKER), now=now)
            for session in tab.sessions
        ]
        ranks.append(min(session_ranks, default=NON_PI_RANK))

    ordered = [
        tab
        for _, tab in sorted(zip(ranks, tabs, strict=True), key=lambda pair: pair[0])
    ]
    if [tab.tab_id for tab in ordered] == [tab.tab_id for tab in tabs]:
        return False

    await window.async_set_tabs(ordered)
    return True


def _marker_rank(value: object, now: int) -> int:
    """Return a Pi marker's priority or the non-Pi priority when it has expired.

    Args:
        value:
            Value read from an iTerm2 session variable.
        now:
            Current Unix time.

    Returns:
        Priority for this session.
    """
    if not isinstance(value, str):
        return NON_PI_RANK
    status, separator, expiry = value.rpartition(":")
    if not separator or not expiry.isdecimal() or int(expiry) < now:
        return NON_PI_RANK
    return RANK.get(status, NON_PI_RANK)


if __name__ == "__main__":
    main()
