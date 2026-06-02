"""IMAP (read) + SMTP (send) backend for Gmail and other basic-auth providers.

Authentication is an app password read from an environment variable (see
``password_env`` on the account, defaulting to ``EMAIL_<NAME>_APP_PASSWORD``).
Everything here is Python standard library.
"""

from __future__ import annotations

import email
import imaplib
import os
import smtplib
import ssl
from email.header import decode_header, make_header
from email.message import EmailMessage
from email.utils import parsedate_to_datetime
from pathlib import Path

from ..config import default_password_env
from ..models import Message
from .base import BackendError

# Common IMAP folder aliases → server mailbox names. Gmail exposes special
# folders under the "[Gmail]/" namespace; INBOX is universal.
_FOLDER_ALIASES = {
    "inbox": "INBOX",
    "sent": "[Gmail]/Sent Mail",
    "drafts": "[Gmail]/Drafts",
    "spam": "[Gmail]/Spam",
    "trash": "[Gmail]/Trash",
    "all": "[Gmail]/All Mail",
}


def _decode(value: str | None) -> str:
    """Decode an RFC 2047 encoded header into a plain string."""
    if not value:
        return ""
    try:
        return str(make_header(decode_header(value)))
    except Exception:
        return value


class ImapSmtpBackend:
    """Read via IMAP and send via SMTP using an app password."""

    def __init__(self, *, name: str, account: dict) -> None:
        self._name = name
        self._account = account
        self._email = account.get("email", "")

    # -- credentials ---------------------------------------------------------

    def _password(self) -> str:
        """Return the app password from the configured environment variable."""
        env_name = self._account.get("password_env") or default_password_env(self._name)
        password = os.environ.get(env_name)
        if not password:
            raise BackendError(
                f"No app password found. Set {env_name} (env var or .env) to the "
                f"app password for {self._email}."
            )
        return password

    def _username(self) -> str:
        return self._account.get("username") or self._email

    # -- connections ---------------------------------------------------------

    def _imap(self) -> imaplib.IMAP4_SSL:
        host = self._account.get("imap_host", "imap.gmail.com")
        port = int(self._account.get("imap_port", 993))
        try:
            conn = imaplib.IMAP4_SSL(host, port)
            conn.login(self._username(), self._password())
        except imaplib.IMAP4.error as exc:
            raise BackendError(
                f"IMAP login failed for {self._email}: {exc}. Check the app "
                "password and that IMAP is enabled for the account."
            ) from exc
        except OSError as exc:
            raise BackendError(f"Could not connect to {host}:{port}: {exc}") from exc
        return conn

    def _select(self, conn: imaplib.IMAP4_SSL, folder: str, *, readonly: bool) -> str:
        mailbox = _FOLDER_ALIASES.get(folder.lower(), folder)
        typ, _ = conn.select(f'"{mailbox}"', readonly=readonly)
        if typ != "OK":
            raise BackendError(f"Could not open folder '{folder}' ({mailbox}).")
        return mailbox

    # -- search --------------------------------------------------------------

    @staticmethod
    def _search_criteria(query: str | None, unread_only: bool) -> list[str]:
        """Translate the simple query language into IMAP SEARCH tokens.

        Supports ``from:x``, ``to:x``, ``subject:x`` prefixes; any other text
        becomes a full-text ``TEXT`` match. ``unread_only`` adds ``UNSEEN``.
        """
        criteria: list[str] = []
        if unread_only:
            criteria.append("UNSEEN")
        if query:
            lowered = query.lower()
            if lowered.startswith("from:"):
                criteria += ["FROM", query[5:].strip()]
            elif lowered.startswith("to:"):
                criteria += ["TO", query[3:].strip()]
            elif lowered.startswith("subject:"):
                criteria += ["SUBJECT", query[8:].strip()]
            else:
                criteria += ["TEXT", query]
        if not criteria:
            criteria = ["ALL"]
        return criteria

    # -- read ----------------------------------------------------------------

    def login(self) -> str:
        conn = self._imap()
        try:
            conn.logout()
        except Exception:
            pass
        return f"IMAP login OK for {self._email}."

    def list_messages(
        self, *, folder: str, query: str | None, unread_only: bool, limit: int
    ) -> list[Message]:
        conn = self._imap()
        try:
            self._select(conn, folder, readonly=True)
            criteria = self._search_criteria(query, unread_only)
            typ, data = conn.uid("search", None, *criteria)
            if typ != "OK":
                raise BackendError(f"IMAP search failed: {data!r}")
            uids = data[0].split()
            uids = uids[-limit:][::-1]  # newest first
            if not uids:
                return []
            # Fetch headers + flags in one round trip.
            uid_set = b",".join(uids).decode()
            typ, fetched = conn.uid(
                "fetch",
                uid_set,
                "(FLAGS BODY.PEEK[HEADER.FIELDS (FROM TO SUBJECT DATE)])",
            )
            if typ != "OK":
                raise BackendError(f"IMAP fetch failed: {fetched!r}")
            return self._parse_fetched_headers(fetched, uids)
        finally:
            try:
                conn.logout()
            except Exception:
                pass

    @staticmethod
    def _parse_fetched_headers(fetched: list, uids: list[bytes]) -> list[Message]:
        """Build header-only Messages from a UID FETCH response, ordered by ``uids``."""
        by_uid: dict[str, Message] = {}
        for item in fetched:
            if not isinstance(item, tuple) or len(item) < 2:
                continue
            meta = item[0].decode(errors="replace")
            uid = ""
            for token in meta.replace("(", " ").replace(")", " ").split():
                if token.isdigit():
                    uid = token
            # FLAGS appear in the meta segment, e.g. "FLAGS (\Seen)".
            unread = "\\seen" not in meta.lower()
            parsed = email.message_from_bytes(item[1])
            date_raw = _decode(parsed.get("Date"))
            try:
                date = parsedate_to_datetime(date_raw).strftime("%Y-%m-%d %H:%M")
            except (TypeError, ValueError):
                date = date_raw
            msg = Message(
                id=uid,
                date=date,
                sender=_decode(parsed.get("From")),
                subject=_decode(parsed.get("Subject")),
                unread=unread,
                to=[_decode(parsed.get("To"))] if parsed.get("To") else [],
            )
            if uid:
                by_uid[uid] = msg
        return [by_uid[u.decode()] for u in uids if u.decode() in by_uid]

    def get_message(self, *, msg_id: str, mark_read: bool) -> Message:
        conn = self._imap()
        try:
            self._select(conn, "inbox", readonly=not mark_read)
            typ, data = conn.uid("fetch", msg_id, "(RFC822)")
            if typ != "OK" or not data or not isinstance(data[0], tuple):
                raise BackendError(f"Message '{msg_id}' not found.")
            parsed = email.message_from_bytes(data[0][1])
            message = self._parse_full(msg_id, parsed)
            if mark_read:
                conn.uid("store", msg_id, "+FLAGS", "(\\Seen)")
                message.unread = False
            return message
        finally:
            try:
                conn.logout()
            except Exception:
                pass

    @staticmethod
    def _parse_full(uid: str, parsed: email.message.Message) -> Message:
        """Extract body text/html and attachment names from a full message."""
        body_text: str | None = None
        body_html: str | None = None
        attachments: list[str] = []
        for part in parsed.walk():
            if part.is_multipart():
                continue
            disp = str(part.get("Content-Disposition") or "")
            ctype = part.get_content_type()
            if "attachment" in disp.lower():
                fname = _decode(part.get_filename())
                if fname:
                    attachments.append(fname)
                continue
            try:
                payload = part.get_payload(decode=True)
                text = payload.decode(
                    part.get_content_charset() or "utf-8", errors="replace"
                )
            except Exception:
                continue
            if ctype == "text/plain" and body_text is None:
                body_text = text
            elif ctype == "text/html" and body_html is None:
                body_html = text
        date_raw = _decode(parsed.get("Date"))
        try:
            date = parsedate_to_datetime(date_raw).strftime("%Y-%m-%d %H:%M")
        except (TypeError, ValueError):
            date = date_raw
        return Message(
            id=uid,
            date=date,
            sender=_decode(parsed.get("From")),
            subject=_decode(parsed.get("Subject")),
            unread=False,
            to=[_decode(parsed.get("To"))] if parsed.get("To") else [],
            body_text=body_text,
            body_html=body_html,
            attachments=attachments,
        )

    # -- send ----------------------------------------------------------------

    def send_message(
        self,
        *,
        to: list[str],
        cc: list[str],
        bcc: list[str],
        subject: str,
        body: str,
        attachments: list[str],
    ) -> None:
        msg = EmailMessage()
        msg["From"] = self._email
        msg["To"] = ", ".join(to)
        if cc:
            msg["Cc"] = ", ".join(cc)
        msg["Subject"] = subject
        msg.set_content(body)
        for path_str in attachments:
            path = Path(path_str)
            try:
                data = path.read_bytes()
            except OSError as exc:
                raise BackendError(f"Could not read attachment '{path_str}': {exc}")
            msg.add_attachment(
                data,
                maintype="application",
                subtype="octet-stream",
                filename=path.name,
            )

        host = self._account.get("smtp_host", "smtp.gmail.com")
        port = int(self._account.get("smtp_port", 587))
        recipients = to + cc + bcc
        try:
            with smtplib.SMTP(host, port, timeout=30) as server:
                server.starttls(context=ssl.create_default_context())
                server.login(self._username(), self._password())
                server.send_message(msg, to_addrs=recipients)
        except smtplib.SMTPAuthenticationError as exc:
            raise BackendError(
                f"SMTP authentication failed for {self._email}: {exc}. Check the "
                "app password."
            ) from exc
        except (smtplib.SMTPException, OSError) as exc:
            raise BackendError(f"SMTP send failed via {host}:{port}: {exc}") from exc
