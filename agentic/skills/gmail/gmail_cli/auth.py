"""OAuth 2.0 authentication for Gmail API."""

import json
import subprocess
from pathlib import Path

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow

# Gmail API scopes
SCOPES = [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/gmail.compose",
    "https://www.googleapis.com/auth/gmail.labels",
]

TOKEN_DIR = Path.home() / ".gmail"
TOKEN_FILE = TOKEN_DIR / "token.json"
CREDENTIALS_FILE = TOKEN_DIR / "credentials.json"


def get_credentials() -> Credentials | None:
    """Load credentials from token file."""
    if not TOKEN_FILE.exists():
        return None
    with TOKEN_FILE.open() as f:
        token_data = json.load(f)
    creds = Credentials.from_authorized_user_info(token_data, SCOPES)
    if creds.expired and creds.refresh_token:
        creds.refresh(Request())
        save_credentials(creds)
    return creds if creds.valid else None


def save_credentials(creds: Credentials) -> None:
    """Save credentials to token file."""
    TOKEN_DIR.mkdir(parents=True, exist_ok=True)
    with TOKEN_FILE.open("w") as f:
        f.write(creds.to_json())
    TOKEN_FILE.chmod(0o600)


def login() -> Credentials:
    """Perform OAuth 2.0 login flow."""
    if not CREDENTIALS_FILE.exists():
        raise RuntimeError(
            "credentials.json not found. Download from Google Cloud Console "
            "(OAuth 2.0 Client ID, Desktop app) and place at "
            f"{CREDENTIALS_FILE}"
        )
    flow = InstalledAppFlow.from_client_secrets_file(CREDENTIALS_FILE, SCOPES)
    # Use a fixed redirect_uri for desktop apps
    creds = flow.run_local_server(
        port=0,
        bind_addr="127.0.0.1",
        open_browser=True,
        authorization_prompt_message="Opening browser...",
        success_message="Success! You can close this browser tab and return to the terminal.",
    )
    save_credentials(creds)
    return creds


def store_in_keychain(email: str, value: str) -> None:
    """Store OAuth refresh token or app password in macOS Keychain."""
    cmd = [
        "security",
        "add-generic-password",
        "-s",
        "gmail",
        "-a",
        email,
        "-w",
        value,
    ]
    subprocess.run(cmd, check=True)


def get_from_keychain(email: str) -> str | None:
    """Retrieve password from macOS Keychain."""
    try:
        cmd = ["security", "find-generic-password", "-s", "gmail", "-a", email, "-w"]
        result = subprocess.run(cmd, capture_output=True, text=True, check=True)
        return result.stdout.strip()
    except subprocess.CalledProcessError:
        return None
