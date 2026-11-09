"""Test the actual subprocess seam and cleanup invariants without a GPU."""

import asyncio
import os
import subprocess
import sys
import threading
from pathlib import Path

import pytest

from kromoss import runtime as runtime_module
from kromoss.runtime import (
    ClientDisconnectedError,
    ImageRuntime,
    Payload,
    RuntimeClosedError,
    WorkerBusyError,
    WorkerFailedError,
)

FAKE = Path(__file__).parent / "fixtures" / "fake_worker.py"


async def test_success_releases_worker_and_temporary_files(tmp_path: Path) -> None:
    """Success leaves no process or private request directory."""
    owner = _runtime(tmp_path=tmp_path)
    payload = _payload(tmp_path=tmp_path)
    image = await owner.generate(payload=payload, disconnected=_connected)
    assert image.startswith(b"\x89PNG")
    _assert_gone(pid=int((tmp_path / "worker.pid").read_text()))
    assert not list(tmp_path.glob("kromoss-*"))
    await owner.generate(payload=payload, disconnected=_connected)
    await owner.close()


@pytest.mark.parametrize("mode", ["exit", "missing", "malformed", "wrong_size"])
async def test_failed_output_is_reaped_and_slot_reusable(
    tmp_path: Path, mode: str
) -> None:
    """Invalid output cannot retain GPU processes or poison future requests."""
    owner = _runtime(tmp_path=tmp_path)
    with pytest.raises(WorkerFailedError):
        await owner.generate(
            payload=_payload(tmp_path=tmp_path, mode=mode), disconnected=_connected
        )
    _assert_gone(pid=int((tmp_path / "worker.pid").read_text()))
    assert not list(tmp_path.glob("kromoss-*"))
    await owner.generate(payload=_payload(tmp_path=tmp_path), disconnected=_connected)


async def test_spawn_failure_releases_slot(tmp_path: Path) -> None:
    """A missing executable cannot leave an active generation reservation."""
    owner = ImageRuntime(command=("/does/not/exist",), temp_root=tmp_path)
    for _ in range(2):
        with pytest.raises(FileNotFoundError):
            await owner.generate(
                payload=_payload(tmp_path=tmp_path), disconnected=_connected
            )
    assert not list(tmp_path.glob("kromoss-*"))


async def test_timeout_kills_term_resistant_worker(tmp_path: Path) -> None:
    """A deadline escalates to SIGKILL and reaps an uncooperative process."""
    owner = _runtime(tmp_path=tmp_path, timeout=0.8)
    with pytest.raises(TimeoutError):
        await owner.generate(
            payload=_payload(tmp_path=tmp_path, mode="ignore_term"),
            disconnected=_connected,
        )
    _assert_gone(pid=int((tmp_path / "worker.pid").read_text()))
    assert not list(tmp_path.glob("kromoss-*"))


async def test_disconnect_reaps_worker(tmp_path: Path) -> None:
    """HTTP disconnect probing cancels work even without ASGI cancellation."""
    owner = _runtime(tmp_path=tmp_path)

    async def disconnected() -> bool:
        """Disconnect after worker readiness so process ownership is exercised."""
        return (tmp_path / "worker.pid").exists()

    with pytest.raises(ClientDisconnectedError):
        await owner.generate(
            payload=_payload(tmp_path=tmp_path, mode="hold"), disconnected=disconnected
        )
    _assert_gone(pid=int((tmp_path / "worker.pid").read_text()))


async def test_busy_and_shutdown_keep_ownership(tmp_path: Path) -> None:
    """Shutdown reaps work while new requests stay rejected."""
    owner = _runtime(tmp_path=tmp_path)
    task = asyncio.create_task(
        owner.generate(
            payload=_payload(tmp_path=tmp_path, mode="hold"), disconnected=_connected
        )
    )
    await _ready(path=tmp_path / "worker.pid")
    with pytest.raises(WorkerBusyError):
        await owner.generate(
            payload=_payload(tmp_path=tmp_path), disconnected=_connected
        )
    await owner.close()
    with pytest.raises(WorkerFailedError):
        await task
    _assert_gone(pid=int((tmp_path / "worker.pid").read_text()))
    with pytest.raises(RuntimeClosedError):
        await owner.generate(
            payload=_payload(tmp_path=tmp_path), disconnected=_connected
        )


