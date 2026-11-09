"""Exercise real subprocess ownership without model dependencies."""

import argparse
import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

from PIL import Image


def main() -> None:
    """Write a PNG or exercise a selected worker failure mode."""
    parser = argparse.ArgumentParser()
    parser.add_argument("--request", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    payload = json.loads(args.request.read_text())
    mode = payload["prompt"]
    if mode in {"ignore_term", "descendant"}:
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
    if mode == "descendant":
        descendant = subprocess.Popen(
            [sys.executable, "-c", "import time; time.sleep(60)"]
        )
        Path(payload["descendant_file"]).write_text(str(descendant.pid))
    if "pid_file" in payload:
        Path(payload["pid_file"]).write_text(str(os.getpid()))
    if mode in {"hold", "ignore_term", "descendant"}:
        time.sleep(60)
    if mode == "exit":
        sys.exit(7)
    if mode == "missing":
        return
    if mode == "malformed":
        args.output.write_bytes(b"not a PNG")
        return
    width, height = (int(part) for part in payload["size"].split("x"))
    size = (width, height)
    if mode == "wrong_size":
        size = (1, 1)
    Image.new("RGB", size, "blue").save(args.output, format="PNG")


if __name__ == "__main__":
    main()
