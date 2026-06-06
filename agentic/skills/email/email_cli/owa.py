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

import hashlib
import json as _json
import re
import time

from .browser import BrowserSession
from .config import CONFIG_DIR
from .credentials import get_outlook_credentials
from .models import Message
from .base import BackendError

_MAIL_URL = "https://outlook.office.com/mail/inbox"  # Must end with /mail/inbox

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

    def _snapshot(self) -> str:
        """Take a snapshot of the current browser page.

        Returns:
            Lowercase snapshot text from agent-browser.
        """
        return self._browser._run("snapshot", "-c").strip().lower()

    def _wait(self, milliseconds: int = 500) -> None:
        """Wait for some time."""
        self._browser._run("wait", str(milliseconds))

    def _is_logged_in(self) -> bool:
        """Check if already logged in by probing URL and cookies."""
        try:
            probe = self._browser.eval_json(
                "{url:location.href,canary:/X-OWA-CANARY=/.test(document.cookie),"
                "inbox:/mail/i.test(location.href)}",
                timeout=10,
            )
            url = (probe or {}).get("url", "")
            has_canary = (probe or {}).get("canary", False)
            is_inbox = (probe or {}).get("inbox", False)
            return is_inbox and has_canary and "login.microsoftonline.com" not in url
        except Exception:
            return False

    def _get_username_click_refs(self) -> tuple[str, str] | None:
        """Get refs for username input and submit button."""
        snapshot = self._snapshot()
        input_ref = re.search(
            r"enter your email.* \[required, ref=([a-z]+[0-9]+)\]", snapshot
        )
        if input_ref is None:
            return None
        submit_ref = re.search(r'"next" \[ref=([a-z]+[0-9]+)\]', snapshot)
        if submit_ref is None:
            return None
        return ("@" + input_ref.group(1), "@" + submit_ref.group(1))

    def _get_account_click_ref(self) -> str | None:
        """Get ref for previously used account button."""
        snapshot = self._snapshot()
        ref = re.search(r"sign in with.* \[ref=([a-z]+[0-9]+)\]", snapshot)
        if ref is None:
            return None
        return "@" + ref.group(1)

    def _get_password_click_refs(self) -> tuple[str, str] | None:
        """Get refs for password input and submit button."""
        snapshot = self._snapshot()
        input_ref = re.search(
            r"enter the password.* \[required, ref=([a-z]+[0-9]+)\]", snapshot
        )
        if input_ref is None:
            return None
        submit_ref = re.search(r'"sign in" \[ref=([a-z]+[0-9]+)\]', snapshot)
        if submit_ref is None:
            return None
        return ("@" + input_ref.group(1), "@" + submit_ref.group(1))

    def _get_first_mfa_click_ref(self) -> str | None:
        """Get ref for first MFA step button."""
        snapshot = self._snapshot()
        ref = re.search(r"sign in another way.* \[ref=([a-z]+[0-9]+)\]", snapshot)
        if ref is None:
            return None
        return "@" + ref.group(1)

    def _get_second_mfa_click_ref(self) -> str | None:
        """Get ref for Microsoft Authenticator option."""
        snapshot = self._snapshot()
        ref = re.search(r"microsoft authenticator.* \[ref=([a-z]+[0-9]+)\]", snapshot)
        if ref is None:
            return None
        return "@" + ref.group(1)

    def _extract_code(self) -> int | None:
        """Extract MFA code from snapshot using regex."""
        snapshot = self._snapshot()
        code_match = re.search(r"approve the request.*([0-9]{2})\"", snapshot)
        if code_match is None:
            return None
        return int(code_match.group(1))

    def _get_finish_click_ref(self) -> str | None:
        """Get ref for 'Yes' button to finish login."""
        snapshot = self._snapshot()
        ref = re.search(r'button "yes".* \[ref=([a-z]+[0-9]+)\]', snapshot)
        if ref is None:
            return None
        return "@" + ref.group(1)

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
            js_wrapper = check_js  # Direct IIFE
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
            js_wrapper = state_js  # Direct IIFE
            result = self._browser.eval_json(js_wrapper)
            return (
                result
                if result
                else {"compose_open": False, "message_sent": False, "error": None}
            )
        except Exception:
            return {
                "compose_open": False,
                "message_sent": False,
                "error": "Failed to check compose state",
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
                "{url:location.href,canary:/X-OWA-CANARY=/.test(document.cookie),"
                "inbox:/mail/i.test(location.href)}"
            )
            url = (probe or {}).get("url", "")
            has_canary = (probe or {}).get("canary", False)
            is_inbox = (probe or {}).get("inbox", False)

            # Success: inbox loaded + canary present
            if is_inbox and has_canary:
                self._browser.state_save()
                return (
                    f"Signed in to Outlook on the web as {self._email} "
                    f"({elapsed}s, session saved)."
                )

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

    def _open_owa(self) -> None:
        """Open Microsoft OWA in the session."""
        self._browser._run("close")
        try:
            self._browser.open(_MAIL_URL, headed=False)
        except BackendError as exc:
            raise BackendError(
                "Failed to open Microsoft OWA - internet is probably down."
            ) from exc
        self._browser.wait_load("networkidle")

    def _login(self, username: str, password: str) -> None:
        """Enter username and password."""
        while (username_refs := self._get_username_click_refs()) is None and (
            account_ref := self._get_account_click_ref()
        ) is None:
            self._wait()

        # If we have previously logged in, we can skip the username + password
        if account_ref is not None:
            self._browser._run("click", account_ref)
            self._wait()
            return

        assert username_refs is not None

        # Username
        self._browser._run("type", username_refs[0], username)
        self._browser._run("click", username_refs[1])
        self._wait()

        # Password
        while (password_refs := self._get_password_click_refs()) is None:
            self._wait()
        self._browser._run("type", password_refs[0], password)
        self._browser._run("click", password_refs[1])
        self._wait()

    def _get_to_mfa(self) -> None:
        """Navigate through MFA selection."""
        while (first_mfa_click_ref := self._get_first_mfa_click_ref()) is None:
            self._wait()
        self._browser._run("click", first_mfa_click_ref)
        self._wait()

        while (second_mfa_click_ref := self._get_second_mfa_click_ref()) is None:
            self._wait()
        self._browser._run("click", second_mfa_click_ref)
        self._wait()

    def _finish_login(self) -> None:
        """Finish the login process by clicking 'Yes' button."""
        while (finish_ref := self._get_finish_click_ref()) is None:
            self._wait()
        self._browser._run("click", finish_ref)
        self._wait()

    def login(self, password: str | None = None) -> str:
        """Perform complete automated login flow.

        1. Gets credentials from keychain (or uses provided password)
        2. Navigates to Outlook and fills login form using robust snapshot-based
           selectors
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
                "security add-generic-password -s 'outlook' -a 'password' -w"
                " 'YOUR_PASSWORD'"
            )

        # Open OWA
        self._open_owa()
        if self._is_logged_in():
            self._browser.state_save()
            return (
                f"Already signed in to Outlook on the web as "
                f"{self._email} (session saved)."
            )

        # Login with credentials
        self._login(username, password)
        self._get_to_mfa()

        # Extract MFA code
        mfa_code = None
        while (mfa_code := self._extract_code()) is None:
            self._wait()

        # Display MFA code for user
        print(f"\nMFA code: {mfa_code}")
        print("Enter this code in Microsoft Authenticator and approve the request.")
        print("Once approved, the login will complete automatically...")

        # Finish login (click "Yes" after MFA approval)
        self._finish_login()
        self._wait()

        # Save session
        self._browser.state_save()

        return f"Signed in to Outlook on the web as {self._email} (session saved)."

    def get_mfa_code(self, password: str | None = None) -> str:
        """Perform login up to MFA code display (step 1 of 2).

        1. Gets credentials from keychain (or uses provided password)
        2. Navigates to Outlook and fills login form
        3. Completes MFA selection
        4. Extracts and displays MFA code
        5. Waits for user to approve in Microsoft Authenticator

        Args:
            password:
                Optional password provided directly. If not provided,
                fetched from password manager.

        Returns:
            Message with the MFA code and instructions.

        Raises:
            BackendError: If login fails before MFA code extraction.
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
                "security add-generic-password -s 'outlook' -a 'password' -w"
                " 'YOUR_PASSWORD'"
            )

        # Open OWA
        self._open_owa()
        if self._is_logged_in():
            self._browser.state_save()
            return (
                f"Already signed in to Outlook on the web as "
                f"{self._email} (session saved)."
            )

        # Login with credentials
        self._login(username, password)
        self._get_to_mfa()

        # Extract MFA code
        mfa_code = None
        while (mfa_code := self._extract_code()) is None:
            self._wait()

        return (
            f"\nMFA code: {mfa_code}\n"
            f"Enter this code in Microsoft Authenticator and approve the request.\n"
            f"Once approved, run: email login --mfa-code"
        )

    def finish_login(self) -> str:
        """Finish login by clicking the confirm button (step 2 of 2).

        Assumes step 1 (get_mfa_code) was already run and the user has
        approved the MFA request in Microsoft Authenticator.

        Returns:
            Success message with account email.

        Raises:
            BackendError: If the finish login fails.
        """
        # Finish login (click "Yes" after MFA approval)
        self._finish_login()
        self._wait()

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

        for line in lines:
            if len(messages) >= limit:
                break

            # Look for option elements with ref for unique ID
            match = re.search(r'option\s+"(.+?)"\s+\[ref=([^\]]+)\]', line)
            if match:
                text = match.group(1)
                ref = match.group(2)
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

                # Use hash-based ID to guarantee uniqueness across multiple parses
                # DOM refs can repeat due to virtual rendering reusing elements
                msg_subject = (
                    subject.strip()
                    if subject
                    else (text[:50] if text else "No subject")
                )
                msg_sender = sender.strip() if sender else "Unknown"
                id_content = f"{msg_sender}|{msg_subject}|{ref}"
                msg_id = hashlib.md5(id_content.encode()).hexdigest()[:12]

                messages.append(
                    Message(
                        id=msg_id,
                        date="",
                        sender=msg_sender,
                        subject=msg_subject,
                        unread=is_unread,
                        to=[],
                        pinned=is_pinned,
                    )
                )

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

        Outlook uses virtual rendering - only visible emails are in the DOM.
        We collapse the Pinned section (if present) to reveal more emails,
        then use keyboard navigation to walk through the list.

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

        # Wait for initial render
        time.sleep(1.5)

        # Collapse the pinned section to reveal non-pinned emails below
        # Outlook groups pinned emails in an expandable section that blocks visibility
        if not pinned_only:
            try:
                snapshot = self._browser._run("snapshot", timeout=30)
                for line in snapshot.split("\n"):
                    match = re.search(
                        r'button\s+"Pinned"\s+\[expanded=true,\s*ref=([^\]]+)\]', line
                    )
                    if match:
                        self._browser._run("click", f"@{match.group(1)}")
                        time.sleep(0.5)
                        break
            except Exception:
                pass  # Continue even if collapse fails

        # Collect emails using keyboard navigation
        # Pressing Down navigates through emails and triggers virtual loading
        all_messages: list[Message] = []
        seen_keys: set[str] = set()
        max_navigations = max(limit * 3, 150)  # Extra navigations for virtual loading
        navigations_without_new = 0

        for i in range(max_navigations):
            # Parse current viewport
            messages = self._parse_email_list_from_dom(limit * 2)

            # Add new messages
            new_count = 0
            for msg in messages:
                key = f"{msg.sender}:{msg.subject}"
                if key not in seen_keys:
                    seen_keys.add(key)
                    all_messages.append(msg)
                    new_count += 1

            # Stop if we have enough or no new emails after several tries
            if len(all_messages) >= limit:
                break
            if new_count == 0:
                navigations_without_new += 1
                if navigations_without_new >= 5:  # More tolerance for virtual loading
                    break
            else:
                navigations_without_new = 0

            # On first iteration, click the first email to focus the list
            if i == 0 and messages:
                try:
                    snapshot = self._browser._run("snapshot", timeout=30)
                    for line in snapshot.split("\n"):
                        match = re.search(r'option\s+".+?"\s+\[ref=([^\]]+)\]', line)
                        if match:
                            self._browser._run("click", f"@{match.group(1)}")
                            time.sleep(0.3)
                            break
                except Exception:
                    pass

            # Press down to navigate to next email
            try:
                self._browser._run("press", "down")
                time.sleep(0.2)
            except Exception:
                break

        return all_messages[:limit]

    def _apply_unread_filter(self) -> bool:
        """Apply the Unread filter by opening Filter menu and selecting Unread.

        Returns:
            True if filter was applied successfully, False otherwise.
        """
        try:
            # Step 1: Find and click Filter button
            snapshot = self._browser._run("snapshot", "-i", timeout=30)
            filter_ref = None
            for line in snapshot.split("\n"):
                if 'button "Filter"' in line:
                    match = re.search(r"ref=(\w+)", line)
                    if match:
                        filter_ref = f"@{match.group(1)}"
                        break

            if not filter_ref:
                return False

            self._browser._run("click", filter_ref)
            time.sleep(2)

            # Step 2: Find and click Unread menuitemradio
            snapshot = self._browser._run("snapshot", "-i", timeout=30)
            unread_ref = None
            for line in snapshot.split("\n"):
                if 'menuitemradio "Unread"' in line:
                    match = re.search(r"ref=(\w+)", line)
                    if match:
                        unread_ref = f"@{match.group(1)}"
                        break

            if not unread_ref:
                return False

            self._browser._run("click", unread_ref)
            time.sleep(2)
            return True

        except Exception:
            return False

    def _click_filter_button(self, filter_name: str) -> None:
        """Click a filter button in the mail toolbar.

        Handles "Pinned" (direct button) and "Unread" (menu-based filter).

        Args:
            filter_name:
                Name of the filter to click (e.g., "Pinned", "Unread").
        """
        if filter_name.lower() == "unread":
            if self._apply_unread_filter():
                return
            # Fall through to legacy method if special handler fails

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

    def _scroll_to_load_emails(self, *, num_scrolls: int = 8) -> None:
        """Scroll the email list to trigger lazy-loading of more messages.

        Outlook on the web lazy-loads emails as you scroll. This method scrolls
        down multiple times to load more messages into the DOM before parsing.

        Args:
            num_scrolls:
                Number of scroll actions to perform (default 8).
        """
        # Wait for the page to fully render before scrolling
        time.sleep(1.5)

        # First, try to find and scroll the message list directly using JavaScript
        try:
            self._browser.eval_json(
                """
                (function() {
                    // Find the message list container by looking for the listbox
                    const listbox = document.querySelector('[role="listbox"]');
                    if (listbox) {
                        // Scroll incrementally to trigger lazy loading
                        for (let i = 0; i < 8; i++) {
                            listbox.scrollTop += 200;
                        }
                        return true;
                    }
                    return false;
                })()
                """,
                timeout=10,
            )
            time.sleep(1.0)
        except Exception:
            pass

        # Fallback: use agent-browser scroll command
        for _ in range(num_scrolls):
            try:
                # Use agent-browser scroll command - it scrolls the main content area
                self._browser._run("scroll", "down", "500")
                # Wait for new emails to load
                time.sleep(0.3)
            except Exception:
                # Best-effort scrolling - don't fail if scroll doesn't work
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
                        r"^\+?\s*\d{2,4}\s+\d{2,4}\s+\d{2,4}\s+\d{2,4}$",  # Phone numbers  # noqa: E501
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

    def get_next_unread(self, *, folder: str, mark_read: bool) -> Message | None:
        """Fetch the next unread message, optionally marking it read.

        Navigates to the folder, applies the unread filter, and returns the
        first unread email. Opens the email in the reading pane (which marks
        it as read if mark_read=True).

        Args:
            folder:
                Folder to fetch unread from.
            mark_read:
                Whether to mark the message as read after fetching.

        Returns:
            The next unread Message, or None if no unread emails exist.
        """
        # Navigate to folder
        self._navigate_to_folder(folder)

        # Apply unread filter
        self._click_filter_button("Unread")

        # Wait for initial render
        time.sleep(1.5)

        # Get the first unread email from the list
        snapshot = self._browser._run("snapshot", timeout=30)
        lines = snapshot.split("\n") if snapshot else []

        # Find the first unread option element
        first_unread_ref = None
        for line in lines:
            if "option" in line and "unread" in line.lower():
                match = re.search(r'option\s+".+?"\s+\[ref=([^\]]+)\]', line)
                if match:
                    first_unread_ref = f"@{match.group(1)}"
                    break

        if first_unread_ref is None:
            return None

        # Click on the first unread email to open it in the reading pane
        try:
            self._browser._run("click", first_unread_ref)
            self._wait_for_snapshot(timeout=5)
        except Exception:
            raise BackendError("Could not open unread message")

        # If not marking as read, we need a different approach
        # For now, opening it marks it as read (OWA behaviour)
        # The mark_read parameter is kept for API consistency but OWA always marks on open

        # Parse the opened message
        return self._parse_opened_message(mark_read=mark_read)

    def _parse_opened_message(self, *, mark_read: bool) -> Message:
        """Parse an opened message from the reading pane.

        Similar to get_message() but returns after parsing without needing msg_id.
        """
        snapshot = self._browser._run("snapshot", timeout=30)
        lines = snapshot.split("\n") if snapshot else []

        subject = ""
        sender_name = ""
        to_recipients = []
        date_str = ""
        body_paragraphs = []
        in_message_body = False

        for line in lines:
            # Subject/headers - level 3 headings in reading pane
            if "heading" in line and "level=3" in line:
                match = re.search(r'heading\s+"(.+?)"\s+\[level=', line)
                if match:
                    text = match.group(1)
                    if text.startswith("From:") and not sender_name:
                        sender_name = text[5:].strip()
                    elif text.startswith("To:") and not to_recipients:
                        to_text = text[3:].strip()
                        to_recipients = [
                            r.strip() for r in to_text.split(",") if r.strip()
                        ]
                    elif re.match(r"\w{3}\s+\d{2}/\d{2}/\d{4}", text) and not date_str:
                        date_str = text
                    if not subject and "Remove" in text:
                        match = re.search(r"^(.+?)\s+\w+\s+\w+\s+Remove\s+\w+", text)
                        if match:
                            subject = match.group(1)
                        else:
                            subject = text[:80]
                    elif (
                        not subject
                        and "Remove" not in text
                        and "From:" not in text
                        and "To:" not in text
                    ):
                        if not re.match(r"\w{3}\s+\d{2}/\d{2}/\d{4}", text):
                            subject = text[:80]

            if "document" in line and "Message body" in line:
                in_message_body = True
            elif "Show message history" in line or (
                "toolbar" in line and in_message_body
            ):
                if in_message_body:
                    in_message_body = False

            if in_message_body and "paragraph" in line:
                continue
            if in_message_body and "StaticText" in line:
                match = re.search(r"StaticText\s+(.+)$", line)
                if match:
                    text = match.group(1).strip()
                    if text.startswith('"') and text.endswith('"'):
                        text = text[1:-1]
                    text = text.strip()

                    if re.search(
                        r"\b[A-Za-z._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b", text
                    ):
                        in_message_body = False
                        continue
                    if re.search(
                        r"^(From:|Sent:|To:|Cc:|Subject:|On\s+\w+\s+\d+)",
                        text,
                        re.IGNORECASE,
                    ):
                        in_message_body = False
                        continue

                    skip_patterns = [
                        r"---",
                        r"Phone \+",
                        r"Register of associations",
                        r"Authorized recipient",
                        r"This email is generated",
                        r"^Reply\s*$",
                        r"^Reply all\s*$",
                        r"^Forward\s*$",
                        r"This invite will only work",
                        r"Open\s*$",
                        r"^Følg os",
                        r"Abonner på",
                        r"^[A-Z][A-Z\s]{20,}$",
                        r"^_{10,}",
                        r"^Mobil\b",
                        r"^Hovednr\.?\b",
                        r"^E-mail\b",
                        r"^Web\b",
                        r"^\+?\s*\d{2,4}\s+\d{2,4}\s+\d{2,4}\s+\d{2,4}$",
                        r"^\d{4}\s+[A-Z]",
                        r"^RESTRICTED$",
                        r"^CONFIDENTIAL$",
                        r"^INTERNAL$",
                    ]
                    if text and not any(
                        re.search(p, text, re.IGNORECASE) for p in skip_patterns
                    ):
                        if (
                            text.startswith("Med venlig hilsen")
                            or text.startswith("Best regards")
                            or text.startswith("Venlig hilsen")
                            or text.startswith("Kind regards")
                            or text.startswith("Mvh ")
                            or (re.match(r"^[A-Z\s/]+$", text) and len(text) > 5)
                        ):
                            in_message_body = False
                            continue
                        body_paragraphs.append(text)

        body_text = "\n\n".join(body_paragraphs) if body_paragraphs else ""
        sender = sender_name.strip() if sender_name else "Unknown"

        if subject:
            subject = subject.replace('"', '"').replace("\\'", "'").replace("\\n", "\n")

        # Generate a stable ID for the opened message
        msg_id = hashlib.md5(f"{sender}|{subject}|{date_str}".encode()).hexdigest()[:12]

        return Message(
            id=msg_id,
            date=date_str,
            sender=sender,
            subject=subject if subject else "No subject",
            unread=not mark_read,
            to=to_recipients,
            body_text=body_text,
        )

    def _check_logged_in(self) -> bool:
        """Check if we are on a logged-in OWA page (not login redirect)."""
        try:
            location = self._browser.eval_json("location.href")
            return "login.microsoftonline" not in str(location)
        except Exception:
            return False

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
                "Subject is required. OWA does not allow sending emails without a subject."  # noqa: E501
            )

        # Ensure authenticated session
        self._browser.open(_MAIL_URL, headed=False)
        time.sleep(2)  # Allow page to stabilise

        # Open compose dialog via eval_json
        new_message_js = """
        (() => {
            // OWA's New email button - triggers compose dialog
            const button = document.querySelector('[aria-label="New email"]');
            if (!button) {
                return { error: "New email button not found" };
            }
            button.click();
            return { success: true };
        })()
        """
        result = self._browser.eval_json(new_message_js)
        if result.get("error"):
            raise BackendError(f"Failed to open compose dialog: {result['error']}")

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
                "() => ({toast:document.body.innerText.includes(`Message sent`)})"
            )
            if (toast_check or {}).get("toast"):
                return  # Success

            # Check if compose dialog is closed
            compose_check_js = (
                "() => ({compose:!!document.querySelector("
                "\"[aria-label*='New email'][role='dialog']\")})"
            )
            compose_check = self._browser.eval_json(compose_check_js)
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
            const el = document.querySelector('[aria-label="{aria_label}"][contenteditable="true"]');  # noqa: E501
            if (!el) return {{ error: "{field_name} field not found" }};
            return {{ success: true }};
        }})()
        """
        check = self._browser.eval_json(field_js)
        if check.get("error"):
            raise BackendError(f"Failed to find {field_name} field: {check['error']}")

        # Type all recipients as comma-separated, then trigger autocomplete
        # Use _json.dumps() for proper JS string escaping (handles quotes, newlines, etc.)  # noqa: E501
        recipients_str = ", ".join(recipients)
        recipients_escaped = _json.dumps(recipients_str)
        type_js = f"""
        (async () => {{
            const el = document.querySelector('[aria-label="{aria_label}"][contenteditable="true"]');  # noqa: E501
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
        # Fill subject field - input with aria-label="Subject"
        subject_escaped = _json.dumps(subject)
        subject_js = f"""
        (async () => {{
            const el = document.querySelector('[aria-label="Subject"]');
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
            const bodyEl = document.querySelector('div[contenteditable="true"][aria-label]');
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
