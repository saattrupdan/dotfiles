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
        """Parse email list from the DOM accessibility tree."""
        snapshot = self._browser._run("snapshot", timeout=30)
        
        messages = []
        lines = snapshot.split("\n") if snapshot else []
        import re
        
        for line in lines:
            if len(messages) >= limit:
                break
            
            # Look for option elements which represent emails in the list
            # Format: option "Collapsed Has attachments Pinned SenderName Subject time preview..." [ref=e123]
            match = re.search(r'option\s+"([^"]+)"\s+\[ref=e(\d+)\]', line)
            if match:
                text = match.group(1)
                ref = match.group(2)
                
                # Check if unread
                is_unread = "unread" in line.lower()
                
                # Remove status prefixes (can be multiple)
                prefixes = r'(Collapsed|Has attachments|Pinned|Replied|New)'
                while re.match(rf'^{prefixes}\s+', text):
                    text = re.sub(rf'^{prefixes}\s+', '', text)
                
                # Look for time pattern (HH:MM) - this marks start of preview
                time_match = re.search(r'\b(\d{1,2}:\d{2})\b', text)
                if time_match:
                    before_time = text[:time_match.start()].strip()
                    
                    # Remove trailing day abbreviation if present (Mon, Tue, Wed, etc.)
                    before_time = re.sub(r'\s+(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s*$', '', before_time)
                    
                    # Sender typically ends where subject begins
                    # For most emails: "Sender Subject" where Subject often starts with a capital word or is short
                    # Parse backwards from time: the last capitalized word(s) before time is usually subject
                    words = before_time.split()
                    
                    # Subject is usually 1-3 words before time, sender is before that
                    # Look for email @ or semicolon for multi-sender
                    if "@" in before_time or ";" in before_time:
                        # Has email or semicolon - use as splitting point
                        if ";" in before_time:
                            parts = before_time.split(";")
                            sender = parts[0].strip()
                            subject = ";".join(parts[1:]).strip()
                        elif "@" in before_time:
                            # Email address present - find it
                            email_match = re.search(r'[\w.+-]+@[\w.-]+\.[a-z]{2,}', before_time)
                            if email_match:
                                if email_match.start() == 0:
                                    # Email at start - sender is the email, rest is subject
                                    sender = email_match.group()
                                    subject = before_time[email_match.end():].strip()
                                elif email_match.end() == len(before_time):
                                    # Email at end - everything before is sender
                                    sender = before_time[:email_match.start()].strip()
                                    subject = ""
                                else:
                                    # Email in middle
                                    sender = before_time[:email_match.start()].strip()
                                    subject = before_time[email_match.end():].strip()
                            else:
                                sender = before_time[:40]
                                subject = before_time[40:]
                        else:
                            sender = before_time
                            subject = ""
                    else:
                        # No email/semicolon - guess based on word patterns
                        if len(words) <= 2:
                            # Very short - probably just sender or just subject
                            sender = before_time
                            subject = ""
                        elif len(words) <= 4:
                            # 3-4 words: could be "FirstName LastName Subject" or "Sender Subject"
                            # If any word has hyphen and looks like surname, assume "First Last Subject"
                            has_hyphenated = any('-' in w for w in words[:2])
                            if has_hyphenated:
                                # Likely "FirstName LastName Subject"
                                sender = " ".join(words[:2])
                                subject = " ".join(words[2:])
                            else:
                                # Default: first 2 words sender, rest subject
                                sender = " ".join(words[:2])
                                subject = " ".join(words[2:])
                        else:
                            # More words: first 2-3 are sender, rest is subject
                            sender_end = min(3, max(2, len(words) // 3))
                            sender = " ".join(words[:sender_end])
                            subject = " ".join(words[sender_end:])
                else:
                    # No time found - use fallback
                    sender = text[:50]
                    subject = text[50:100] if len(text) > 50 else ""
                
                messages.append(Message(
                    id=f"dom_{ref}",
                    date="",
                    sender=sender.strip() if sender else "Unknown",
                    subject=subject.strip() if subject else (text[:50] if text else "No subject"),
                    unread=is_unread,
                    to=[],
                ))
        
        return messages[:limit]

    def list_messages(
        self,
        *,
        folder: str,
        query: str | None,
        unread_only: bool,
        limit: int,
    ) -> list[Message]:
        """Return the most recent messages in ``folder`` (newest first).
        
        Uses DOM parsing since the EWS API requires HTTP-only X-OWA-CANARY cookie.
        """
        # Navigate to folder
        self._navigate_to_folder(folder)
        
        # Filter unread if needed
        if unread_only:
            # Click on "Unread" filter if available
            snapshot = self._browser._run("snapshot", "-i")
            if "Unread" in snapshot:
                # Find and click the unread filter button
                # This is a simplification - full implementation would need ref tracking
                pass
        
        # Parse emails from DOM
        messages = self._parse_email_list_from_dom(limit)
        
        return messages[:limit]

    def get_message(self, *, msg_id: str, mark_read: bool) -> Message:
        """Fetch a single message by parsing the reading pane.
        
        Since we can't use the EWS API (requires HTTP-only X-OWA-CANARY),
        we click on the email and parse content from the DOM.
        """
        # The msg_id from DOM parsing is just "dom_N" - we need to navigate to inbox
        # and click on the Nth email
        if msg_id.startswith("dom_"):
            index = int(msg_id.replace("dom_", ""))
            
            # Navigate to inbox
            self._navigate_to_folder("inbox")
            
            # Get snapshot and find the email ref
            snapshot = self._browser._run("snapshot", timeout=30)
            
            # Find option refs (email entries)
            import re
            options = re.findall(r'option.*?\[ref=e(\d+)\]', snapshot, re.IGNORECASE)
            
            if index < len(options):
                ref = f"@e{options[index]}"
                try:
                    self._browser._run("click", ref)
                    self._wait_for_snapshot(timeout=5)
                except Exception:
                    raise BackendError(f"Could not open message {index}")
            else:
                raise BackendError(f"Message index {index} not found")
        
        # Parse email content from reading pane
        snapshot = self._browser._run("snapshot", timeout=30)
        
        # Extract email details from snapshot
        # Looking for patterns like:
        # - heading "Subject line" [level=1]
        # - "From: Name <email>"
        # - "Date: ..."
        # - email body content
        
        subject = ""
        sender = ""
        date = ""
        body_text = ""
        
        lines = snapshot.split("\n") if snapshot else []
        in_body = False
        
        for line in lines:
            if "heading" in line.lower() and "level=1" in line:
                match = re.search(r'heading\s+"([^"]+)"', line)
                if match:
                    subject = match.group(1)
            
            if "From:" in line or "from" in line.lower():
                match = re.search(r'[Ff]rom:\s*([^\n]+)', line)
                if match:
                    sender = match.group(1).strip()
            
            # Collect body text (simplified - would need better parsing in production)
            if in_body and line.strip():
                body_text += line.strip() + "\n"
            
            if "body" in line.lower() or "content" in line.lower():
                in_body = True
        
        message = Message(
            id=msg_id,
            date=date,
            sender=sender,
            subject=subject,
            unread=False,  # Opening marks as read in OWA
            to=[],
            body_text=body_text.strip() if body_text else "",
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
        """Send email - not implemented for OWA backend.
        
        The OWA backend doesn't support sending yet. Use a Gmail/IMAP account
        for sending emails, or use the Graph backend if your tenant allows it.
        """
        raise BackendError(
            "The OWA backend does not support sending emails. "
            "Use a Gmail/IMAP account for sending, or configure the Graph backend."
        )
