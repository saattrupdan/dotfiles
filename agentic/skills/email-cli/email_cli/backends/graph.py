"""Microsoft 365 backend via Microsoft Graph + MSAL device-code OAuth.

Corporate tenants disable basic IMAP/SMTP auth, so mail goes through Graph. The
default client is the public "Microsoft Graph Command Line Tools" app, which is
pre-consented in most tenants and needs no Azure app registration. If a tenant
blocks it, set a registered app's ``client_id`` on the account.

Auth state is an MSAL token cache persisted under ``~/.email-cli/<name>.msal.json``.
Graph HTTP calls use the standard library (``urllib``).
"""

from __future__ import annotations

import base64
import json
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from ..config import token_cache_path
from ..models import Message
from .base import BackendError

# Public first-party "Microsoft Graph Command Line Tools" client (used by the
# Microsoft Graph PowerShell SDK). Supports device-code flow for delegated scopes.
_DEFAULT_CLIENT_ID = "14d82eec-204b-4c2f-b7e8-296a70dab67e"
_SCOPES = ["Mail.Read", "Mail.Send", "Mail.ReadWrite"]
_GRAPH = "https://graph.microsoft.com/v1.0"
_FOLDER_ALIASES = {
    "inbox": "inbox",
    "sent": "sentitems",
    "drafts": "drafts",
    "spam": "junkemail",
    "junk": "junkemail",
    "trash": "deleteditems",
    "deleted": "deleteditems",
}


