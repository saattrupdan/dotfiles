# pragma: no cover
"""Credential loading using existing password manager CLIs — no .env files."""

from __future__ import annotations

import json
import shutil
import subprocess


def _run_command(args: list[str]) -> str | None:
    """Run a command and return stdout, or None if it fails."""
    try:
        result = subprocess.run(args, capture_output=True, text=True, timeout=10)
        if result.returncode == 0:
            return result.stdout.strip()
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        pass
    return None


def _get_from_keychain(service: str, key: str) -> str | None:
    """Get credential from macOS Keychain."""
    if shutil.which("security") is None:
        return None
    account = f"skill.{service}.{key}"
    return _run_command([
        "security", "find-generic-password", "-s", "skill-credentials",
        "-a", account, "-w",
    ])


def _get_from_bw(service: str, key: str) -> str | None:
    """Get credential from Bitwarden CLI."""
    if shutil.which("bw") is None:
        return None
    try:
        result = subprocess.run(["bw", "status"], capture_output=True, text=True, timeout=5)
        if result.returncode != 0:
            return None
        status = json.loads(result.stdout)
        if status.get("status") != "unlocked":
            return None
    except Exception:
        return None
    output = _run_command(["bw", "list", "items", "--search", f"skill-{service}"])
    if not output or output == "[]":
        return None
    try:
        items = json.loads(output)
        if not items:
            return None
        item_id = items[0].get("id")
        if not item_id:
            return None
        output = _run_command(["bw", "get", "item", item_id])
        if output:
            item = json.loads(output)
            if key == "username":
                return item.get("login", {}).get("username")
            elif key == "password":
                return item.get("login", {}).get("password")
    except Exception:
        pass
    return None


def _get_from_op(service: str, key: str) -> str | None:
    """Get credential from 1Password CLI."""
    if shutil.which("op") is None:
        return None
    output = _run_command(["op", "item", "get", f"skill-{service}"])
    if not output:
        return None
    try:
        item = json.loads(output)
        if key == "username":
            return item.get("username")
        elif key == "password":
            return item.get("password")
    except Exception:
        pass
    return None


def _get_from_lpass(service: str, key: str) -> str | None:
    """Get credential from LastPass CLI."""
    if shutil.which("lpass") is None:
        return None
    output = _run_command(["lpass", "show", "--color", "never", f"skill-{service}"])
    if not output:
        return None
    for line in output.splitlines():
        if line.lower().startswith(f"{key}:"):
            return line.split(":", 1)[1].strip()
    return None


def _get_from_pass(service: str, key: str) -> str | None:
    """Get credential from pass (password-store)."""
    if shutil.which("pass") is None:
        return None
    return _run_command(["pass", "show", f"skills/{service}/{key}"])


def get_credential(service: str, key: str) -> str | None:
    """Get a credential from secure backends only."""
    for getter in [
        lambda: _get_from_keychain(service, key),
        lambda: _get_from_bw(service, key),
        lambda: _get_from_op(service, key),
        lambda: _get_from_lpass(service, key),
        lambda: _get_from_pass(service, key),
    ]:
        value = getter()
        if value:
            return value
    return None


def get_gmail_credentials() -> tuple[str | None, str | None]:
    """Get Gmail credentials."""
    username = get_credential("gmail", "username")
    password = get_credential("gmail", "password")
    return (username, password)


def get_outlook_credentials() -> tuple[str | None, str | None]:
    """Get Outlook/M365 credentials."""
    username = get_credential("outlook", "username")
    password = get_credential("outlook", "password")
    return (username, password)
