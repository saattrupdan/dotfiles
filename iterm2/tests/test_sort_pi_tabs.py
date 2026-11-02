"""Exercise Pi tab ordering without moving live iTerm2 tabs."""

import asyncio
import fcntl
import typing as t
from dataclasses import dataclass, field
from pathlib import Path

import iterm2
import pytest

import sort_pi_tabs
from sort_pi_tabs import MARKER, sort_window

NOW = 1_900_000_000


@dataclass
class FakeSession:
    """Session with one user variable and an observable read."""

    marker: object = ""
    reads: int = 0
    fails: bool = False

    async def async_get_variable(self, name: str) -> object:
        """Read the Pi marker.

        Args:
            name:
                Variable name.

        Returns:
            Stored marker.
        """
        assert name == MARKER
        self.reads += 1
        if self.fails:
            raise OSError("iTerm2 session is unavailable")
        return self.marker


@dataclass
class FakeTab:
    """Tab with one or more iTerm2 sessions."""

    tab_id: str
    sessions: list[FakeSession]


@dataclass
class FakeWindow:
    """Window that records reorders without altering its selected tab."""

    tabs: list[FakeTab]
    tab_groups: list[str] = field(default_factory=list)
    current_tab: FakeTab | None = None
    reorders: int = 0

    async def async_set_tabs(self, tabs: list[FakeTab]) -> None:
        """Apply the new order.

        Args:
            tabs:
                Existing tabs in the desired order.
        """
        assert {tab.tab_id for tab in tabs} == {tab.tab_id for tab in self.tabs}
        self.tabs = tabs
        self.reorders += 1


def sort_fake(window: FakeWindow, now: int = NOW) -> bool:
    """Exercise the sorter's interface with a fake iTerm2 window.

    Args:
        window:
            Window recording reorders.
        now (optional):
            Current Unix time. Defaults to NOW.

    Returns:
        Whether the window was reordered.
    """
    return asyncio.run(sort_window(window=t.cast(iterm2.Window, window), now=now))


def test_status_order_and_stable_ties() -> None:
    """Sort by attention and keep existing order within each tier."""
    values = [
        ("idle-1", "idle"),
        ("non-pi", ""),
        ("working", "working"),
        ("finished-1", "finished"),
        ("question", "need_input"),
        ("idle-2", "idle"),
        ("finished-2", "finished"),
        ("error", "error"),
        ("starting", "starting"),
    ]
    tabs = [
        FakeTab(name, [FakeSession(f"{status}:{NOW + 20}" if status else "")])
        for name, status in values
    ]
    window = FakeWindow(tabs, current_tab=tabs[2])

    assert sort_fake(window=window)
    assert [tab.tab_id for tab in window.tabs] == [
        "question",
        "error",
        "finished-1",
        "finished-2",
        "working",
        "starting",
        "idle-1",
        "idle-2",
        "non-pi",
    ]
    assert window.current_tab is tabs[2]
    assert window.reorders == 1
    assert not sort_fake(window=window)
    assert window.reorders == 1


def test_multiple_sessions_and_expired_marker() -> None:
    """The highest-priority live Pi session determines a tab's tier."""
    split = FakeTab("split", [FakeSession(""), FakeSession(f"finished:{NOW + 20}")])
    expired = FakeTab("expired", [FakeSession(f"need_input:{NOW - 1}")])
    malformed = FakeTab("malformed", [FakeSession("working:broken")])
    window = FakeWindow([expired, malformed, split])

    assert sort_fake(window=window)
    assert [tab.tab_id for tab in window.tabs] == ["split", "expired", "malformed"]
    assert not sort_fake(window=window, now=NOW + 21)
    assert window.reorders == 1


def test_grouped_window_is_not_reordered() -> None:
    """Do not disturb the adjacency or collapse state of iTerm2 tab groups."""
    ordinary = FakeTab("ordinary", [FakeSession()])
    question = FakeTab("question", [FakeSession(f"need_input:{NOW + 20}")])
    window = FakeWindow([ordinary, question], tab_groups=["project"])

    assert not sort_fake(window=window)
    assert [tab.tab_id for tab in window.tabs] == ["ordinary", "question"]
    assert ordinary.sessions[0].reads == 0
    assert window.reorders == 0


def test_failed_session_read_does_not_move_tabs() -> None:
    """A stale session read must not reorder a window from partial data."""
    first = FakeTab("shell", [FakeSession(fails=True)])
    second = FakeTab("question", [FakeSession(f"need_input:{NOW + 20}")])
    window = FakeWindow([first, second])

    with pytest.raises(OSError, match="session is unavailable"):
        sort_fake(window=window)
    assert window.tabs == [first, second]
    assert window.reorders == 0


