#!/usr/bin/env python3
"""Entry point for the Confluence CLI.

Loads environment configuration, parses CLI arguments, and dispatches
to the appropriate resource handler.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")

from .auth import _load_env, run_cmd
from .cli_dispatch import build_dispatch
from .cli_parser import _build_parser


def main() -> None:
    """Parse arguments and dispatch to the selected command."""
    _load_env(Path(".env"))
    parser = _build_parser()
    args = parser.parse_args()

    resource = args.resource
    operation = getattr(args, "operation", None)
    dispatch = build_dispatch()
    func = dispatch.get((resource, operation))
    if func is None:
        sys.stderr.write(
            f"Unknown command: {resource}"
            + (f" {operation}" if operation else "")
            + "\n",
        )
        sys.exit(2)
    run_cmd(func, args)


if __name__ == "__main__":
    main()