class GraphBackend:
    """Read and send Microsoft 365 mail through the Graph API."""

    def __init__(self, *, name: str, account: dict) -> None:
        self._name = name
        self._account = account
        self._email = account.get("email", "")
        self._cache_path: Path = token_cache_path(name)

    # -- MSAL plumbing -------------------------------------------------------

    def _build_app(self):
        """Construct an MSAL public-client app with a disk-backed token cache."""
        try:
            import msal
        except ImportError as exc:  # pragma: no cover - install-time guard
            raise BackendError(
                "The 'msal' package is required for Microsoft 365 accounts. "
                "Reinstall the skill: pipx install -e <path-to-email-cli>."
            ) from exc

        cache = msal.SerializableTokenCache()
        try:
            cache.deserialize(self._cache_path.read_text(encoding="utf-8"))
        except OSError:
            pass

        tenant = self._account.get("tenant", "organizations")
        client_id = self._account.get("client_id", _DEFAULT_CLIENT_ID)
        app = msal.PublicClientApplication(
            client_id,
            authority=f"https://login.microsoftonline.com/{tenant}",
            token_cache=cache,
        )
        return app, cache

    def _save_cache(self, cache) -> None:
        if cache.has_state_changed:
            self._cache_path.parent.mkdir(mode=0o700, exist_ok=True)
            self._cache_path.write_text(cache.serialize(), encoding="utf-8")
            self._cache_path.chmod(0o600)

    def _token(self) -> str:
        """Return a valid access token from the cache, refreshing silently."""
        app, cache = self._build_app()
        accounts = app.get_accounts()
        result = None
        if accounts:
            result = app.acquire_token_silent(_SCOPES, account=accounts[0])
        self._save_cache(cache)
        if not result or "access_token" not in result:
            raise BackendError(
                f"Not signed in for '{self._name}'. Run: email login --account "
                f"{self._name}"
            )
        return result["access_token"]

    def login(self) -> str:
        """Run the device-code flow interactively and cache the token."""
        app, cache = self._build_app()
        flow = app.initiate_device_flow(scopes=_SCOPES)
        if "user_code" not in flow:
            raise BackendError(
                f"Could not start device-code login: {flow.get('error_description', flow)}"
            )
        # MSAL's message contains the URL and code; show it to the user.
        print(flow["message"], flush=True)
        result = app.acquire_token_by_device_flow(flow)
        self._save_cache(cache)
        if "access_token" not in result:
            err = result.get("error_description", result)
            raise BackendError(
                f"Login failed for {self._email}: {err}. If this is a consent or "
                "AADSTS error, the tenant may block the default client — register "
                "an Azure app and set its client_id on the account."
            )
        return f"Signed in to Microsoft 365 as {self._email}."

    # -- HTTP ----------------------------------------------------------------

    def _request(
        self,
        method: str,
        path: str,
        *,
        params: dict | None = None,
        body: dict | None = None,
    ) -> dict:
        url = f"{_GRAPH}{path}"
        if params:
            url += "?" + urllib.parse.urlencode(params, quote_via=urllib.parse.quote)
        data = json.dumps(body).encode() if body is not None else None
        headers = {
            "Authorization": f"Bearer {self._token()}",
            "Accept": "application/json",
        }
        if data is not None:
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                raw = resp.read()
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode(errors="replace")
            raise BackendError(
                f"Graph {method} {path} failed: HTTP {exc.code} {exc.reason}. {detail}"
            ) from exc
        except urllib.error.URLError as exc:
            raise BackendError(f"Graph request failed: {exc}") from exc

    # -- read ----------------------------------------------------------------

    @staticmethod
    def _addr(recipient: dict | None) -> str:
        if not recipient:
            return ""
        box = recipient.get("emailAddress", {})
        name, addr = box.get("name", ""), box.get("address", "")
        return f"{name} <{addr}>" if name and name != addr else addr

    def list_messages(
        self, *, folder: str, query: str | None, unread_only: bool, limit: int
    ) -> list[Message]:
        mailbox = _FOLDER_ALIASES.get(folder.lower(), folder)
        params: dict[str, str] = {
            "$top": str(limit),
            "$select": "id,subject,from,toRecipients,receivedDateTime,isRead,bodyPreview",
        }
        if query:
            # $search cannot be combined with $orderby; otherwise sort newest first.
            params["$search"] = f'"{query}"'
        else:
            params["$orderby"] = "receivedDateTime desc"
            if unread_only:
                params["$filter"] = "isRead eq false"
        data = self._request(
            "GET", f"/me/mailFolders/{mailbox}/messages", params=params
        )
        messages = []
        for item in data.get("value", []):
            if query and unread_only and item.get("isRead", True):
                continue  # client-side filter when $search blocked $filter
            messages.append(self._to_message(item))
        return messages

    def _to_message(self, item: dict, *, body: str | None = None) -> Message:
        received = item.get("receivedDateTime", "")
        date = received.replace("T", " ")[:16] if received else ""
        return Message(
            id=item.get("id", ""),
            date=date,
            sender=self._addr(item.get("from")),
            subject=item.get("subject", ""),
            unread=not item.get("isRead", True),
            to=[self._addr(r) for r in item.get("toRecipients", [])],
            preview=item.get("bodyPreview", ""),
            body_text=body if body is not None else None,
        )

    def get_message(self, *, msg_id: str, mark_read: bool) -> Message:
        item = self._request(
            "GET",
            f"/me/messages/{urllib.parse.quote(msg_id)}",
            params={
                "$select": "id,subject,from,toRecipients,receivedDateTime,isRead,body,hasAttachments"
            },
        )
        body = item.get("body", {})
        content = body.get("content", "")
        is_html = body.get("contentType", "text").lower() == "html"
        message = self._to_message(item)
        if is_html:
            message.body_html = content
        else:
            message.body_text = content
        if item.get("hasAttachments"):
            att = self._request(
                "GET",
                f"/me/messages/{urllib.parse.quote(msg_id)}/attachments",
                params={"$select": "name"},
            )
            message.attachments = [a.get("name", "") for a in att.get("value", [])]
        if mark_read:
            self._request(
                "PATCH",
                f"/me/messages/{urllib.parse.quote(msg_id)}",
                body={"isRead": True},
            )
            message.unread = False
        return message

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
        def recips(addrs: list[str]) -> list[dict]:
            return [{"emailAddress": {"address": a}} for a in addrs]

        message: dict = {
            "subject": subject,
            "body": {"contentType": "Text", "content": body},
            "toRecipients": recips(to),
        }
        if cc:
            message["ccRecipients"] = recips(cc)
        if bcc:
            message["bccRecipients"] = recips(bcc)
        if attachments:
            message["attachments"] = [
                self._encode_attachment(path_str) for path_str in attachments
            ]
        self._request(
            "POST", "/me/sendMail", body={"message": message, "saveToSentItems": True}
        )

    @staticmethod
    def _encode_attachment(path_str: str) -> dict:
        path = Path(path_str)
        try:
            data = path.read_bytes()
        except OSError as exc:
            raise BackendError(f"Could not read attachment '{path_str}': {exc}")
        return {
            "@odata.type": "#microsoft.graph.fileAttachment",
            "name": path.name,
            "contentBytes": base64.b64encode(data).decode(),
        }
