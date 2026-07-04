"""Gmail CLI main entry point."""

import argparse
import json
import sys
from datetime import datetime

from .auth import get_credentials, login
from .gmail import DEFAULT_LABELS, GmailClient


def format_message_summary(msg: dict) -> str:
    """Format message as summary line."""
    headers = msg.get("payload", {}).get("headers", [])
    subject = next((h["value"] for h in headers if h["name"] == "Subject"), "(no subject)")
    from_addr = next((h["value"] for h in headers if h["name"] == "From"), "Unknown")
    date_str = next((h["value"] for h in headers if h["name"] == "Date"), "")

    # Parse date
    try:
        from email.utils import parsedate_to_datetime
        dt = parsedate_to_datetime(date_str)
        date_fmt = dt.strftime("%Y-%m-%d %H:%M")
    except (ValueError, TypeError):
        date_fmt = date_str

    labels = msg.get("labelIds", [])
    icons = []
    if "UNREAD" in labels:
        icons.append("✉")
    if "STARRED" in labels:
        icons.append("★")
    if "IMPORTANT" in labels:
        icons.append("‼")
    icon_str = " ".join(icons) if icons else "•"

    return f"{icon_str} | {date_fmt} | {from_addr} | {subject} | {msg['id']}"


def cmd_list(args: argparse.Namespace) -> int:
    """List messages."""
    client = GmailClient()
    label_ids = []
    if args.label:
        label_ids = [args.label.upper()]
    if args.unread:
        label_ids.append("UNREAD")
    if args.starred:
        label_ids.append("STARRED")

    messages = client.list_messages(
        query=args.query, max_results=args.limit, label_ids=label_ids if label_ids else None
    )

    if args.raw:
        print(json.dumps(messages, indent=2))
        return 0

    if not messages:
        print("No messages found.")
        return 0

    print(f"{'#':<4} | {'':<6} | {'Date':<18} | {'From':<40} | {'Subject':<50} | Id")
    print("-" * 140)
    for i, msg in enumerate(messages, 1):
        summary = format_message_summary(msg)
        # Parse the summary to display in columns
        print(f"{i:<4} | {summary}")

    return 0


def cmd_read(args: argparse.Namespace) -> int:
    """Read a message."""
    client = GmailClient()
    msg = client.get_message(args.id)
    if not msg:
        print(f"Message {args.id} not found.", file=sys.stderr)
        return 1

    if args.raw:
        print(json.dumps(msg, indent=2))
        return 0

    headers = msg.get("payload", {}).get("headers", [])
    subject = next((h["value"] for h in headers if h["name"] == "Subject"), "(no subject)")
    from_addr = next((h["value"] for h in headers if h["name"] == "From"), "Unknown")
    to_addr = next((h["value"] for h in headers if h["name"] == "To"), "")
    date_str = next((h["value"] for h in headers if h["name"] == "Date"), "")

    body = client.get_message_body(msg)
    labels = msg.get("labelIds", [])
    label_names = [DEFAULT_LABELS.get(l, l) for l in labels]

    print(f"From: {from_addr}")
    print(f"To: {to_addr}")
    print(f"Subject: {subject}")
    print(f"Date: {date_str}")
    print(f"Labels: {', '.join(label_names)}")
    print("-" * 60)
    print(body)

    return 0


def cmd_send(args: argparse.Namespace) -> int:
    """Send an email."""
    client = GmailClient()

    body = args.body
    if args.body_file:
        if args.body_file == "-":
            body = sys.stdin.read()
        else:
            with open(args.body_file) as f:
                body = f.read()

    # Confirm before sending
    if not args.confirm and sys.stdin.isatty():
        print(f"To: {args.to}")
        print(f"Subject: {args.subject}")
        if args.cc:
            print(f"Cc: {args.cc}")
        print("-" * 40)
        print(body[:500] + "..." if len(body) > 500 else body)
        response = input("Send this message? [y/N]: ").strip().lower()
        if response != "y":
            print("Send cancelled.")
            return 0

    result = client.send_message(
        to=args.to, subject=args.subject, body=body, cc=args.cc
    )
    print(f"Message sent: {result['id']}")
    return 0


def cmd_draft(args: argparse.Namespace) -> int:
    """Create or list drafts."""
    client = GmailClient()

    if args.list:
        drafts = client.list_drafts(max_results=args.limit)
        if args.raw:
            print(json.dumps(drafts, indent=2))
            return 0
        if not drafts:
            print("No drafts found.")
            return 0
        for i, draft in enumerate(drafts, 1):
            msg = draft.get("message", {})
            headers = msg.get("payload", {}).get("headers", [])
            subject = next((h["value"] for h in headers if h["name"] == "Subject"), "(no subject)")
            to_addr = next((h["value"] for h in headers if h["name"] == "To"), "")
            print(f"{i}. [{draft['id']}] To: {to_addr} | Subject: {subject}")
        return 0

    if args.delete:
        client.delete_draft(args.delete)
        print(f"Draft {args.delete} deleted.")
        return 0

    if args.show:
        draft = client.get_draft(args.show)
        if args.raw:
            print(json.dumps(draft, indent=2))
            return 0
        msg = draft.get("message", {})
        headers = msg.get("payload", {}).get("headers", [])
        subject = next((h["value"] for h in headers if h["name"] == "Subject"), "(no subject)")
        to_addr = next((h["value"] for h in headers if h["name"] == "To"), "")
        body = client.get_message_body(msg)
        print(f"To: {to_addr}")
        print(f"Subject: {subject}")
        print("-" * 40)
        print(body)
        return 0

    # Create new draft
    body = args.body
    if args.body_file:
        if args.body_file == "-":
            body = sys.stdin.read()
        else:
            with open(args.body_file) as f:
                body = f.read()

    result = client.create_draft(
        to=args.to, subject=args.subject, body=body, cc=args.cc
    )
    print(f"Draft created: {result['id']}")
    return 0


