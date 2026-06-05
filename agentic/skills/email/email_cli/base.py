"""Backend protocol for the OWA implementation."""

from __future__ import annotations

from typing import Protocol, runtime_checkable

from .models import Message


class BackendError(Exception):
    """Raised for any backend failure (auth, network, provider error)."""


@runtime_checkable
class Backend(Protocol):
    """A mail transport for one account.

    Implementations connect lazily — ``login`` is the only method that must be
    called explicitly (by ``email login``); the read/send methods establish
    whatever connection they need on demand.

    Support for pinning messages is optional; implementations that do not
    support pinning should raise :exc:`BackendError` from :meth:`pin_message`
    and :meth:`unpin_message`.
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
        pinned_only: bool = False,
        limit: int,
    ) -> list[Message]:
        """Return the most recent messages in ``folder`` (newest first).

        ``body_text``/``body_html`` are typically left unpopulated here; call
        :meth:`get_message` for full content.

        Args:
            folder:
                Mail folder to search.
            query:
                Optional search query (provider-specific syntax).
            unread_only:
                Whether to return only unread messages.
            pinned_only (optional):
                Whether to return only pinned messages. Defaults to False.
            limit:
                Maximum number of messages to return.

        Returns:
            List of messages, ordered newest first.
        """
        ...

    def get_message(
        self, *, msg_id: str, mark_read: bool, folder: str = "inbox"
    ) -> Message:
        """Fetch a single message in full, optionally marking it read.

        Args:
            msg_id:
                Provider-specific message identifier.
            mark_read:
                Whether to mark the message as read.
            folder (optional):
                Mail folder containing the message. Defaults to "inbox".

        Returns:
            The full message object.
        """
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
        """Send a plaintext message with optional file attachments.

        Args:
            to:
                Primary recipients.
            cc:
                Carbon copy recipients.
            bcc:
                Blind carbon copy recipients.
            subject:
                Message subject line.
            body:
                Plaintext message body.
            attachments:
                List of file paths to attach.
        """
        ...

    def pin_message(self, *, msg_id: str, folder: str) -> None:
        """Pin a message to the top of its folder.

        Args:
            msg_id:
                Provider-specific message identifier.
            folder:
                Mail folder containing the message.

        Raises:
            BackendError:
                If the operation fails or pinning is not supported.
        """
        ...

    def unpin_message(self, *, msg_id: str, folder: str) -> None:
        """Remove a pin from a message.

        Args:
            msg_id:
                Provider-specific message identifier.
            folder:
                Mail folder containing the message.

        Raises:
            BackendError:
                If the operation fails or pinning is not supported.
        """
        ...