async def test_repeated_cancellation_keeps_slot_until_reaped(tmp_path: Path) -> None:
    """Repeated cancellation cannot abandon a worker during termination."""
    owner = _runtime(tmp_path=tmp_path)
    task = asyncio.create_task(
        owner.generate(
            payload=_payload(tmp_path=tmp_path, mode="ignore_term"),
            disconnected=_connected,
        )
    )
    await _ready(path=tmp_path / "worker.pid")
    task.cancel()
    await asyncio.sleep(0.03)
    task.cancel()
    with pytest.raises(WorkerBusyError):
        await owner.generate(
            payload=_payload(tmp_path=tmp_path), disconnected=_connected
        )
    with pytest.raises(asyncio.CancelledError):
        await task
    _assert_gone(pid=int((tmp_path / "worker.pid").read_text()))
    assert not list(tmp_path.glob("kromoss-*"))
    await owner.generate(payload=_payload(tmp_path=tmp_path), disconnected=_connected)


async def test_cancellation_during_success_cleanup_propagates(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Cancellation arriving after worker exit is retained through cleanup."""
    started = threading.Event()
    release = threading.Event()
    original = runtime_module._stop_group

    def delayed_stop(*, child: subprocess.Popen[bytes], timeout: float) -> None:
        """Pause cleanup to expose its cancellation seam.

        Args:
            child:
                Owned worker.
            timeout:
                Termination deadline.
        """
        started.set()
        release.wait(timeout=5)
        original(child=child, timeout=timeout)

    monkeypatch.setattr(runtime_module, "_stop_group", delayed_stop)
    owner = _runtime(tmp_path=tmp_path)
    task = asyncio.create_task(
        owner.generate(payload=_payload(tmp_path=tmp_path), disconnected=_connected)
    )
    try:
        async with asyncio.timeout(5):
            while not started.is_set():
                await asyncio.sleep(0.01)
        task.cancel()
        release.set()
        with pytest.raises(asyncio.CancelledError):
            await task
    finally:
        release.set()
        await owner.close()
    _assert_gone(pid=int((tmp_path / "worker.pid").read_text()))


async def test_cleanup_kills_descendants(tmp_path: Path) -> None:
    """Cleanup targets the owned group rather than only the direct worker."""
    owner = _runtime(tmp_path=tmp_path)
    payload = _payload(tmp_path=tmp_path, mode="descendant")
    payload["descendant_file"] = str(tmp_path / "descendant.pid")
    task = asyncio.create_task(owner.generate(payload=payload, disconnected=_connected))
    await _ready(path=tmp_path / "worker.pid")
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    _assert_gone(pid=int((tmp_path / "worker.pid").read_text()))
    _assert_gone(pid=int((tmp_path / "descendant.pid").read_text()))


async def test_http_parent_has_no_model_dependencies() -> None:
    """Importing the HTTP parent must not import Torch or Diffusers."""
    result = subprocess.run(
        [
            sys.executable,
            "-c",
            "import sys; from kromoss.server import create_app; create_app(); "
            "assert 'torch' not in sys.modules; assert 'diffusers' not in sys.modules",
        ],
        check=False,
    )
    assert result.returncode == 0


def _runtime(*, tmp_path: Path, timeout: float = 5) -> ImageRuntime:
    """Build a CPU-only runtime through the same command seam as deployment.

    Args:
        tmp_path:
            Temporary test directory.
        timeout (optional):
            Request deadline. Defaults to 5 seconds.

    Returns:
        Runtime running a real fake-worker subprocess.
    """
    return ImageRuntime(
        command=(sys.executable, str(FAKE)),
        timeout=timeout,
        stop_timeout=0.3,
        temp_root=tmp_path,
    )


def _payload(*, tmp_path: Path, mode: str = "success") -> Payload:
    """Build a small request and out-of-band process readiness marker.

    Args:
        tmp_path:
            Temporary test directory.
        mode (optional):
            Fake worker behaviour. Defaults to success.

    Returns:
        Worker input.
    """
    return {
        "prompt": mode,
        "size": "512x512",
        "pid_file": str(tmp_path / "worker.pid"),
    }


async def _connected() -> bool:
    """Represent a client that remains connected.

    Returns:
        False, indicating no disconnect.
    """
    return False


async def _ready(*, path: Path) -> None:
    """Wait for a worker's readiness marker.

    Args:
        path:
            PID marker written by the worker.
    """
    async with asyncio.timeout(5):
        while not path.exists():
            await asyncio.sleep(0.01)


def _assert_gone(*, pid: int) -> None:
    """Assert that an owned process no longer exists.

    Args:
        pid:
            Worker or descendant PID.
    """
    with pytest.raises(ProcessLookupError):
        os.kill(pid, 0)
