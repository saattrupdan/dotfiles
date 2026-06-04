"""Outlook-on-the-web backend driven through ``agent-browser``.

Used for Microsoft 365 accounts (e.g. alexandra.dk). Instead of API access, it
reuses the user's own authenticated ``outlook.office.com`` browser session:
every mailbox operation is a same-origin ``fetch()`` to OWA's internal
EWS-JSON endpoint (``/owa/service.svc``), executed *inside* the logged-in page
via ``agent-browser eval`` so the session cookies and ``X-OWA-CANARY`` CSRF
token are applied automatically.

⚠️  The EWS-JSON request shapes below are based on OWA's undocumented internal
protocol and are version-sensitive. They are a best-effort starting point and may
need tweaking against a live mailbox — when an operation fails, the raw OWA
response is surfaced in the error to make that iteration quick. A handy way to
capture the exact request the real OWA UI sends (to copy its shape) is to wrap
``window.fetch`` via ``agent-browser eval`` and then perform the action in the UI.
"""

from __future__ import annotations

import json as _json
import re
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

    def _check_validation_errors(self) -> dict:
        """Check for inline validation errors in compose form.

        Scans the compose dialog for validation error indicators:
        - Invalid/unresolved recipients (aria-invalid="true")
        - Error message containers near recipient fields
        - Missing subject validation
        - Network/permission error banners

        Returns:
            Dict with "has_errors" bool and "errors" list of strings.
        """
        check_js = r"""
        (() => {
            const errors = [];
            
            // Check for aria-invalid="true" on any input
            const invalidFields = document.querySelectorAll('[aria-invalid="true"]');
            invalidFields.forEach(field => {
                const label = field.getAttribute('aria-label') || field.placeholder || 'Field';
                errors.push(`Invalid field: ${label}`);
            });
            
            // Check for error message containers (common OWA error selectors)
            const errorMessages = document.querySelectorAll(
                '.error-message, [data-autoid*="error"], .ms-Text--error, \
                [role="alert"], .validation-error, .recipient-error'
            );
            errorMessages.forEach(el => {
                const text = el.textContent?.trim();
                if (text && !errors.includes(text)) {
                    errors.push(text);
                }
            });
            
            // Check for unresolved recipients (red underline or error styling)
            const unresolvedRecipients = document.querySelectorAll(
                '.recipient-token-unresolved, [class*="unresolved"], \
                [class*="invalid-recipient"]'
            );
            unresolvedRecipients.forEach(el => {
                const text = el.textContent?.trim() || 'unresolved recipient';
                errors.push(`Unresolved recipient: ${text}`);
            });
            
            // Check for network/permission error banners
            const errorBanners = document.querySelectorAll(
                '.ms-MessageBanner--error, [data-autoid*="error-banner"], \
                .error-banner, .notification-error'
            );
            errorBanners.forEach(banner => {
                const text = banner.textContent?.trim();
                if (text && !errors.includes(text)) {
                    errors.push(text);
                }
            });
            
            return { has_errors: errors.length > 0, errors };
        })()
        """
        try:
            js_wrapper = "JSON.stringify((async()=>(" + check_js + "))())"
            result = self._browser.eval_json(js_wrapper)
            return result if result else {"has_errors": False, "errors": []}
        except Exception:
            return {"has_errors": False, "errors": []}

    def _check_compose_state(self) -> dict:
        """Check compose dialog and send status.

        Checks:
        - Whether compose dialog is still open
        - Whether "Message sent" toast notification appeared

        Returns:
            Dict with "compose_open" bool, "message_sent" bool, and "error" str or None.
        """
        state_js = r"""
        (() => {
            const result = {
                compose_open: false,
                message_sent: false,
                error: null
            };
            
            // Check if compose dialog exists (OWA compose window selectors)
            const composeDialog = document.querySelector(
                '[role="dialog"][aria-label*="New message"], \
                [data-autoid*="compose"], .compose-window, \
                [class*="compose"], form[aria-label*="Message"]'
            );
            result.compose_open = composeDialog !== null;
            
            // Check for "Message sent" toast notification
            const toastNotifications = document.querySelectorAll(
                '.ms-Toast, [data-autoid*="toast"], .notification-toast, \
                [role="status"], .ms-MessageBanner'
            );
            for (const toast of toastNotifications) {
                const text = toast.textContent?.toLowerCase() || '';
                if (text.includes('message sent') || text.includes('sent')) {
                    result.message_sent = true;
                    break;
                }
            }
            
            // Check for error toasts as well
            const errorToasts = document.querySelectorAll(
                '.ms-Toast--error, [class*="error-toast"], \
                .toast-error, .notification-error'
            );
            for (const toast of errorToasts) {
                const text = toast.textContent?.trim();
                if (text) {
                    result.error = text;
                    break;
                }
            }
            
            return result;
        })()
        """
        try:
            js_wrapper = "JSON.stringify((async()=>(" + state_js + "))())"
            result = self._browser.eval_json(js_wrapper)
            return result if result else {
                "compose_open": False,
                "message_sent": False,
                "error": None
            }
        except Exception:
            return {
                "compose_open": False,
                "message_sent": False,
                "error": "Failed to check compose state"
            }

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

    def login(self, password: str | None = None) -> str:
        """Perform complete automated login flow.

        1. Gets credentials from keychain (or uses provided password)
        2. Navigates to Outlook and fills login form
        3. Completes MFA with number-match
        4. Saves session state

        Args:
            password:
                Optional password provided directly (for non-interactive/agent use).
                If not provided, fetched from password manager.

        Returns:
            Success message with account email.

        Raises:
            BackendError: If login fails at any step.
        """
        # Get credentials
        username, stored_password = get_outlook_credentials()
        if not username:
            username = self._email

        # Use provided password if given, otherwise use stored one
        if password is None:
            password = stored_password

        if not password:
            raise BackendError(
                f"No password found for {self._email}. "
                "Add it to macOS Keychain: "
                "security add-generic-password -s 'outlook' -a 'password' -w 'YOUR_PASSWORD'"
            )

        # Navigate to Outlook - will redirect to login if not authenticated
        self._browser.open(_MAIL_URL, headed=False)
        self._wait_for_snapshot(timeout=10)

        # Step 1: Enter email/username
        self._browser._run("fill", "@e6", username)
        self._browser._run("click", "@e9")
        self._wait_for_snapshot(timeout=10)

        # Step 2: Enter password
        self._browser._run("fill", "@e6", password)
        self._browser._run("click", "@e9")
        self._wait_for_snapshot(timeout=10)

        # Step 3: Select MFA method (Microsoft Authenticator)
        self._browser._run(
            "click", "@e10"
        )  # "Approve a request on my Microsoft Authenticator app"
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

    # -- DOM-based email reading --------------------------------------------

    def _navigate_to_folder(self, folder: str) -> None:
        """Navigate to a mail folder and wait for it to load."""
        folder_paths = {
            "inbox": "/mail/inbox",
            "sent": "/mail/sentitems",
            "drafts": "/mail/drafts",
            "spam": "/mail/junkemail",
            "junk": "/mail/junkemail",
            "trash": "/mail/deleteditems",
            "deleted": "/mail/deleteditems",
            "archive": "/mail/archive",
        }
        path = folder_paths.get(folder.lower(), f"/mail/{folder.lower()}")
        url = f"https://outlook.office.com{path}"

        self._browser.open(url, headed=False)
        self._wait_for_snapshot(timeout=10)

    def _parse_email_list_from_dom(self, limit: int) -> list[Message]:
        """Parse email list from the DOM accessibility tree.

        Extracts sender/subject from option element text using heuristics.
        """
        snapshot = self._browser._run("snapshot", timeout=30)

        messages = []
        lines = snapshot.split("\n") if snapshot else []

        def parse_sender_subject(text: str) -> tuple[str, str]:
            """Parse 'Sender Subject' from list view text."""
            # 1. Handle email sender
            if "@" in text:
                match = re.search(r"[\w.-]+@[\w.-]+\.[a-z]{2,}", text, re.IGNORECASE)
                if match:
                    sender = text[: match.end()].strip()
                    subject = text[match.end() :].strip()
                    return sender, subject

            # 2. Handle multi-sender (semicolons)
            if ";" in text:
                sender = text.split(";")[0].strip()
                rest = text.split(";", 1)[1] if ";" in text else ""
                # Find subject: skip additional senders
                parts = rest.split(";")
                last_part = parts[-1].strip() if parts else ""
                if "," in last_part:
                    subject_match = re.search(r",\s*[A-Za-zÀ-ÿ]+\s+(.+)", last_part)
                    if subject_match:
                        return sender, subject_match.group(1).strip()
                return sender, last_part

            # 3. Handle repeated name (e.g. "Torben Blach Torben Blach shared...")
            words = text.split()
            for i in range(2, len(words) // 2 + 1):
                first = " ".join(words[:i])
                second = " ".join(words[i : i * 2])
                if first == second:
                    return first, " ".join(words[i:])

            # 4. Check for "Last, First" pattern
            if "," in text and len(words) >= 3:
                if re.match(r"^[A-Z][a-z]+,\s+[A-Z]", text):
                    for i in range(2, len(words)):
                        if (
                            words[i].isalpha()
                            and words[i][0].isupper()
                            and len(words[i]) < 15
                        ):
                            continue
                        return " ".join(words[:i]), " ".join(words[i:])
                    return " ".join(words[:3]), " ".join(words[3:])

            # 5. Check for hyphenated surname
            for i, word in enumerate(words[:3]):
                if "-" in word:
                    name_end = i + 1
                    return " ".join(words[:name_end]), " ".join(words[name_end:])

            # 6. Default to 2 words as name
            if len(words) >= 3:
                return " ".join(words[:2]), " ".join(words[2:])
            elif len(words) == 2:
                return words[0], words[1]

            return text, ""

        idx = 0
        for line in lines:
            if len(messages) >= limit:
                break

            # Look for option elements
            match = re.search(r'option\s+"(.+?)"\s+\[', line)
            if match:
                text = match.group(1)
                is_unread = "unread" in line.lower()
                is_pinned = "pinned" in line.lower()

                # Remove status prefixes
                prefixes = r"(Collapsed|Has attachments|Pinned|Replied|New)"
                while re.match(rf"^{prefixes}\s+", text, re.IGNORECASE):
                    text = re.sub(rf"^{prefixes}\s+", "", text, flags=re.IGNORECASE)

                # Find time pattern - it separates metadata from preview
                time_match = re.search(r"\b(\d{1,2}:\d{2})\b", text)
                if time_match:
                    before_time = text[: time_match.start()].strip()
                    # Remove trailing day abbreviation
                    before_time = re.sub(
                        r"\s+(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s*$", "", before_time
                    )

                    sender, subject = parse_sender_subject(before_time)
                else:
                    sender, subject = text[:50], text[50:100] if len(text) > 50 else ""

                messages.append(
                    Message(
                        id=f"dom_{idx}",
                        date="",
                        sender=sender.strip() if sender else "Unknown",
                        subject=subject.strip()
                        if subject
                        else (text[:50] if text else "No subject"),
                        unread=is_unread,
                        to=[],
                        pinned=is_pinned,
                    )
                )
                idx += 1

        return messages[:limit]

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

        Uses DOM parsing since the EWS API requires HTTP-only X-OWA-CANARY cookie.

        Args:
            folder:
                Folder to list messages from.
            query:
                Optional search query (not yet implemented).
            unread_only:
                If True, filter to unread messages only.
            pinned_only:
                If True, filter to pinned messages only by clicking the Pinned filter.
            limit:
                Maximum number of messages to return.
        """
        # Navigate to folder
        self._navigate_to_folder(folder)

        # Apply pinned filter if requested
        if pinned_only:
            self._click_filter_button("Pinned")

        # Filter unread if needed
        if unread_only:
            self._click_filter_button("Unread")

        # Parse emails from DOM
        messages = self._parse_email_list_from_dom(limit)

        return messages[:limit]

    def _click_filter_button(self, filter_name: str) -> None:
        """Click a filter button in the mail toolbar.

        Args:
            filter_name:
                Name of the filter to click (e.g., "Pinned", "Unread").
        """
        snapshot = self._browser._run("snapshot", "-i")
        if filter_name in snapshot:
            # Parse snapshot to find the ref for the filter button
            import re

            # Look for button with the filter name in aria-label or text
            for line in snapshot.split("\n"):
                if filter_name.lower() in line.lower() and (
                    "button" in line.lower() or "checkbox" in line.lower()
                ):
                    ref_match = re.search(r"\[ref=(e\d+)\]", line)
                    if ref_match:
                        ref = f"@{ref_match.group(1)}"
                        try:
                            self._browser._run("click", ref)
                            self._wait_for_snapshot(timeout=5)
                            return
                        except Exception:
                            pass

    def pin_message(self, msg_id: str, folder: str = "inbox") -> None:
        """Pin a message by clicking the Pin button.

        Args:
            msg_id:
                Message ID to pin. Can be a dom_ index or backend-specific ID.
            folder:
                Folder containing the message. Defaults to "inbox".
        """
        # Navigate to folder
        self._navigate_to_folder(folder)

        # Find and select the message
        if msg_id.startswith("dom_"):
            index = int(msg_id.replace("dom_", ""))
            snapshot = self._browser._run("snapshot", timeout=30)
            options = re.findall(r"option.*?\[ref=e(\d+)\]", snapshot, re.IGNORECASE)

            if index < len(options):
                ref = f"@e{options[index]}"
                self._browser._run("click", ref)
                self._wait_for_snapshot(timeout=5)

        # Click the Pin button - look for it in the toolbar
        snapshot = self._browser._run("snapshot", "-i")
        for line in snapshot.split("\n"):
            if "pin" in line.lower() and "button" in line.lower():
                ref_match = re.search(r"\[ref=(e\d+)\]", line)
                if ref_match:
                    ref = f"@{ref_match.group(1)}"
                    try:
                        self._browser._run("click", ref)
                        self._wait_for_snapshot(timeout=3)
                        return
                    except Exception:
                        pass

        raise BackendError(f"Pin button not found for message {msg_id}")

    def unpin_message(self, msg_id: str, folder: str = "inbox") -> None:
        """Unpin a message by clicking the Unpin button.

        Args:
            msg_id:
                Message ID to unpin. Can be a dom_ index or backend-specific ID.
            folder:
                Folder containing the message. Defaults to "inbox".
        """
        # Navigate to folder
        self._navigate_to_folder(folder)

        # Find and select the message
        if msg_id.startswith("dom_"):
            index = int(msg_id.replace("dom_", ""))
            snapshot = self._browser._run("snapshot", timeout=30)
            options = re.findall(r"option.*?\[ref=e(\d+)\]", snapshot, re.IGNORECASE)

            if index < len(options):
                ref = f"@e{options[index]}"
                self._browser._run("click", ref)
                self._wait_for_snapshot(timeout=5)

        # Click the Unpin button - look for it in the toolbar
        snapshot = self._browser._run("snapshot", "-i")
        for line in snapshot.split("\n"):
            if "unpin" in line.lower() and "button" in line.lower():
                ref_match = re.search(r"\[ref=(e\d+)\]", line)
                if ref_match:
                    ref = f"@{ref_match.group(1)}"
                    try:
                        self._browser._run("click", ref)
                        self._wait_for_snapshot(timeout=3)
                        return
                    except Exception:
                        pass

        raise BackendError(f"Unpin button not found for message {msg_id}")

    def get_message(
        self, *, msg_id: str, mark_read: bool, folder: str = "inbox"
    ) -> Message:
        """Fetch a single message by parsing the reading pane.

        Extracts structured data: subject, from, to, date, body, and thread messages.
        """
        import re

        # Navigate to folder and click on the email
        if msg_id.startswith("dom_"):
            index = int(msg_id.replace("dom_", ""))
            # Navigate to the specified folder (not just inbox)
            self._navigate_to_folder(folder)

            snapshot = self._browser._run("snapshot", timeout=30)
            options = re.findall(r"option.*?\[ref=e(\d+)\]", snapshot, re.IGNORECASE)

            if index < len(options):
                ref = f"@e{options[index]}"
                try:
                    self._browser._run("click", ref)
                    self._wait_for_snapshot(timeout=5)
                except Exception:
                    raise BackendError(f"Could not open message {index}")
            else:
                raise BackendError(f"Message index {index} not found")

        # Parse structured email content
        snapshot = self._browser._run("snapshot", timeout=30)
        lines = snapshot.split("\n") if snapshot else []

        # Extract structured fields
        subject = ""
        sender_name = ""
        to_recipients = []
        date_str = ""
        body_paragraphs = []
        in_message_body = False

        for line in lines:
            # Subject/headers - level 3 headings in reading pane
            if "heading" in line and "level=3" in line:
                # Extract text between first quote and ' [' (before metadata)
                match = re.search(r'heading\s+"(.+?)"\s+\[level=', line)
                if match:
                    text = match.group(1)
                    # Capture the first occurrence of each header type
                    if text.startswith("From:") and not sender_name:
                        sender_name = text[5:].strip()
                    elif text.startswith("To:") and not to_recipients:
                        # Extract recipients
                        to_text = text[3:].strip()
                        to_recipients = [
                            r.strip() for r in to_text.split(",") if r.strip()
                        ]
                    elif re.match(r"\w{3}\s+\d{2}/\d{2}/\d{4}", text) and not date_str:
                        date_str = text
                    # Subject heading (appears in header bar with action buttons)
                    # Pattern: "Subject Action Action Remove Action [Extra]"
                    if not subject and "Remove" in text:
                        # Match pattern: word repeated 3x with Remove in middle
                        match = re.search(r"^(.+?)\s+\w+\s+\w+\s+Remove\s+\w+", text)
                        if match:
                            subject = match.group(1)
                        else:
                            subject = text[:80]
                    # Fallback: plain subject without Remove action
                    elif (
                        not subject
                        and "Remove" not in text
                        and "From:" not in text
                        and "To:" not in text
                    ):
                        if not re.match(
                            r"\w{3}\s+\d{2}/\d{2}/\d{4}", text
                        ):  # Not a date
                            subject = text[:80]

            # Document body section
            if "document" in line and "Message body" in line:
                in_message_body = True
            elif "Show message history" in line or (
                "toolbar" in line and in_message_body
            ):
                if in_message_body:
                    in_message_body = False  # End of message body

            # Collect body paragraphs - stop at thread markers, skip signatures
            if in_message_body and "paragraph" in line:
                continue
            if in_message_body and "StaticText" in line:
                # Extract text - handle quoted strings with possible embedded quotes
                match = re.search(r"StaticText\s+(.+)$", line)
                if match:
                    text = match.group(1).strip()
                    # Remove outer quotes if present
                    if text.startswith('"') and text.endswith('"'):
                        text = text[1:-1]
                    text = text.strip()

                    # Stop collecting at thread/reply markers (generic patterns)
                    # Matches email addresses in quoted headers: "From: X <x@y.com>"
                    if re.search(
                        r"\b[A-Za-z._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b", text
                    ):
                        in_message_body = False  # Stop at thread
                        continue
                    # Matches: "From:", "Sent:", "On [date] wrote:", etc.
                    if re.search(
                        r"^(From:|Sent:|To:|Cc:|Subject:|On\s+\w+\s+\d+)",
                        text,
                        re.IGNORECASE,
                    ):
                        in_message_body = False  # Stop at quoted header
                        continue
                    # Skip signature lines and UI text
                    skip_patterns = [
                        r"---",
                        r"Phone \+",
                        r"Register of associations",
                        r"Authorized recipient",
                        r"This email is generated",
                        r"^Reply\s*$",
                        r"^Reply all\s*$",
                        r"^Forward\s*$",  # UI buttons (exact match)
                        r"This invite will only work",
                        r"Open\s*$",
                        r"^Følg os",
                        r"Abonner på",
                        r"^[A-Z][A-Z\s]{20,}$",  # ALL CAPS (20+ chars)
                        r"^_{10,}",  # Underscore lines
                        r"^Mobil\b",
                        r"^Hovednr\.?\b",
                        r"^E-mail\b",
                        r"^Web\b",
                        r"^\+?\s*\d{2,4}\s+\d{2,4}\s+\d{2,4}\s+\d{2,4}$",  # Phone numbers
                        r"^\d{4}\s+[A-Z]",  # Addresses like "2100 København Ø"
                        r"^RESTRICTED$",
                        r"^CONFIDENTIAL$",
                        r"^INTERNAL$",
                    ]  # Classification banners
                    if text and not any(
                        re.search(p, text, re.IGNORECASE) for p in skip_patterns
                    ):
                        # Check for signature markers
                        if (
                            text.startswith("Med venlig hilsen")
                            or text.startswith("Best regards")
                            or text.startswith("Venlig hilsen")
                            or text.startswith("Kind regards")
                            or text.startswith("Mvh ")
                            or (re.match(r"^[A-Z\s/]+$", text) and len(text) > 5)
                        ):  # ALL CAPS names
                            in_message_body = False
                            continue
                        body_paragraphs.append(text)

        body_text = "\n\n".join(body_paragraphs) if body_paragraphs else ""

        # Format sender (skip if it's the same as what appears in subject line)
        sender = sender_name.strip() if sender_name else "Unknown"

        # Clean up subject - unescape any remaining escape sequences
        if subject:
            subject = (
                subject.replace('\\"', '"').replace("\\'", "'").replace("\\n", "\n")
            )

        # Format for Message object
        message = Message(
            id=msg_id,
            date=date_str,
            sender=sender,
            subject=subject if subject else "No subject",
            unread=False,
            to=to_recipients,
            body_text=body_text,
        )

        return message

    # -- send (not implemented - requires EWS API with X-OWA-CANARY) --------

    def _mark_read(self, item_id: dict) -> None:
        """Mark message as read by clicking on it (already done when opening)."""
        # Opening an email in OWA automatically marks it as read
        pass

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
        """Send an email via Outlook on the web compose dialog.

        Args:
            to:
                List of primary recipient email addresses.
            cc:
                List of CC recipient email addresses.
            bcc:
                List of BCC recipient email addresses.
            subject:
                Email subject line. Must be non-empty.
            body:
                Email body content.
            attachments:
                List of file paths to attach. Not supported - will raise error.

        Raises:
            BackendError:
                If attachments provided, subject is empty, or send fails.
        """
        # Reject attachments - not supported
        if attachments:
            raise BackendError(
                "The OWA backend does not support attachments. "
                "Send without attachments or use a different backend."
            )

        # Validate subject - OWA silently fails with empty subject
        if not subject or not subject.strip():
            raise BackendError(
                "Subject is required. OWA does not allow sending emails without a subject."
            )

        # Ensure authenticated session
        self._browser.open(_MAIL_URL, headed=False)
        time.sleep(2)  # Allow page to stabilise

        # Open compose dialog via eval_json
        new_message_js = """
        (() => {
            // OWA's New message button - triggers compose dialog
            const button = document.querySelector('[aria-label="New message"]');
            if (!button) {
                return { error: "New message button not found" };
            }
            button.click();
            return { success: true };
        })()
        """
        result = self._browser.eval_json(new_message_js)
        if result.get("error"):
            raise BackendError(
                f"Failed to open compose dialog: {result['error']}"
            )

        # Wait for compose dialog to appear
        time.sleep(3)

        # Fill recipients using helper method
        if to:
            self._fill_recipient_field("To", to)
        if cc:
            self._fill_recipient_field("Cc", cc)
        if bcc:
            self._fill_recipient_field("Bcc", bcc)

        # Fill subject and body using helper method
        self._fill_subject_and_body(subject, body)

        # Click Send via eval_json
        send_js = """
        (() => {
            const sendButton = document.querySelector('button[aria-label*="Send"]');
            if (!sendButton) {
                return { error: "Send button not found" };
            }
            sendButton.click();
            return { success: true };
        })()
        """
        send_result = self._browser.eval_json(send_js)
        if send_result.get("error"):
            raise BackendError(f"Failed to click Send: {send_result['error']}")

        # Wait up to 60 seconds for "Message sent" toast or compose dialog to close
        start = time.time()
        timeout = 60
        interval = 2

        while time.time() - start < timeout:
            time.sleep(interval)

            # Check for "Message sent" toast
            toast_check = self._browser.eval_json(
                '(async()=>JSON.stringify({toast:/Message sent/i.test(document.body.innerText)}))()'
            )
            if (toast_check or {}).get("toast"):
                return  # Success

            # Check if compose dialog is closed
            compose_check = self._browser.eval_json(
                '(async()=>JSON.stringify({compose:!!document.querySelector(\'[role="dialog"][aria-label*="New message"]\')}))()'
            )
            if not (compose_check or {}).get("compose"):
                return  # Dialog closed = success

            # Check for validation errors
            validation_errors = self._check_validation_errors()
            if validation_errors:
                raise BackendError(
                    f"Send failed with validation errors: {validation_errors}"
                )

            # Check compose state (might indicate why send was blocked)
            compose_state = self._check_compose_state()
            if compose_state.get("send_blocked"):
                raise BackendError(
                    f"Send blocked: {compose_state.get('reason', 'Unknown reason')}"
                )

        # Timeout - send did not complete
        raise BackendError(
            "Send operation timed out after 60 seconds. "
            "The compose dialog may still be open or the message was not sent."
        )

    def _fill_recipient_field(self, field_name: str, recipients: list[str]) -> None:
        """Fill a recipient field and wait for autocomplete bubbles to form.

        Args:
            field_name:
                Name of the field ("To", "Cc", or "Bcc").
            recipients:
                List of email addresses to add.

        Raises:
            BackendError:
                If field not found or recipients invalid.
        """
        # Map field names to aria-labels
        aria_labels = {
            "To": "To",
            "Cc": "Cc",
            "Bcc": "Bcc",
        }
        aria_label = aria_labels.get(field_name)
        if not aria_label:
            raise BackendError(f"Unknown recipient field: {field_name}")

        # Find the contenteditable recipient field
        field_js = f"""
        (() => {{
            const el = document.querySelector('[aria-label="{aria_label}"][contenteditable="true"]');
            if (!el) return {{ error: "{field_name} field not found" }};
            return {{ success: true }};
        }})()
        """
        check = self._browser.eval_json(field_js)
        if check.get("error"):
            raise BackendError(f"Failed to find {field_name} field: {check['error']}")

        # Type all recipients as comma-separated, then trigger autocomplete
        # Use _json.dumps() for proper JS string escaping (handles quotes, newlines, etc.)
        recipients_str = ", ".join(recipients)
        recipients_escaped = _json.dumps(recipients_str)
        type_js = f"""
        (async () => {{
            const el = document.querySelector('[aria-label="{aria_label}"][contenteditable="true"]');
            if (!el) return {{ error: "Field not found" }};
            el.focus();
            
            // Wait for focus to settle
            await new Promise(r => setTimeout(r, 100));
            
            // Insert text into contenteditable element
            const sel = window.getSelection();
            if (sel && sel.rangeCount > 0) {{
                const range = sel.getRangeAt(0);
                range.deleteContents();
                range.insertNode(document.createTextNode({recipients_escaped}));
            }}
            
            // Trigger input event so OWA knows the field changed
            el.dispatchEvent(new InputEvent('input', {{ bubbles: true }}));
            
            return {{ success: true }};
        }})()
        """
        result = self._browser.eval_json(type_js)
        if result.get("error"):
            raise BackendError(
                f"Failed to type recipients in {field_name}: {result['error']}"
            )

        # Wait for autocomplete bubbles to form and resolve to chips
        # OWA needs time to validate recipients and show visual chips
        time.sleep(2)

    def _fill_subject_and_body(self, subject: str, body: str) -> None:
        """Fill subject and body fields in the compose dialog.

        Args:
            subject:
                Email subject line.
            body:
                Email body content (plain text or HTML).

        Raises:
            BackendError:
                If subject or body field not found.
        """
        # Fill subject field - input with aria-label="Add a subject"
        subject_escaped = _json.dumps(subject)
        subject_js = f"""
        (async () => {{
            const el = document.querySelector('[aria-label="Add a subject"]');
            if (!el) return {{ error: "Subject field not found" }};
            
            el.focus();
            await new Promise(r => setTimeout(r, 100));
            
            // Clear existing value and set new one
            el.value = '';
            el.dispatchEvent(new InputEvent('input', {{ bubbles: true }}));
            
            // Insert subject text
            el.value = {subject_escaped};
            el.dispatchEvent(new InputEvent('input', {{ bubbles: true }}));
            
            return {{ success: true }};
        }})()
        """
        result = self._browser.eval_json(subject_js)
        if result.get("error"):
            raise BackendError(f"Failed to fill subject field: {result['error']}")

        # Fill body field - contenteditable div with aria-label for message body
        # Use _json.dumps() for proper escaping of quotes, newlines, etc.
        body_escaped = _json.dumps(body)
        body_js = f"""
        (async () => {{
            // Find the body contenteditable div - look for the main editor area
            const bodyEl = document.querySelector('div[aria-label][contenteditable="true"]');
            if (!bodyEl) return {{ error: "Body field not found" }};
            
            bodyEl.focus();
            await new Promise(r => setTimeout(r, 100));
            
            // Clear existing content
            bodyEl.innerHTML = '';
            
            // Insert body text - preserve newlines by using textContent
            bodyEl.textContent = {body_escaped};
            
            // Trigger input event so OWA knows the content changed
            bodyEl.dispatchEvent(new InputEvent('input', {{ bubbles: true }}));
            
            return {{ success: true }};
        }})()
        """
        body_result = self._browser.eval_json(body_js)
        if body_result.get("error"):
            raise BackendError(f"Failed to fill body field: {body_result['error']}")
