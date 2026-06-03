"""Outlook-on-the-web backend driven through ``agent-browser``.

Used for Microsoft 365 accounts whose tenant blocks OAuth/Graph user consent
(e.g. alexandra.dk). Instead of an API token, it reuses the user's own
authenticated ``outlook.office.com`` browser session: every mailbox operation is
a same-origin ``fetch()`` to OWA's internal EWS-JSON endpoint
(``/owa/service.svc``), executed *inside* the logged-in page via
``agent-browser eval`` so the session cookies and ``X-OWA-CANARY`` CSRF token are
applied automatically.

⚠️  The EWS-JSON request shapes below are based on OWA's undocumented internal
protocol and are version-sensitive. They are a best-effort starting point and may
need tweaking against a live mailbox — when an operation fails, the raw OWA
response is surfaced in the error to make that iteration quick. A handy way to
capture the exact request the real OWA UI sends (to copy its shape) is to wrap
``window.fetch`` via ``agent-browser eval`` and then perform the action in the UI.
"""

from __future__ import annotations

import json
import time

from ..browser import BrowserSession
from ..config import CONFIG_DIR
from ..credentials import get_outlook_credentials
from ..models import Message
from .base import BackendError

_MAIL_URL = "https://outlook.office.com/mail/"

# Folder aliases → EWS distinguished folder ids.
_FOLDER_ALIASES = {
    "inbox": "inbox",
    "sent": "sentitems",
    "drafts": "drafts",
    "spam": "junkemail",
    "junk": "junkemail",
    "trash": "deleteditems",
    "deleted": "deleteditems",
    "archive": "archive",
}

# Shared EWS request header (JSON form OWA uses on service.svc).
_HEADER = {
    "__type": "JsonRequestHeaders:#Exchange",
    "RequestServerVersion": "Exchange2013",
    "TimeZoneContext": {
        "__type": "TimeZoneContext:#Exchange",
        "TimeZoneDefinition": {
            "__type": "TimeZoneDefinitionType:#Exchange",
            "Id": "UTC",
        },
    },
}

# JS run inside the authenticated page. Posts an EWS-JSON body to service.svc with
# the CSRF canary read from the cookie, and returns a JSON envelope we can inspect.
# __ACTION__ / __BODY__ are substituted in Python (str.replace, not .format, to
# avoid clashing with the literal braces in the JS).
_FETCH_JS = r"""
(async () => {
  const m = document.cookie.match(/(?:^|;\s*)X-OWA-CANARY=([^;]+)/);
  const canary = m ? decodeURIComponent(m[1]) : "";
  const body = __BODY__;
  let resp, text;
  try {
    resp = await fetch("/owa/service.svc?action=__ACTION__&app=Mail", {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Accept": "application/json",
        "Action": "__ACTION__",
        "X-OWA-CANARY": canary,
        "X-Req-Source": "Mail"
      },
      body: JSON.stringify(body)
    });
    text = await resp.text();
  } catch (e) {
    return JSON.stringify({ ok: false, status: 0, canary: !!canary, error: String(e) });
  }
  let data = null;
  try { data = JSON.parse(text); } catch (e) { data = null; }
  return JSON.stringify({
    ok: resp.ok,
    status: resp.status,
    canary: !!canary,
    data: data,
    raw: data ? undefined : (text || "").slice(0, 400)
  });
})()
"""


