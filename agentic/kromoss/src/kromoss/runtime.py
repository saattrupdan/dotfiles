"""Own one image subprocess, its deadline and its complete cleanup."""

import asyncio
import collections.abc as c
import io
import json
import os
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import psutil
from PIL import Image

Payload = dict[str, str | int]


class WorkerBusyError(RuntimeError):
    """The previous worker still owns the generation slot."""


class WorkerFailedError(RuntimeError):
    """A worker exited unsuccessfully or returned invalid output."""


class ClientDisconnectedError(RuntimeError):
    """The caller disconnected before generation finished."""


class RuntimeClosedError(RuntimeError):
    """Shutdown or failed cleanup prevents further workers."""


class ImageRuntime:
    """Keep model loading out of the HTTP parent and retain cleanup ownership."""

    def __init__(
        self,
        *,
        command: tuple[str, ...] | None = None,
        timeout: float = 840,
        stop_timeout: float = 5,
        temp_root: Path | None = None,
    ) -> None:
        """Configure process execution without loading model dependencies.

        Args:
            command (optional):
                Worker command prefix. Defaults to the installed Kromoss worker.
            timeout (optional):
                Maximum seconds per generation. Defaults to 840.
            stop_timeout (optional):
                Seconds allowed for each termination phase. Defaults to 5.
            temp_root (optional):
                Parent for private request directories. Defaults to the system temp dir.
        """
        self.command = command or (sys.executable, "-m", "kromoss.worker")
        self.timeout = timeout
        self.stop_timeout = stop_timeout
        self.temp_root = temp_root
        self._active = False
        self._closed = False
        self._child: subprocess.Popen[bytes] | None = None
        self._cleanup: asyncio.Task[None] | None = None

    async def generate(
        self,
        *,
        payload: Payload,
        disconnected: c.Callable[[], c.Awaitable[bool]],
    ) -> bytes:
        """Generate a validated PNG, reaping all owned processes before returning.

        Args:
            payload:
                Validated image request, also passed unchanged to the worker.
            disconnected:
                Asynchronous caller-disconnect probe.

        Returns:
            Complete PNG bytes after successful worker cleanup.
        """
        if self._closed:
            raise RuntimeClosedError("Image runtime is closed")
        if self._active:
            raise WorkerBusyError("Image worker busy")
        self._active = True
        try:
            with tempfile.TemporaryDirectory(
                prefix="kromoss-", dir=self.temp_root
            ) as directory:
                request = Path(directory) / "request.json"
                output = Path(directory) / "image.png"
                request.write_text(json.dumps(payload))
                # Synchronous spawn has no cancellation seam before ownership is saved.
                child = subprocess.Popen(
                    [*self.command, "--request", str(request), "--output", str(output)],
                    stdin=subprocess.DEVNULL,
                    start_new_session=True,
                )
                self._child = child
                self._cleanup = None
                try:
                    async with asyncio.timeout(self.timeout):
                        while not _has_exited(pid=child.pid):
                            if await disconnected():
                                raise ClientDisconnectedError(
                                    "Image caller disconnected"
                                )
                            await asyncio.sleep(0.1)
                finally:
                    await self._reap()
                if child.returncode != 0:
                    raise WorkerFailedError(
                        f"Image worker exited with status {child.returncode}"
                    )
                return _read_png(output=output, payload=payload)
        finally:
            if not self._closed:
                self._active = False

    async def close(self) -> None:
        """Reject new work and await complete cleanup of the current worker."""
        self._closed = True
        await self._reap()

    async def _reap(self) -> None:
        """Share cancellation-resistant process cleanup with shutdown."""
        if self._child is None:
            return
        if self._cleanup is None:
            self._cleanup = asyncio.create_task(
                asyncio.to_thread(
                    _stop_group,
                    child=self._child,
                    timeout=self.stop_timeout,
                )
            )
        interrupted = False
        try:
            while True:
                try:
                    await asyncio.shield(self._cleanup)
                    break
                except asyncio.CancelledError:
                    interrupted = True
                    if self._cleanup.done():
                        self._cleanup.result()
                        break
        except BaseException:
            self._closed = True
            raise
        self._child = None
        if interrupted:
            raise asyncio.CancelledError


