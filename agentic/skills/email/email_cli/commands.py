"""Command handlers for each CLI verb.

Each handler takes the parsed ``argparse`` namespace and performs the action,
printing human output (or JSON for ``--raw``) and raising ``BackendError`` /
``ConfigError`` on failure (caught and reported by :mod:`email_cli.main`).
"""

from __future__ import annotations

import sys

from .backend import BackendError, get_backend
from .config import (
    ConfigError,
    load_config,
    resolve_account,
    save_config,
)
from .display import emit_raw, render_message, render_message_list


# -- accounts ----------------------------------------------------------------


def do_accounts_add(args) -> None:
    """Create or update an account in the config."""
    config = load_config()
    account: dict = {
        "provider": "m365",
        "backend": "owa",
        "email": args.email,
        "tenant": args.tenant or "organizations",
    }
    if args.client_id:
        account["client_id"] = args.client_id

    config.setdefault("accounts", {})[args.name] = account
    if args.default or config.get("default") is None:
        config["default"] = args.name
    save_config(config)

    where = "default account" if config["default"] == args.name else "account"
    print(f"Saved {where} '{args.name}' ({args.email}, OWA backend).")
    print(
        "Sign in (opens an Outlook browser window for a one-time login) with: "
        f"email login --account {args.name}"
    )


def do_accounts_list(_args) -> None:
    """List configured accounts and the default."""
    config = load_config()
    accounts = config.get("accounts", {})
    if not accounts:
        print("No accounts configured. Add one with: email accounts add ...")
        return
    default = config.get("default")
    for name, acc in sorted(accounts.items()):
        marker = " *" if name == default else ""
        print(f"{name}{marker}\t{acc.get('email', '')}\t{acc.get('backend', '?')}")
    print("\n(* = default)")


def do_accounts_remove(args) -> None:
    """Remove an account from the config."""
    config = load_config()
    accounts = config.get("accounts", {})
    if args.name not in accounts:
        raise ConfigError(f"No such account '{args.name}'.")
    del accounts[args.name]
    if config.get("default") == args.name:
        config["default"] = next(iter(accounts), None)
    save_config(config)
    print(f"Removed account '{args.name}'.")


# -- login -------------------------------------------------------------------


def do_login(args) -> None:
    """Authenticate the selected account.

    Two-step flow:
    1. Without --mfa-code: Shows MFA code and exits (user approves in Authenticator)
    2. With --mfa-code: Finishes login by clicking the confirm button
    """
    config = load_config()
    name, account = resolve_account(config, args.account)
    backend = get_backend(name, account)

    if args.mfa_code:
        # Step 2: finish login
        print(backend.finish_login())
    else:
        # Step 1: get MFA code
        print(backend.get_mfa_code())


# -- read --------------------------------------------------------------------


def do_list(args) -> None:
    """List messages in a folder."""
    config = load_config()
    name, account = resolve_account(config, args.account)
    backend = get_backend(name, account)
    messages = backend.list_messages(
        folder=args.folder,
        query=args.query,
        unread_only=args.unread,
        pinned_only=args.pinned,
        limit=args.limit,
    )
    if args.raw:
        emit_raw([m.to_dict() for m in messages])
        return
    print(render_message_list(messages))


def do_read(args) -> None:
    """Read one message in full."""
    config = load_config()
    name, account = resolve_account(config, args.account)
    backend = get_backend(name, account)

    message = backend.get_message(
        msg_id=args.id, mark_read=args.mark_read, folder=args.folder
    )
    if args.raw:
        emit_raw(message.to_dict())
        return
    print(render_message(message, want_html=args.html))


# -- send --------------------------------------------------------------------


def _split_addrs(value: str | None) -> list[str]:
    if not value:
        return []
    return [a.strip() for a in value.split(",") if a.strip()]


