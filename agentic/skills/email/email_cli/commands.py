"""Command handlers for each CLI verb.

Each handler takes the parsed ``argparse`` namespace and performs the action,
printing human output (or JSON for ``--raw``) and raising ``BackendError`` /
``ConfigError`` on failure (caught and reported by :mod:`email_cli.main`).
"""

from __future__ import annotations

import sys

from .backends import BackendError, get_backend
from .config import (
    ConfigError,
    default_password_env,
    load_config,
    resolve_account,
    save_config,
)
from .display import emit_raw, render_message, render_message_list

# Per-provider connection presets applied by `accounts add`.
_PROVIDER_PRESETS = {
    "gmail": {
        "backend": "imap",
        "imap_host": "imap.gmail.com",
        "imap_port": 993,
        "smtp_host": "smtp.gmail.com",
        "smtp_port": 587,
    },
    "imap": {"backend": "imap"},
    "m365": {"backend": "graph", "tenant": "organizations"},
}


# -- accounts ----------------------------------------------------------------


def do_accounts_add(args) -> None:
    """Create or update an account in the config."""
    config = load_config()
    preset = _PROVIDER_PRESETS[args.provider]
    account: dict = {"provider": args.provider, "email": args.email, **preset}
    if args.username:
        account["username"] = args.username
    for key in ("imap_host", "smtp_host", "imap_port", "smtp_port", "tenant"):
        value = getattr(args, key, None)
        if value is not None:
            account[key] = value
    if args.client_id:
        account["client_id"] = args.client_id
    if account["backend"] == "imap":
        account["password_env"] = args.password_env or default_password_env(args.name)

    config.setdefault("accounts", {})[args.name] = account
    if args.default or config.get("default") is None:
        config["default"] = args.name
    save_config(config)

    where = "default account" if config["default"] == args.name else "account"
    print(f"Saved {where} '{args.name}' ({args.email}, {account['backend']} backend).")
    if account["backend"] == "imap":
        print(
            f"Set the app password in {account['password_env']} "
            "(env var or a .env file), then: email login --account " + args.name
        )
    else:
        print(f"Sign in with: email login --account {args.name}")


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
    """Authenticate the selected account."""
    config = load_config()
    name, account = resolve_account(config, args.account)
    backend = get_backend(name, account)
    print(backend.login())


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
    message = backend.get_message(msg_id=args.id, mark_read=args.mark_read)
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