def _read_png(*, output: Path, payload: Payload) -> bytes:
    """Read bounded PNG output and verify the requested dimensions.

    Args:
        output:
            Private worker output path.
        payload:
            Validated request including image size.

    Returns:
        Validated image bytes.
    """
    try:
        if output.stat().st_size > 8 * 1024 * 1024:
            raise ValueError("Image exceeds output limit")
        data = output.read_bytes()
        dimensions = tuple(int(part) for part in str(payload["size"]).split("x"))
        with Image.open(io.BytesIO(data)) as image:
            if image.format != "PNG" or image.size != dimensions:
                raise ValueError("Image format or dimensions do not match the request")
            image.verify()
        return data
    except (OSError, ValueError, KeyError) as exc:
        raise WorkerFailedError("Image worker returned invalid PNG output") from exc


def _stop_group(*, child: subprocess.Popen[bytes], timeout: float) -> None:
    """Terminate the entire owned process group and reap its direct child.

    Args:
        child:
            Worker started as the leader of a new session.
        timeout:
            Seconds allowed for graceful termination and final reaping.
    """
    if child.returncode is not None:
        raise WorkerFailedError(
            "Cannot signal a worker whose leader was already reaped"
        )
    try:
        process = psutil.Process(child.pid)
        if process.ppid() != os.getpid():
            raise WorkerFailedError("Image worker process ownership was lost")
    except psutil.NoSuchProcess as exc:
        raise WorkerFailedError("Image worker process ownership was lost") from exc
    # Retain the unreaped leader, including as a zombie, until ALL signals are sent.
    # Its reserved PID prevents the numeric process group identifier being recycled.
    _signal_group(pid=child.pid, sig=signal.SIGTERM)
    deadline = time.monotonic() + timeout
    while not _has_exited(pid=child.pid) and time.monotonic() < deadline:
        time.sleep(0.05)
    _signal_group(pid=child.pid, sig=signal.SIGKILL)
    child.wait(timeout=timeout)
    deadline = time.monotonic() + timeout
    while _group_exists(pid=child.pid) and time.monotonic() < deadline:
        time.sleep(0.05)
    if _group_exists(pid=child.pid):
        raise WorkerFailedError("Owned image worker processes survived cleanup")


def _has_exited(*, pid: int) -> bool:
    """Observe process exit without reaping the group leader.

    Args:
        pid:
            Owned worker process identifier.

    Returns:
        Whether the process is a zombie, dead or already unavailable.
    """
    try:
        return psutil.Process(pid).status() in {
            psutil.STATUS_ZOMBIE,
            psutil.STATUS_DEAD,
        }
    except psutil.NoSuchProcess:
        return True


def _signal_group(*, pid: int, sig: signal.Signals) -> None:
    """Signal only the process group created for this request.

    Args:
        pid:
            Owned process group identifier.
        sig:
            Signal to send to that group.
    """
    try:
        os.killpg(pid, sig)
    except ProcessLookupError:
        pass
    except PermissionError:
        # macOS rejects signalling a group containing only zombies.
        if _live_group_exists(pid=pid):
            raise


def _group_exists(*, pid: int) -> bool:
    """Check whether the owned process group has any surviving members.

    Args:
        pid:
            Owned process group identifier.

    Returns:
        Whether any process remains in the group.
    """
    try:
        os.killpg(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return _live_group_exists(pid=pid)
    return True


def _live_group_exists(*, pid: int) -> bool:
    """Distinguish macOS zombie-only groups from live, unsignallable members.

    Args:
        pid:
            Owned process group identifier, still reserved by its unreaped leader.

    Returns:
        Whether a non-zombie process belongs to the group.
    """
    for process in psutil.process_iter():
        try:
            if os.getpgid(process.pid) == pid and process.status() not in {
                psutil.STATUS_ZOMBIE,
                psutil.STATUS_DEAD,
            }:
                return True
        except (ProcessLookupError, psutil.NoSuchProcess):
            continue
    return False
