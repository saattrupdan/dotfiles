"""Gmail API client wrapper."""

import base64
from email.mime.text import MIMEText

import google.auth
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError

from .auth import get_credentials, login

DEFAULT_LABELS = {
    "INBOX": "Inbox",
    "SENT": "Sent",
    "DRAFT": "Drafts",
    "SPAM": "Spam",
    "TRASH": "Trash",
    "UNREAD": "Unread",
    "STARRED": "Starred",
    "IMPORTANT": "Important",
}


class GmailClient:
    """Gmail API client."""

    def __init__(self) -> None:
        """Initialize Gmail client."""
        creds = get_credentials()
        if not creds:
            creds = login()
        self.service = build("gmail", "v1", credentials=creds)

    def list_messages(
        self,
        query: str | None = None,
        max_results: int = 10,
        label_ids: list[str] | None = None,
    ) -> list[dict]:
        """List messages matching query."""
        label_ids = label_ids or []
        try:
            response = self.service.users().messages().list(
                userId="me",
                q=query,
                labelIds=label_ids,
                maxResults=max_results,
            ).execute()
            messages = response.get("messages", [])
            # Fetch full details for each message
            results = []
            for msg in messages:
                full_msg = self.get_message(msg["id"])
                if full_msg:
                    results.append(full_msg)
            return results
        except HttpError as e:
            raise RuntimeError(f"Gmail API error: {e}") from e

    def get_message(self, message_id: str) -> dict | None:
        """Get full message details."""
        try:
            msg = self.service.users().messages().get(
                userId="me", id=message_id, format="full"
            ).execute()
            return msg
        except HttpError as e:
            raise RuntimeError(f"Gmail API error: {e}") from e

    def get_message_body(self, message: dict) -> str:
        """Extract body text from message."""
        payload = message.get("payload", {})
        parts = payload.get("parts", [])

        # Multipart message
        if parts:
            for part in parts:
                mime_type = part.get("mimeType", "")
                if mime_type == "text/plain":
                    data = part.get("body", {}).get("data", "")
                    if data:
                        return self._decode_base64(data)
                elif mime_type == "multipart/alternative":
                    # Recurse into nested parts
                    for subpart in part.get("parts", []):
                        if subpart.get("mimeType") == "text/plain":
                            data = subpart.get("body", {}).get("data", "")
                            if data:
                                return self._decode_base64(data)
        # Simple message
        elif payload.get("mimeType") == "text/plain":
            data = payload.get("body", {}).get("data", "")
            if data:
                return self._decode_base64(data)

        return ""

    def _decode_base64(self, data: str) -> str:
        """Decode URL-safe base64."""
        # Gmail uses URL-safe base64 with padding sometimes omitted
        data = data.replace("-", "+").replace("_", "/")
        # Add padding if needed
        padding = 4 - len(data) % 4
        if padding != 4:
            data += "=" * padding
        return base64.b64decode(data).decode("utf-8", errors="replace")

    def send_message(
        self, to: str, subject: str, body: str, cc: str | None = None
    ) -> dict:
        """Send an email."""
        message = self._create_message(to, subject, body, cc)
        try:
            sent = self.service.users().messages().send(
                userId="me", body=message
            ).execute()
            return sent
        except HttpError as e:
            raise RuntimeError(f"Failed to send message: {e}") from e

    def _create_message(
        self, to: str, subject: str, body: str, cc: str | None = None
    ) -> dict:
        """Create MIME message."""
        message = MIMEText(body)
        message["to"] = to
        message["from"] = "me"
        message["subject"] = subject
        if cc:
            message["cc"] = cc
        raw = base64.urlsafe_b64encode(message.as_bytes()).decode()
        return {"raw": raw}

    def create_draft(
        self, to: str, subject: str, body: str, cc: str | None = None
    ) -> dict:
        """Create a draft message."""
        message = self._create_message(to, subject, body, cc)
        try:
            draft = self.service.users().drafts().create(
                userId="me", body={"message": message}
            ).execute()
            return draft
        except HttpError as e:
            raise RuntimeError(f"Failed to create draft: {e}") from e

    def list_drafts(self, max_results: int = 10) -> list[dict]:
        """List draft messages."""
        try:
            response = self.service.users().drafts().list(
                userId="me", maxResults=max_results
            ).execute()
            drafts = response.get("drafts", [])
            results = []
            for draft in drafts:
                full_draft = self.service.users().drafts().get(
                    userId="me", id=draft["id"], format="full"
                ).execute()
                results.append(full_draft)
            return results
        except HttpError as e:
            raise RuntimeError(f"Gmail API error: {e}") from e

    def get_draft(self, draft_id: str) -> dict:
        """Get a specific draft."""
        try:
            return self.service.users().drafts().get(
                userId="me", id=draft_id, format="full"
            ).execute()
        except HttpError as e:
            raise RuntimeError(f"Gmail API error: {e}") from e

    def delete_draft(self, draft_id: str) -> None:
        """Delete a draft."""
        try:
            self.service.users().drafts().delete(userId="me", id=draft_id).execute()
        except HttpError as e:
            raise RuntimeError(f"Failed to delete draft: {e}") from e

    def delete_message(self, message_id: str) -> None:
        """Delete a message permanently."""
        try:
            self.service.users().messages().delete(userId="me", id=message_id).execute()
        except HttpError as e:
            raise RuntimeError(f"Failed to delete message: {e}") from e

    def trash_message(self, message_id: str) -> dict:
        """Move message to trash."""
        try:
            return self.service.users().messages().trash(
                userId="me", id=message_id
            ).execute()
        except HttpError as e:
            raise RuntimeError(f"Failed to trash message: {e}") from e

    def spam_message(self, message_id: str) -> dict:
        """Report message as spam."""
        try:
            return self.service.users().messages().spam(
                userId="me", id=message_id
            ).execute()
        except HttpError as e:
            raise RuntimeError(f"Failed to mark as spam: {e}") from e

    def archive_message(self, message_id: str) -> dict:
        """Archive a message (remove INBOX label)."""
        try:
            return self.service.users().messages().modify(
                userId="me", id=message_id, body={"removeLabelIds": ["INBOX"]}
            ).execute()
        except HttpError as e:
            raise RuntimeError(f"Failed to archive message: {e}") from e

    def mark_unread(self, message_id: str) -> dict:
        """Mark message as unread."""
        try:
            return self.service.users().messages().modify(
                userId="me", id=message_id, body={"removeLabelIds": ["UNREAD"]}
            ).execute()
        except HttpError as e:
            raise RuntimeError(f"Failed to mark as unread: {e}") from e

    def mark_read(self, message_id: str) -> dict:
        """Mark message as read."""
        try:
            return self.service.users().messages().modify(
                userId="me", id=message_id, body={"removeLabelIds": ["UNREAD"]}
            ).execute()
        except HttpError as e:
            raise RuntimeError(f"Failed to mark as read: {e}") from e

    def star_message(self, message_id: str) -> dict:
        """Star a message."""
        try:
            return self.service.users().messages().modify(
                userId="me", id=message_id, body={"addLabelIds": ["STARRED"]}
            ).execute()
        except HttpError as e:
            raise RuntimeError(f"Failed to star message: {e}") from e

    def unstar_message(self, message_id: str) -> dict:
        """Unstar a message."""
        try:
            return self.service.users().messages().modify(
                userId="me", id=message_id, body={"removeLabelIds": ["STARRED"]}
            ).execute()
        except HttpError as e:
            raise RuntimeError(f"Failed to unstar message: {e}") from e

    def add_label(self, message_id: str, label_id: str) -> dict:
        """Add a label to a message."""
        try:
            return self.service.users().messages().modify(
                userId="me", id=message_id, body={"addLabelIds": [label_id]}
            ).execute()
        except HttpError as e:
            raise RuntimeError(f"Failed to add label: {e}") from e

    def remove_label(self, message_id: str, label_id: str) -> dict:
        """Remove a label from a message."""
        try:
            return self.service.users().messages().modify(
                userId="me", id=message_id, body={"removeLabelIds": [label_id]}
            ).execute()
        except HttpError as e:
            raise RuntimeError(f"Failed to remove label: {e}") from e

    def list_labels(self) -> list[dict]:
        """List all labels."""
        try:
            response = self.service.users().labels().list(userId="me").execute()
            return response.get("labels", [])
        except HttpError as e:
            raise RuntimeError(f"Gmail API error: {e}") from e

    def create_label(self, name: str) -> dict:
        """Create a new label."""
        try:
            return self.service.users().labels().create(
                userId="me", body={"name": name}
            ).execute()
        except HttpError as e:
            raise RuntimeError(f"Failed to create label: {e}") from e
