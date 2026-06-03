"""Backend protocol shared by the IMAP/SMTP and Graph implementations."""

from __future__ import annotations

from typing import Protocol, runtime_checkable

from ..models import Message


class BackendError(Exception):
    """Raised for any backend failure (auth, network, provider error)."""


@runtime_checkable
class Backend(Protocol):
    """A mail transport for one account.

    Implementations connect lazily — ``login`` is the only method that must be
    called explicitly (by ``email login``); the read/send methods establish
    whatever connection they need on demand.
    """

    def login(self) -> str:
        """Authenticate and persist any reusable session/token.

        Returns:
            A short human-readable status line (e.g. the signed-in address).

        Raises:
            BackendError:
                If authentication fails.
        """
        ...

    def verify_and_save_session(self) -> str:
        """Complete the second step of a two-factor login flow.

        Returns:
            A short human-readable confirmation (e.g. session saved).

        Raises:
            BackendError:
                If verification fails or times out.
        """
        ...

    def list_messages(
        self,
        *,
        folder: str,
        query: str | None,
        unread_only: bool,
        limit: int,
    ) -> list[Message]:
        """Return the most recent messages in ``folder`` (newest first).

        ``body_text``/``body_html`` are typically left unpopulated here; call
        :meth:`get_message` for full content.
        """
        ...

    def get_message(self, *, msg_id: str, mark_read: bool) -> Message:
        """Fetch a single message in full, optionally marking it read."""
        ...

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
        """Send a plaintext message with optional file attachments."""
        ...
