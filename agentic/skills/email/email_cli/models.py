"""Transport-agnostic data model shared by all backends.

Every backend (IMAP/SMTP, Graph) returns :class:`Message` objects so the CLI and
display layers never need to know which provider produced them.
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class Message:
    """A single email message.

    Attributes:
        id:
            Backend-specific opaque identifier (IMAP UID or Graph message id).
            Stable enough to pass back to ``read``/``mark-read`` within a folder.
        date:
            Human-readable send/receipt date as reported by the backend.
        sender:
            The ``From`` address (display form, e.g. ``Name <a@b.com>``).
        to:
            Recipient addresses.
        subject:
            The subject line.
        unread:
            ``True`` when the message has not been marked read/seen.
        preview:
            A short plaintext snippet of the body (may be empty for listings).
        body_text:
            The full plaintext body, populated by ``get_message``.
        body_html:
            The full HTML body when present, populated by ``get_message``.
        attachments:
            Filenames of attachments (names only — content is not downloaded).
        pinned:
            ``True`` when the message has been pinned/flagged for importance.
    """

    id: str
    date: str
    sender: str
    subject: str
    unread: bool
    to: list[str] = field(default_factory=list)
    preview: str = ""
    body_text: str | None = None
    body_html: str | None = None
    attachments: list[str] = field(default_factory=list)
    pinned: bool = False

    def to_dict(self) -> dict:
        """Return a JSON-serialisable representation (for ``--raw``)."""
        return {
            "id": self.id,
            "date": self.date,
            "from": self.sender,
            "to": self.to,
            "subject": self.subject,
            "unread": self.unread,
            "preview": self.preview,
            "body_text": self.body_text,
            "body_html": self.body_html,
            "attachments": self.attachments,
            "pinned": self.pinned,
        }