class OwaBackend:
    """Read and send Microsoft 365 mail by driving Outlook on the web."""

    def __init__(self, *, name: str, account: dict) -> None:
        self._name = name
        self._account = account
        self._email = account.get("email", "")
        self._browser = BrowserSession(
            session_name=f"email-{name}",
            state_path=CONFIG_DIR / f"{name}.owa-state.json",
        )

    # -- login ---------------------------------------------------------------

    def _extract_mfa_code(self) -> str | None:
        """Extract MFA code from Microsoft login page using browser eval."""
        js_extract = r"""
        (() => {
            const allText = (document.body.innerText || '').trim();
            const lines = allText.split(/\n/).map(l => l.trim()).filter(l => l);
            
            // Strategy 1: Look for lines that are just 2-digit numbers
            for (const line of lines) {
                if (/^\d{2}$/.test(line)) return line;
            }
            
            // Fallback: any 2-digit number
            const allNumbers = allText.match(/\b(\d{2})\b/g);
            if (allNumbers) return allNumbers[0];
            
            return null;
        })()
        """
        try:
            js_wrapper = "JSON.stringify((async()=>(" + js_extract + "))())"
            eval_result = self._browser.eval_json(js_wrapper)
            return eval_result if eval_result else None
        except Exception:
            return None

    def _wait_for_snapshot(self, *, interval: float = 2.0, timeout: int = 30) -> None:
        """Wait for page to load by polling snapshot."""
        start = time.time()
        while time.time() - start < timeout:
            time.sleep(interval)
            try:
                snapshot = self._browser._run("snapshot", "-i")
                if snapshot and snapshot.strip():
                    return
            except Exception:
                pass

    def verify_and_save_session(self, *, timeout: int = 120) -> str:
        """Poll for inbox URL + X-OWA-CANARY cookie, then save session.

        Args:
            timeout:
                Maximum seconds to wait for login completion. Defaults to 120.

        Returns:
            Success message with elapsed time.

        Raises:
            BackendError:
                If login times out.
        """
        interval = 2
        elapsed = 0

        while elapsed < timeout:
            time.sleep(interval)
            elapsed += interval

            probe = self._browser.eval_json(
                "(async()=>JSON.stringify({"
                "url:location.href,"
                "canary:/X-OWA-CANARY=/.test(document.cookie),"
                "inbox:/mail/i.test(location.href)"
                "}))()"
            )
            url = (probe or {}).get("url", "")
            has_canary = (probe or {}).get("canary", False)
            is_inbox = (probe or {}).get("inbox", False)

            # Success: inbox loaded + canary present
            if is_inbox and has_canary:
                self._browser.state_save()
                return f"Signed in to Outlook on the web as {self._email} ({elapsed}s, session saved)."

            # Still on login page - keep waiting
            if "login.microsoftonline.com" in url:
                continue

            # On some other page (e.g., redirect in progress) - keep waiting
            if not has_canary:
                continue

        raise BackendError(
            f"OWA login timed out after {timeout}s. "
            "Retry or check that MFA was approved."
        )

    def login(self) -> str:
        """Perform complete automated login flow.

        1. Gets credentials from keychain
        2. Navigates to Outlook and fills login form
        3. Completes MFA with number-match
        4. Saves session state

        Returns:
            Success message with account email.

        Raises:
            BackendError: If login fails at any step.
        """
        # Get credentials
        username, password = get_outlook_credentials()
        if not username:
            username = self._email
        if not password:
            raise BackendError(
                f"No password found for {self._email}. "
                "Add it to macOS Keychain: security add-generic-password -s 'outlook' -a 'password' -w 'YOUR_PASSWORD'"
            )

        # Navigate to Outlook
        self._browser.open(_MAIL_URL, headed=False)
        self._wait_for_snapshot(timeout=10)

        # Step 1: Enter email
        self._browser._run("fill", "@e6", username)
        self._browser._run("click", "@e9")
        self._wait_for_snapshot(timeout=10)

        # Step 2: Enter password
        self._browser._run("fill", "@e6", password)
        self._browser._run("click", "@e9")
        self._wait_for_snapshot(timeout=10)

        # Step 3: Select MFA method (Microsoft Authenticator)
        self._browser._run("click", "@e10")  # "Approve a request on my Microsoft Authenticator app"
        self._wait_for_snapshot(timeout=10)

        # Step 4: Extract MFA code
        mfa_code = None
        for _ in range(15):  # Poll for 30 seconds
            time.sleep(2)
            mfa_code = self._extract_mfa_code()
            if mfa_code:
                break

        if not mfa_code:
            raise BackendError(
                "MFA code not detected. Make sure your account uses number-match MFA."
            )

        # Tell user to approve
        print(f"\nMFA code: {mfa_code}")
        print("Enter this code in Microsoft Authenticator and approve the request.")
        print("Once approved, the login will complete automatically...")

        # Step 5: Wait for MFA approval
        max_wait = 120
        interval = 2
        elapsed = 0

        while elapsed < max_wait:
            time.sleep(interval)
            elapsed += interval

            probe = self._browser.eval_json(
                "(async()=>JSON.stringify({"
                "url:location.href,"
                "canary:/X-OWA-CANARY=/.test(document.cookie),"
                "inbox:/mail/i.test(location.href)"
                "}))()"
            )
            has_canary = (probe or {}).get("canary", False)
            is_inbox = (probe or {}).get("inbox", False)

            # MFA approved - check for "Stay signed in?" prompt
            if is_inbox or has_canary:
                break

            # Check if we're on "Stay signed in?" page
            snapshot = self._browser._run("snapshot", "-i")
            if "Stay signed in" in snapshot:
                # Click Yes to stay signed in
                try:
                    self._browser._run("click", "@e8")
                    time.sleep(3)
                    break
                except Exception:
                    pass

        # Final check and save
        probe = self._browser.eval_json(
            "(async()=>JSON.stringify({"
            "url:location.href,"
            "canary:/X-OWA-CANARY=/.test(document.cookie),"
            "inbox:/mail/i.test(location.href)"
            "}))()"
        )
        has_canary = (probe or {}).get("canary", False)
        is_inbox = (probe or {}).get("inbox", False)

        if not (is_inbox or has_canary):
            raise BackendError(
                f"Login timed out after {elapsed}s. MFA may not have been approved."
            )

        # Handle "Stay signed in?" if still showing
        snapshot = self._browser._run("snapshot", "-i")
        if "Stay signed in" in snapshot:
            try:
                self._browser._run("click", "@e8")
                time.sleep(3)
            except Exception:
                pass

        # Save session
        self._browser.state_save()

        return f"Signed in to Outlook on the web as {self._email} (session saved)."

    # -- request plumbing ----------------------------------------------------

    def _request(self, action: str, body: dict) -> dict:
        """Run an EWS-JSON request inside the authenticated page; return its data."""
        self._browser.open(_MAIL_URL)
        self._browser.wait_load()
        js = _FETCH_JS.replace("__ACTION__", action).replace(
            "__BODY__", json.dumps(body)
        )
        env = self._browser.eval_json(js)
        if not env:
            raise BackendError(f"OWA {action}: empty response from the browser.")
        if env.get("status") in (401, 440) or not env.get("canary"):
            raise BackendError(
                f"Not signed in for '{self._name}' (OWA returned "
                f"{env.get('status')}). Run: email login --account {self._name}"
            )
        if not env.get("ok") or env.get("data") is None:
            detail = env.get("error") or env.get("raw") or env
            raise BackendError(
                f"OWA {action} failed (HTTP {env.get('status')}). Response: {detail}"
            )
        return env["data"]

    @staticmethod
    def _response_messages(data: dict, action: str) -> list[dict]:
        """Pull the ResponseMessages.Items array, surfacing EWS-level errors."""
        try:
            items = data["Body"]["ResponseMessages"]["Items"]
        except (KeyError, TypeError) as exc:
            raise BackendError(
                f"Unexpected OWA {action} response shape: {json.dumps(data)[:500]}"
            ) from exc
        for msg in items:
            if msg.get("ResponseClass") == "Error":
                raise BackendError(
                    f"OWA {action} error: {msg.get('MessageText', 'unknown error')}"
                )
        return items

    # -- helpers -------------------------------------------------------------

    @staticmethod
    def _additional_props(*field_uris: str) -> list[dict]:
        return [
            {"__type": "PropertyUri:#Exchange", "FieldURI": uri} for uri in field_uris
        ]

    @staticmethod
    def _mailbox_str(mailbox: dict | None) -> str:
        if not mailbox:
            return ""
        box = mailbox.get("Mailbox", mailbox)
        name, addr = box.get("Name", ""), box.get("EmailAddress", "")
        return f"{name} <{addr}>" if name and name != addr else (addr or name)

    @staticmethod
    def _fmt_date(value: str) -> str:
        return value.replace("T", " ")[:16] if value else ""

    def _to_message(self, item: dict) -> Message:
        return Message(
            id=(item.get("ItemId") or {}).get("Id", ""),
            date=self._fmt_date(item.get("DateTimeReceived", "")),
            sender=self._mailbox_str(item.get("From")),
            subject=item.get("Subject", ""),
            unread=not item.get("IsRead", True),
            to=[self._mailbox_str(r) for r in (item.get("ToRecipients") or [])],
        )

    # -- read ----------------------------------------------------------------

    def list_messages(
        self, *, folder: str, query: str | None, unread_only: bool, limit: int
    ) -> list[Message]:
        mailbox = _FOLDER_ALIASES.get(folder.lower(), folder.lower())
        find: dict = {
            "__type": "FindItemRequest:#Exchange",
            "ItemShape": {
                "__type": "ItemResponseShape:#Exchange",
                "BaseShape": "IdOnly",
                "AdditionalProperties": self._additional_props(
                    "item:Subject",
                    "message:From",
                    "item:DateTimeReceived",
                    "message:IsRead",
                ),
            },
            "ParentFolderIds": [
                {"__type": "DistinguishedFolderId:#Exchange", "Id": mailbox}
            ],
            "Traversal": "Shallow",
            "Paging": {
                "__type": "IndexedPageView:#Exchange",
                "BasePoint": "Beginning",
                "Offset": 0,
                "MaxEntriesReturned": limit,
            },
            "SortOrder": [
                {
                    "__type": "SortResults:#Exchange",
                    "Order": "Descending",
                    "Path": {
                        "__type": "PropertyUri:#Exchange",
                        "FieldURI": "item:DateTimeReceived",
                    },
                }
            ],
        }
        if query:
            find["QueryString"] = {
                "__type": "QueryStringType:#Exchange",
                "Value": query,
            }
        if unread_only:
            find["Restriction"] = {
                "__type": "Restriction:#Exchange",
                "Item": {
                    "__type": "IsEqualTo:#Exchange",
                    "Item": {
                        "__type": "PropertyUri:#Exchange",
                        "FieldURI": "message:IsRead",
                    },
                    "FieldURIOrConstant": {
                        "__type": "FieldURIOrConstantType:#Exchange",
                        "Item": {
                            "__type": "Constant:#Exchange",
                            "Value": "false",
                        },
                    },
                },
            }
        body = {
            "__type": "FindItemJsonRequest:#Exchange",
            "Header": _HEADER,
            "Body": find,
        }
        data = self._request("FindItem", body)
        items = self._response_messages(data, "FindItem")
        root = (items[0] or {}).get("RootFolder", {}) if items else {}
        return [self._to_message(it) for it in (root.get("Items") or [])]

    def get_message(self, *, msg_id: str, mark_read: bool) -> Message:
        body = {
            "__type": "GetItemJsonRequest:#Exchange",
            "Header": _HEADER,
            "Body": {
                "__type": "GetItemRequest:#Exchange",
                "ItemShape": {
                    "__type": "ItemResponseShape:#Exchange",
                    "BaseShape": "IdOnly",
                    "BodyType": "Text",
                    "AdditionalProperties": self._additional_props(
                        "item:Subject",
                        "message:From",
                        "message:ToRecipients",
                        "item:DateTimeReceived",
                        "item:Body",
                        "item:HasAttachments",
                        "item:Attachments",
                    ),
                },
                "ItemIds": [{"__type": "ItemId:#Exchange", "Id": msg_id}],
            },
        }
        data = self._request("GetItem", body)
        items = self._response_messages(data, "GetItem")
        inner = (items[0] or {}).get("Items") if items else None
        if not inner:
            raise BackendError(f"Message '{msg_id}' not found.")
        item = inner[0]
        message = self._to_message(item)
        body_obj = item.get("Body") or {}
        text = body_obj.get("Value", "")
        if (body_obj.get("BodyType") or "").lower() == "html":
            message.body_html = text
        else:
            message.body_text = text
        message.attachments = [
            a.get("Name", "") for a in (item.get("Attachments") or []) if a.get("Name")
        ]
        if mark_read and message.unread:
            self._mark_read(item.get("ItemId") or {})
            message.unread = False
        return message

    def _mark_read(self, item_id: dict) -> None:
        body = {
            "__type": "UpdateItemJsonRequest:#Exchange",
            "Header": _HEADER,
            "Body": {
                "__type": "UpdateItemRequest:#Exchange",
                "ConflictResolution": "AlwaysOverwrite",
                "MessageDisposition": "SaveOnly",
                "ItemChanges": [
                    {
                        "__type": "ItemChange:#Exchange",
                        "ItemId": {
                            "__type": "ItemId:#Exchange",
                            "Id": item_id.get("Id", ""),
                            "ChangeKey": item_id.get("ChangeKey", ""),
                        },
                        "Updates": [
                            {
                                "__type": "SetItemField:#Exchange",
                                "Path": {
                                    "__type": "PropertyUri:#Exchange",
                                    "FieldURI": "message:IsRead",
                                },
                                "Item": {
                                    "__type": "Message:#Exchange",
                                    "IsRead": True,
                                },
                            }
                        ],
                    }
                ],
            },
        }
        data = self._request("UpdateItem", body)
        self._response_messages(data, "UpdateItem")

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
        if attachments:
            raise BackendError(
                "The OWA backend does not support attachments yet. Send without "
                "--attach, or use a Gmail/IMAP account for attachments."
            )

        def recipients(addrs: list[str]) -> list[dict]:
            return [
                {
                    "__type": "SingleRecipientType:#Exchange",
                    "Mailbox": {
                        "__type": "EmailAddressType:#Exchange",
                        "EmailAddress": addr,
                    },
                }
                for addr in addrs
            ]

        message: dict = {
            "__type": "Message:#Exchange",
            "Subject": subject,
            "Body": {
                "__type": "BodyContentType:#Exchange",
                "BodyType": "Text",
                "Value": body,
            },
            "ToRecipients": recipients(to),
        }
        if cc:
            message["CcRecipients"] = recipients(cc)
        if bcc:
            message["BccRecipients"] = recipients(bcc)

        req = {
            "__type": "CreateItemJsonRequest:#Exchange",
            "Header": _HEADER,
            "Body": {
                "__type": "CreateItemRequest:#Exchange",
                "MessageDisposition": "SendAndSaveCopy",
                "Items": {
                    "__type": "NonEmptyArrayOfAllItemsType:#Exchange",
                    "Items": [message],
                },
            },
        }
        data = self._request("CreateItem", req)
        self._response_messages(data, "CreateItem")