def cmd_delete(args: argparse.Namespace) -> int:
    """Delete a message."""
    client = GmailClient()
    if args.trash:
        result = client.trash_message(args.id)
        print(f"Message {args.id} moved to trash.")
    elif args.spam:
        result = client.spam_message(args.id)
        print(f"Message {args.id} marked as spam.")
    else:
        client.delete_message(args.id)
        print(f"Message {args.id} deleted permanently.")
    return 0


def cmd_label(args: argparse.Namespace) -> int:
    """Manage labels."""
    client = GmailClient()

    if args.list:
        labels = client.list_labels()
        if args.raw:
            print(json.dumps(labels, indent=2))
            return 0
        for label in labels:
            print(f"{label['id']:<20} | {label['name']}")
        return 0

    if args.create:
        result = client.create_label(args.create)
        print(f"Label created: {result['name']} ({result['id']})")
        return 0

    if args.add:
        client.add_label(args.message_id, args.add)
        print(f"Label {args.add} added to message {args.message_id}.")
        return 0

    if args.remove:
        client.remove_label(args.message_id, args.remove)
        print(f"Label {args.remove} removed from message {args.message_id}.")
        return 0

    return 0


def cmd_login(args: argparse.Namespace) -> int:
    """Perform login."""
    try:
        creds = login()
        print("Login successful.")
        return 0
    except Exception as e:
        print(f"Login failed: {e}", file=sys.stderr)
        return 1


def main() -> int:
    """Main entry point."""
    parser = argparse.ArgumentParser(prog="gmail", description="Gmail CLI")
    subparsers = parser.add_subparsers(dest="command", required=True)

    # list command
    p_list = subparsers.add_parser("list", help="List messages")
    p_list.add_argument("-q", "--query", help="Gmail search query")
    p_list.add_argument("-l", "--limit", type=int, default=10, help="Max results")
    p_list.add_argument("--label", help="Filter by label ID (e.g., INBOX, SENT)")
    p_list.add_argument("--unread", action="store_true", help="Show unread only")
    p_list.add_argument("--starred", action="store_true", help="Show starred only")
    p_list.add_argument("--raw", action="store_true", help="Output JSON")
    p_list.set_defaults(func=cmd_list)

    # read command
    p_read = subparsers.add_parser("read", help="Read a message")
    p_read.add_argument("id", help="Message ID")
    p_read.add_argument("--raw", action="store_true", help="Output JSON")
    p_read.set_defaults(func=cmd_read)

    # send command
    p_send = subparsers.add_parser("send", help="Send an email")
    p_send.add_argument("--to", required=True, help="Recipient email")
    p_send.add_argument("--subject", required=True, help="Subject line")
    p_send.add_argument("--body", help="Message body")
    p_send.add_argument("--body-file", help="Body from file (use - for stdin)")
    p_send.add_argument("--cc", help="CC recipients")
    p_send.add_argument("--confirm", action="store_true", help="Skip confirmation")
    p_send.set_defaults(func=cmd_send)

    # draft command
    p_draft = subparsers.add_parser("draft", help="Manage drafts")
    p_draft.add_argument("--to", help="Recipient email")
    p_draft.add_argument("--subject", help="Subject line")
    p_draft.add_argument("--body", help="Message body")
    p_draft.add_argument("--body-file", help="Body from file")
    p_draft.add_argument("--cc", help="CC recipients")
    p_draft.add_argument("--list", action="store_true", help="List drafts")
    p_draft.add_argument("--show", help="Show specific draft")
    p_draft.add_argument("--delete", help="Delete specific draft")
    p_draft.add_argument("-l", "--limit", type=int, default=10, help="Max drafts to list")
    p_draft.add_argument("--raw", action="store_true", help="Output JSON")
    p_draft.set_defaults(func=cmd_draft)

    # delete command
    p_delete = subparsers.add_parser("delete", help="Delete a message")
    p_delete.add_argument("id", help="Message ID")
    p_delete.add_argument("--trash", action="store_true", help="Move to trash")
    p_delete.add_argument("--spam", action="store_true", help="Mark as spam")
    p_delete.set_defaults(func=cmd_delete)

    # label command
    p_label = subparsers.add_parser("label", help="Manage labels")
    p_label.add_argument("--list", action="store_true", help="List all labels")
    p_label.add_argument("--create", help="Create new label")
    p_label.add_argument("--add", help="Add label to message (requires --message-id)")
    p_label.add_argument("--remove", help="Remove label from message")
    p_label.add_argument("--message-id", help="Message ID for add/remove")
    p_label.add_argument("--raw", action="store_true", help="Output JSON")
    p_label.set_defaults(func=cmd_label)

    # login command
    p_login = subparsers.add_parser("login", help="Authenticate with Gmail")
    p_login.set_defaults(func=cmd_login)

    args = parser.parse_args()

    # Check credentials for non-login commands
    if args.command != "login":
        if not get_credentials():
            print("Not authenticated. Run: gmail login", file=sys.stderr)
            return 1

    return args.func(args)


def cli() -> None:
    """CLI entry point."""
    sys.exit(main())


if __name__ == "__main__":
    cli()
