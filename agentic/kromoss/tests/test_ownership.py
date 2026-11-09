"""Regression coverage for unreaped group-leader ownership."""

import asyncio
import os
import signal
import subprocess
import sys
from pathlib import Path

import pytest

from kromoss import runtime
from kromoss.runtime import ImageRuntime, WorkerFailedError

FAKE = Path(__file__).parent / "fixtures" / "fake_worker.py"


async def test_exit_is_observed_without_reaping_before_signals(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Every cleanup signal is sent while the original leader still reserves its ID."""
    owner = ImageRuntime(command=(sys.executable, str(FAKE)), temp_root=tmp_path)
    original = runtime._signal_group
    signals: list[signal.Signals] = []

    def checked_signal(*, pid: int, sig: signal.Signals) -> None:
        """Assert the identifier is still owned before forwarding a signal.

        Args:
            pid:
                Worker group identifier.
            sig:
                Signal requested by cleanup.
        """
        assert owner._child is not None
        assert owner._child.returncode is None
        assert runtime.psutil.Process(pid).ppid() == os.getpid()
        signals.append(sig)
        original(pid=pid, sig=sig)

    monkeypatch.setattr(runtime, "_signal_group", checked_signal)
    await owner.generate(
        payload={"prompt": "success", "size": "512x512"}, disconnected=_connected
    )
    assert signals == [signal.SIGTERM, signal.SIGKILL]
    assert owner._child is None


def test_reaped_leader_is_never_signalled(monkeypatch: pytest.MonkeyPatch) -> None:
    """An already-reaped identifier must never be used for group signalling."""
    child = subprocess.Popen([sys.executable, "-c", "pass"], start_new_session=True)
    child.wait(timeout=5)
    signals: list[int] = []

    def record_signal(*, pid: int, sig: signal.Signals) -> None:
        """Record any attempt to signal a stale identifier.

        Args:
            pid:
                Stale group identifier.
            sig:
                Requested signal.
        """
        signals.append(pid)

    monkeypatch.setattr(runtime, "_signal_group", record_signal)
    with pytest.raises(WorkerFailedError, match="already reaped"):
        runtime._stop_group(child=child, timeout=0.1)
    assert signals == []


async def test_spawn_cancellation_never_loses_child(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Cancellation requested during synchronous spawn is handled after ownership."""
    original = subprocess.Popen
    spawned: list[int] = []

    def cancelling_spawn(
        command: list[str], *, stdin: int, start_new_session: bool
    ) -> subprocess.Popen[bytes]:
        """Cancel the request exactly while the child is being published.

        Args:
            command:
                Worker command.
            stdin:
                Worker standard input.
            start_new_session:
                Process group isolation flag.

        Returns:
            Owned process awaiting cleanup.
        """
        child = original(command, stdin=stdin, start_new_session=start_new_session)
        spawned.append(child.pid)
        task = asyncio.current_task()
        assert task is not None
        task.cancel()
        return child

    monkeypatch.setattr(subprocess, "Popen", cancelling_spawn)
    owner = ImageRuntime(command=(sys.executable, str(FAKE)), temp_root=tmp_path)
    task = asyncio.create_task(
        owner.generate(
            payload={"prompt": "hold", "size": "512x512"}, disconnected=_connected
        )
    )
    with pytest.raises(asyncio.CancelledError):
        await task
    assert len(spawned) == 1
    with pytest.raises(ProcessLookupError):
        os.kill(spawned[0], 0)
    assert not list(tmp_path.iterdir())


async def _connected() -> bool:
    """Keep the simulated caller connected.

    Returns:
        False, indicating no disconnect.
    """
    return False