def _read_body(args) -> str:
    if args.body is not None:
        return args.body
    if args.body_file == "-":
        return sys.stdin.read()
    try:
        with open(args.body_file, encoding="utf-8") as fh:
            return fh.read()
    except OSError as exc:
        raise BackendError(f"Could not read body file '{args.body_file}': {exc}")


def do_send(args) -> None:
    """Send a message, confirming with the user first."""
    config = load_config()
    name, account = resolve_account(config, args.account)
    backend = get_backend(name, account)

    if args.attach and account.get("backend") == "owa":
        raise BackendError(
            "The OWA (browser) backend does not support attachments yet. Send "
            "at this time. Attachments are not yet supported in the OWA backend."
        )

    to = _split_addrs(args.to)
    cc = _split_addrs(args.cc)
    bcc = _split_addrs(args.bcc)
    body = _read_body(args)

    preview = body if len(body) <= 500 else body[:500] + "\n…(truncated)"
    summary = [
        "About to send this message:",
        f"  Account: {name} ({account.get('email', '')})",
        f"  To:      {', '.join(to)}",
    ]
    if cc:
        summary.append(f"  Cc:      {', '.join(cc)}")
    if bcc:
        summary.append(f"  Bcc:     {', '.join(bcc)}")
    summary.append(f"  Subject: {args.subject}")
    if args.attach:
        summary.append(f"  Attach:  {', '.join(args.attach)}")
    summary.append("")
    summary.append(preview)
    summary.append("")
    print("\n".join(summary))

    if not args.confirm:
        if not sys.stdin.isatty():
            raise BackendError("Refusing to send non-interactively without --confirm.")
        answer = input("Send this message? [y/N] ").strip().lower()
        if answer not in ("y", "yes"):
            print("Aborted — message not sent.")
            return

    backend.send_message(
        to=to,
        cc=cc,
        bcc=bcc,
        subject=args.subject,
        body=body,
        attachments=args.attach,
    )
    print(f"Sent to {', '.join(to)}.")


def do_pin(args) -> None:
    """Pin a message to the top of its folder."""
    config = load_config()
    name, account = resolve_account(config, args.account)
    backend = get_backend(name, account)
    backend.pin_message(msg_id=args.id, folder=args.folder)
    print(f"Pinned message {args.id} in {args.folder}.")


def do_unpin(args) -> None:
    """Remove a pin from a message."""
    config = load_config()
    name, account = resolve_account(config, args.account)
    backend = get_backend(name, account)
    backend.unpin_message(msg_id=args.id, folder=args.folder)
    print(f"Unpinned message {args.id} in {args.folder}.")


# -- unread ------------------------------------------------------------------


def do_unread_next(args) -> None:
    """Get the next unread email and optionally mark it as read.

    This combines list + read into one atomic operation for workflow efficiency.
    Fetches the first unread email from the specified folder (oldest first for
    inbox-zero approach), displays it in full, and can mark it as read.
    """
    config = load_config()
    name, account = resolve_account(config, args.account)
    backend = get_backend(name, account)

    message = backend.get_next_unread(
        folder=args.folder,
        mark_read=args.mark_read,
    )

    if message is None:
        print("No unread emails found.")
        return

    if args.raw:
        emit_raw(message.to_dict())
        return

    print(render_message(message, want_html=args.html))


# -- copy-to-folder ----------------------------------------------------------


def do_copy_to_folder(args) -> None:
    """Move a message to another folder.

    This is designed for an interactive workflow where you:
    1. List or read an email
    2. Decide it needs to be moved to a different folder
    3. Run copy-to-folder with the message ID and destination folder

    Supports standard folders (inbox, sent items, drafts, archive, deleted items)
    and custom folders (Needs Action, Waiting for Reply, For Future Reference).
    """
    config = load_config()
    name, account = resolve_account(config, args.account)
    backend = get_backend(name, account)
    backend.move_to_folder(msg_id=args.id, folder=args.to_folder)
    print(f"Moved message {args.id} to '{args.to_folder}'.")
