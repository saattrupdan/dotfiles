"""Account configuration and ``.env`` loading.

Accounts live in ``~/.email/accounts.json``. Authentication is handled via
``agent-browser`` with Microsoft Authenticator MFA. The directory stores OWA
session state files.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

CONFIG_DIR = Path.home() / ".email"
ACCOUNTS_PATH = CONFIG_DIR / "accounts.json"


class ConfigError(Exception):
    """Raised when account configuration is missing or invalid."""


def _load_env(env_path: Path) -> None:
    """Parse a simple ``.env`` file and set ``KEY=VALUE`` pairs into ``os.environ``.

    Skips blank lines and comments, strips surrounding quotes, and never
    overwrites a variable already set in the environment. Silently passes if the
    file does not exist or cannot be read.

    Args:
        env_path:
            Path to the ``.env`` file.
    """
    try:
        text = env_path.read_text(encoding="utf-8")
    except OSError:
        return
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, _, raw_value = stripped.partition("=")
        key = key.strip()
        value = raw_value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ('"', "'"):
            value = value[1:-1]
        os.environ.setdefault(key, value)


def load_dotenvs() -> None:
    """Load ``./.env`` then ``~/.env`` (first wins, environment always wins)."""
    _load_env(Path(".env"))
    _load_env(Path.home() / ".env")


def _ensure_dir() -> None:
    """Create the config directory with private (0700) permissions."""
    CONFIG_DIR.mkdir(mode=0o700, exist_ok=True)


def load_config() -> dict:
    """Read ``accounts.json``, returning an empty skeleton if it is absent."""
    try:
        return json.loads(ACCOUNTS_PATH.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {"default": None, "accounts": {}}
    except (OSError, json.JSONDecodeError) as exc:
        raise ConfigError(f"Could not read {ACCOUNTS_PATH}: {exc}") from exc


def save_config(config: dict) -> None:
    """Write ``accounts.json`` atomically with private (0600) permissions."""
    _ensure_dir()
    tmp = ACCOUNTS_PATH.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(config, indent=2, ensure_ascii=False), encoding="utf-8")
    tmp.chmod(0o600)
    tmp.replace(ACCOUNTS_PATH)


def resolve_account(config: dict, name: str | None) -> tuple[str, dict]:
    """Return the ``(name, account)`` for ``name`` or the configured default.

    Args:
        config:
            The loaded configuration.
        name:
            An explicit account name, or ``None`` to use the default.

    Returns:
        The resolved account name and its settings dict.

    Raises:
        ConfigError:
            If no account matches, or no default is set and ``name`` is ``None``.
    """
    accounts = config.get("accounts", {})
    if not accounts:
        raise ConfigError(
            "No accounts configured. Add one with: email accounts add ..."
        )
    if name is None:
        name = config.get("default")
        if name is None:
            raise ConfigError(
                "No --account given and no default set. "
                "Pass --account NAME or add an account with --default."
            )
    account = accounts.get(name)
    if account is None:
        known = ", ".join(sorted(accounts)) or "(none)"
        raise ConfigError(f"Unknown account '{name}'. Configured accounts: {known}")
    return name, account


def token_cache_path(name: str) -> Path:
    """Path to the MSAL token cache for a Graph account."""
    return CONFIG_DIR / f"{name}.msal.json"


# Password env vars removed - OWA uses browser session authentication only
