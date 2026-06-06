"""Argument parser for the ``email`` CLI.

Command tree::

    email accounts add | list | remove
    email login
    email list
    email read
    email send
    email unread next
"""

from __future__ import annotations

import argparse


def _add_account_flag(p: argparse.ArgumentParser) -> None:
    p.add_argument(
        "--account",
        "-a",
        default=None,
        help="Account name (defaults to the configured default account).",
    )


def build_parser() -> argparse.ArgumentParser:
    """Build the top-level argument parser."""
    parser = argparse.ArgumentParser(
        prog="email",
        description="Read and send email via Microsoft 365 (Outlook on the web).",
    )
    sub = parser.add_subparsers(dest="resource", required=True)

    # -- accounts ------------------------------------------------------------
    accounts = sub.add_parser("accounts", help="Manage configured accounts.")
    acc_sub = accounts.add_subparsers(dest="operation", required=True)

    add = acc_sub.add_parser("add", help="Add or update an account.")
    add.add_argument("--name", required=True, help="Local name for the account.")
    add.add_argument("--email", required=True, help="The account's email address.")
    add.add_argument("--tenant", help="Azure tenant (default 'organizations').")
    add.add_argument("--client-id", help="Custom Azure app client id.")
    add.add_argument(
        "--default", action="store_true", help="Make this the default account."
    )

    acc_sub.add_parser("list", help="List configured accounts.")
    rm = acc_sub.add_parser("remove", help="Remove an account.")
    rm.add_argument("--name", required=True, help="Account name to remove.")

    # -- login ---------------------------------------------------------------
    login = sub.add_parser("login", help="Authenticate an account.")
    _add_account_flag(login)
    login.add_argument(
        "--mfa-code",
        action="store_true",
        help="Step 2: finish login after MFA code was approved (step 1 shows the code).",
    )

    # -- list ----------------------------------------------------------------
    lst = sub.add_parser("list", help="List messages in a folder.")
    _add_account_flag(lst)
    lst.add_argument(
        "--folder", default="inbox", help="Folder/mailbox (default inbox)."
    )
    lst.add_argument(
        "--query",
        "-q",
        help="Search: free text, or from:/to:/subject: prefix.",
    )
    lst.add_argument("--unread", action="store_true", help="Only unread messages.")
    lst.add_argument("--pinned", action="store_true", help="Only pinned messages.")
    lst.add_argument(
        "--limit", "-n", type=int, default=20, help="Max messages (default 20)."
    )
    lst.add_argument("--raw", action="store_true", help="Emit JSON instead of a table.")

    # -- read ----------------------------------------------------------------
    read = sub.add_parser("read", help="Read a single message in full.")
    _add_account_flag(read)
    read.add_argument(
        "--folder", default="inbox", help="Folder/mailbox (default inbox)."
    )
    read.add_argument("--id", required=True, help="Message id (from `list`).")
    read.add_argument(
        "--mark-read", action="store_true", help="Mark the message as read."
    )
    read.add_argument(
        "--html", action="store_true", help="Prefer the HTML body over plaintext."
    )
    read.add_argument("--raw", action="store_true", help="Emit JSON instead of text.")

    # -- send ----------------------------------------------------------------
    send = sub.add_parser("send", help="Send a message (confirms first).")
    _add_account_flag(send)
    send.add_argument("--to", required=True, help="Recipient(s), comma-separated.")
    send.add_argument("--cc", help="Cc recipient(s), comma-separated.")
    send.add_argument("--bcc", help="Bcc recipient(s), comma-separated.")
    send.add_argument("--subject", required=True, help="Subject line.")
    body = send.add_mutually_exclusive_group(required=True)
    body.add_argument("--body", help="Message body text.")
    body.add_argument("--body-file", help="Read the body from a file ('-' = stdin).")
    send.add_argument(
        "--attach", action="append", default=[], help="Attach a file (repeatable)."
    )
    send.add_argument(
        "--confirm",
        action="store_true",
        help="Skip the confirmation prompt (required when non-interactive).",
    )

    # -- pin -----------------------------------------------------------------
    pin = sub.add_parser("pin", help="Pin a message to the top of its folder.")
    _add_account_flag(pin)
    pin.add_argument(
        "--folder", default="inbox", help="Folder/mailbox (default inbox)."
    )
    pin.add_argument("--id", required=True, help="Message id (from `list`).")

    # -- unpin ---------------------------------------------------------------
    unpin = sub.add_parser("unpin", help="Remove a pin from a message.")
    _add_account_flag(unpin)
    unpin.add_argument(
        "--folder", default="inbox", help="Folder/mailbox (default inbox)."
    )
    unpin.add_argument("--id", required=True, help="Message id (from `list`).")

    # -- unread --------------------------------------------------------------
    unread = sub.add_parser("unread", help="Work with unread emails.")
    unread_sub = unread.add_subparsers(dest="operation", required=True)

    unread_next = unread_sub.add_parser("next", help="Get the next unread email.")
    _add_account_flag(unread_next)
    unread_next.add_argument(
        "--folder", default="inbox", help="Folder to fetch unread from (default inbox)."
    )
    unread_next.add_argument(
        "--mark-read",
        action="store_true",
        help="Mark the message as read after fetching.",
    )
    unread_next.add_argument(
        "--html", action="store_true", help="Prefer the HTML body over plaintext."
    )
    unread_next.add_argument(
        "--raw", action="store_true", help="Emit JSON instead of text."
    )

    # -- copy-to-folder -------------------------------------------------------
    copy_to_folder = sub.add_parser(
        "copy-to-folder", help="Move a message to another folder."
    )
    _add_account_flag(copy_to_folder)
    copy_to_folder.add_argument(
        "--folder", default="inbox", help="Source folder (default inbox)."
    )
    copy_to_folder.add_argument("--id", required=True, help="Message id (from `list`).")
    copy_to_folder.add_argument(
        "--to-folder", required=True, help="Destination folder name."
    )

    return parser