def test_windows_sort_independently() -> None:
    """Each window keeps its own tabs and selected tab."""
    first_shell = FakeTab("first shell", [FakeSession()])
    second_shell = FakeTab("second shell", [FakeSession()])
    idle = FakeTab("idle", [FakeSession(f"idle:{NOW + 20}")])
    question = FakeTab("question", [FakeSession(f"need_input:{NOW + 20}")])
    first = FakeWindow([first_shell, idle], current_tab=first_shell)
    second = FakeWindow([second_shell, question], current_tab=question)

    assert sort_fake(window=first)
    assert sort_fake(window=second)
    assert [tab.tab_id for tab in first.tabs] == ["idle", "first shell"]
    assert [tab.tab_id for tab in second.tabs] == ["question", "second shell"]
    assert first.current_tab is first_shell
    assert second.current_tab is question


def test_new_tab_and_manual_tie_order() -> None:
    """New non-Pi tabs stay last; manual order among equal statuses persists."""
    idle_a = FakeTab("idle-a", [FakeSession(f"idle:{NOW + 20}")])
    idle_b = FakeTab("idle-b", [FakeSession(f"idle:{NOW + 20}")])
    window = FakeWindow([idle_b, idle_a])

    assert not sort_fake(window=window)
    window.tabs.insert(0, FakeTab("new shell", [FakeSession()]))
    assert sort_fake(window=window)
    assert [tab.tab_id for tab in window.tabs] == ["idle-b", "idle-a", "new shell"]


def test_restart_starts_sorter_while_old_instance_holds_lock(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """A previous iTerm2 instance's lock must not block the new AutoLaunch."""
    old_lock_path = tmp_path / "pi-iterm-tab-sorter.lock"
    identity = [(7, 8)]
    reads: list[object] = []
    original_sleep = asyncio.sleep

    async def no_app(connection: iterm2.Connection) -> None:
        """Record an API read from the new instance."""
        reads.append(connection)

    async def restart(seconds: float) -> None:
        """Replace the new instance's socket after it begins sorting."""
        del seconds
        identity[0] = (7, 9)
        await original_sleep(0)

    monkeypatch.setattr(sort_pi_tabs.tempfile, "gettempdir", lambda: str(tmp_path))
    monkeypatch.setattr(sort_pi_tabs, "_api_socket_identity", lambda: identity[0])
    monkeypatch.setattr(iterm2, "async_get_app", no_app)
    monkeypatch.setattr(asyncio, "sleep", restart)

    with old_lock_path.open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        asyncio.run(
            asyncio.wait_for(
                sort_pi_tabs.sort_tabs(
                    connection=t.cast("iterm2.Connection", object())
                ),
                timeout=0.3,
            )
        )

    assert len(reads) == 1


def test_second_sorter_for_same_iterm2_instance_stays_inactive(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Two launch requests must not race to reorder the same iTerm2 window."""
    lock_path = tmp_path / "pi-iterm-tab-sorter-7-8.lock"
    monkeypatch.setattr(sort_pi_tabs.tempfile, "gettempdir", lambda: str(tmp_path))
    monkeypatch.setattr(sort_pi_tabs, "_api_socket_identity", lambda: (7, 8))

    async def unexpected_read(connection: iterm2.Connection) -> None:
        """Fail if a duplicate sorter tries to use its API connection."""
        del connection
        pytest.fail("duplicate sorter attempted to sort tabs")

    monkeypatch.setattr(iterm2, "async_get_app", unexpected_read)
    with lock_path.open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        asyncio.run(
            asyncio.wait_for(
                sort_pi_tabs.sort_tabs(
                    connection=t.cast("iterm2.Connection", object())
                ),
                timeout=0.3,
            )
        )


def test_old_sorter_exits_after_iterm2_restarts(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """An old API connection must release its lock after the socket changes."""
    identity = [(7, 8)]
    original_sleep = asyncio.sleep

    async def no_app(connection: iterm2.Connection) -> None:
        """Return no windows while exercising the sorter's polling loop."""
        del connection

    async def restart(seconds: float) -> None:
        """Replace iTerm2's socket on the next poll."""
        del seconds
        identity[0] = (7, 9)
        await original_sleep(0)

    monkeypatch.setattr(sort_pi_tabs.tempfile, "gettempdir", lambda: str(tmp_path))
    monkeypatch.setattr(sort_pi_tabs, "_api_socket_identity", lambda: identity[0])
    monkeypatch.setattr(iterm2, "async_get_app", no_app)
    monkeypatch.setattr(asyncio, "sleep", restart)

    asyncio.run(
        asyncio.wait_for(
            sort_pi_tabs.sort_tabs(connection=t.cast("iterm2.Connection", object())),
            timeout=0.3,
        )
    )
