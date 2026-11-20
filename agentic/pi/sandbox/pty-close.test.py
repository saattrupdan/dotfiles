"""Exercise sandbox disposal through a real controlling terminal."""

import argparse
import fcntl
import json
import logging
import os
import pty
import select
import shutil
import signal
import struct
import subprocess
import tempfile
import termios
import time
from pathlib import Path

CONTAINER = "/usr/local/bin/container"
LOGGER = logging.getLogger(__name__)


def main() -> None:
    """Close a live sandbox terminal and require complete container removal."""
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=["hangup", "term", "kill", "quit", "resize"])
    mode = parser.parse_args().mode
    root = Path(tempfile.mkdtemp(prefix="pi-sandbox-pty-close-"))
    subprocess.run(["git", "init", "-q", str(root)], check=True)
    (root / ".pi").mkdir()
    (root / ".pi/sandbox.json").write_text('{"enabled":true}\n')
    env = os.environ.copy()
    env.pop("PI_PROFILE_RELOAD_TOKEN", None)
    env["TERM"] = "xterm-256color"
    launcher = Path(__file__).resolve().parents[1] / "profile/launcher.mjs"
    pid, master = pty.fork()
    if pid == 0:
        os.chdir(root)
        os.execvpe(
            "node",
            ["node", str(launcher), "--tui-mode", "regular", "--no-session"],
            env,
        )
    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
    exited = False
    output = bytearray()
    name: str | None = None
    try:
        deadline = time.monotonic() + 20
        while "╭".encode() not in output and time.monotonic() < deadline:
            exited = os.waitpid(pid, os.WNOHANG)[0] == pid
            if exited:
                break
            if select.select([master], [], [], 0.1)[0]:
                output.extend(os.read(master, 65536))
        assert "╭".encode() in output, "Sandbox did not reach its interactive editor"
        matches = _project_containers(project=root)
        assert len(matches) == 1, "Expected one actual sandbox for this terminal"
        name = matches[0]
        if mode == "resize":
            fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 46, 96, 0, 0))
            deadline = time.monotonic() + 5
            dimensions = ""
            while time.monotonic() < deadline:
                probe = subprocess.run(
                    [CONTAINER, "exec", name, "stty", "-F", "/dev/pts/0", "size"],
                    capture_output=True,
                    text=True,
                    timeout=5,
                    check=False,
                )
                dimensions = probe.stdout.strip()
                if dimensions == "46 96":
                    break
                time.sleep(0.1)
            assert dimensions == "46 96", (
                f"Guest kept stale dimensions: {dimensions}; {probe.stderr.strip()}"
            )
        if mode == "hangup":
            os.close(master)
            master = -1
        elif mode == "kill":
            os.killpg(pid, signal.SIGKILL)
        elif mode == "term":
            os.killpg(pid, signal.SIGTERM)
        else:
            os.write(master, b"\x04")
        deadline = time.monotonic() + 12
        while time.monotonic() < deadline:
            # Draining the PTY prevents output backpressure from faking a hang.
            if master >= 0 and select.select([master], [], [], 0.1)[0]:
                try:
                    os.read(master, 65536)
                except OSError:
                    pass
            if not _project_containers(project=root):
                break
            time.sleep(0.1)
        assert not _project_containers(project=root), (
            f"{mode}: session closed but its container still exists: {name}"
        )
        deadline = time.monotonic() + 5
        while not exited and time.monotonic() < deadline:
            exited = os.waitpid(pid, os.WNOHANG)[0] == pid
            if not exited:
                time.sleep(0.1)
        assert exited, "Sandbox launcher did not exit after removing its container"
        LOGGER.info("PASS: %s removed the sandbox container", mode)
    finally:
        if not exited:
            os.kill(pid, signal.SIGKILL)
            os.waitpid(pid, 0)
        # Recheck mounts so failures before readiness cannot leak a test VM.
        for remaining in _project_containers(project=root):
            subprocess.run(
                [CONTAINER, "delete", "--force", remaining],
                capture_output=True,
                timeout=20,
                check=False,
            )
        if master >= 0:
            os.close(master)
        shutil.rmtree(root)


def _project_containers(*, project: Path) -> list[str]:
    """Find container identities by their exact project mount.

    Args:
        project:
            Temporary repository owned by this test.

    Returns:
        Matching container identities, including stopped containers.
    """
    output = subprocess.check_output(
        [CONTAINER, "list", "--all", "--format", "json"], timeout=10
    )
    return [
        item["id"]
        for item in json.loads(output)
        if any(
            mount["destination"] == "/workspace"
            and mount["source"] == str(project.resolve())
            for mount in item["configuration"]["mounts"]
        )
    ]


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    main()
