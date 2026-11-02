#!/usr/bin/env python3
"""Keep Pi-backed iTerm2 tabs in attention order within each window."""

import asyncio
import fcntl
import logging
import os
import tempfile
import time
from pathlib import Path

import iterm2

MARKER = "user.pi_agent_sort_status"
POLL_INTERVAL = 2
REQUEST_TIMEOUT = 30
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
    """Run one sorter per iTerm2 instance while its API connection is live."""
    logging.basicConfig(level=logging.INFO)
    iterm2.run_until_complete(sort_tabs)


async def sort_tabs(connection: iterm2.Connection) -> None:
    """Sort ungrouped windows until this iTerm2 API instance is replaced.

    Args:
        connection:
            Live iTerm2 Python API connection.
    """
    identity = _api_socket_identity()
    if identity is None:
        LOGGER.error("iTerm2 API socket is unavailable")
        return

    # An old sorter can survive iTerm2 quitting. Its lock must not block a new instance.
    lock_path = Path(tempfile.gettempdir()) / (
        f"pi-iterm-tab-sorter-{identity[0]}-{identity[1]}.lock"
    )
    with lock_path.open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            LOGGER.info("Pi tab sorter is already running for this iTerm2 instance")
            return

        while _api_socket_identity() == identity:
            try:
                async with asyncio.timeout(REQUEST_TIMEOUT):
                    app = await iterm2.async_get_app(connection)
                    if app is not None:
                        for window in app.windows:
                            await sort_window(window=window, now=int(time.time()))
            except TimeoutError:
                LOGGER.warning("Timed out refreshing iTerm2 tab order")
            except (iterm2.RPCException, OSError):
                LOGGER.exception("Could not refresh iTerm2 tab order")
            await asyncio.sleep(POLL_INTERVAL)
        LOGGER.info("iTerm2 API instance changed; stopping old tab sorter")


def _api_socket_identity() -> tuple[int, int] | None:
    """Identify the current iTerm2 API server by its Unix socket.

    Returns:
        Device and inode of the server socket, or None if it is unavailable.
    """
    socket_path = (
        Path.home()
        / "Library"
        / "Application Support"
        / os.environ.get("IT2_SUITE", "iTerm2")
        / "private"
        / "socket"
    )
    try:
        stat = socket_path.stat()
    except FileNotFoundError:
        return None
    return stat.st_dev, stat.st_ino


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
