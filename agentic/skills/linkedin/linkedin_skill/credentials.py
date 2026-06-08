"""Credential loading using macOS Keychain."""

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


def save_credential(service: str, key: str, value: str) -> None:
    """Save a credential to macOS Keychain."""
    subprocess.run(
        ["security", "add-generic-password", "-s", service, "-a", key, "-w", value],
        check=True,
    )


def get_linkedin_credentials() -> tuple[str | None, str | None]:
    """Get LinkedIn credentials from Keychain."""
    username = get_credential("linkedin", "username")
    password = get_credential("linkedin", "password")
    return (username, password)
