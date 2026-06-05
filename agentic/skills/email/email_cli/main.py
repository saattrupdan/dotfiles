#!/usr/bin/env python3
"""Entry point for the ``email`` CLI.

Loads ``.env`` files, parses arguments, dispatches to a command handler, and
reports backend/config errors to stderr with a non-zero exit code.

Usage:
    email accounts add --name N --email E [--default]
    email accounts list
    email accounts remove --name N
    email login [--account N]              # Step 1: shows MFA code
    email login --mfa-code [--account N]   # Step 2: finish login
    email list [--account N] [--folder F] [--query Q] [--unread] [--pinned]
        [--limit N] [--raw]
    email read [--account N] --id ID [--mark-read] [--html] [--raw]
    email send [--account N] --to A,B --subject S (--body T | --body-file F) [--confirm]
    email pin [--account N] --id ID [--folder F]
    email unpin [--account N] --id ID [--folder F]
"""

from __future__ import annotations

import sys

from . import commands
from .backend import BackendError
from .cli_parser import build_parser
from .config import ConfigError, load_dotenvs


def main() -> None:
    """Parse arguments and dispatch to the selected command."""
    load_dotenvs()
    parser = build_parser()
    args = parser.parse_args()

    resource = args.resource
    operation = getattr(args, "operation", None)

    dispatch = {
        ("accounts", "add"): commands.do_accounts_add,
        ("accounts", "list"): commands.do_accounts_list,
        ("accounts", "remove"): commands.do_accounts_remove,
        ("login", None): commands.do_login,
        ("list", None): commands.do_list,
        ("read", None): commands.do_read,
        ("send", None): commands.do_send,
        ("pin", None): commands.do_pin,
        ("unpin", None): commands.do_unpin,
    }

    handler = dispatch.get((resource, operation))
    if handler is None:
        sys.stderr.write(
            f"Unknown command: {resource}"
            + (f" {operation}" if operation else "")
            + "\n"
        )
        sys.exit(2)

    try:
        handler(args)
    except (BackendError, ConfigError) as exc:
        sys.stderr.write(f"{exc}\n")
        sys.exit(1)
    except KeyboardInterrupt:
        sys.stderr.write("\nInterrupted.\n")
        sys.exit(130)


if __name__ == "__main__":
    main()
