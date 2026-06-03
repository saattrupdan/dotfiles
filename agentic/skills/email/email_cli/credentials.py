# pragma: no cover
"""Credential loading using macOS Keychain only."""

from __future__ import annotations

import subprocess


def get_credential(service: str, key: str) -> str | None:
    """Get a credential from macOS Keychain."""
    try:
        result = subprocess.run(
            ["security", "find-generic-password", "-s", service, "-a", key, "-w"],
            capture_output=True,
            text=True,
            check=True,
        )
        return result.stdout.strip()
    except subprocess.CalledProcessError:
        return None


def get_gmail_credentials() -> tuple[str | None, str | None]:
    """Get Gmail credentials from Keychain."""
    password = get_credential("gmail", "password")
    return (None, password)


def get_outlook_credentials() -> tuple[str | None, str | None]:
    """Get Outlook/M365 credentials from Keychain."""
    username = get_credential("outlook", "username")
    password = get_credential("outlook", "password")
    return (username, password)
