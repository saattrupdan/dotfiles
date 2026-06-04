"""Email transport backends.

Each account is served by exactly one backend, chosen by its ``backend`` field:

- ``owa`` — :class:`~email_cli.backends.owa.OwaBackend` (Microsoft 365 via browser)
"""

from __future__ import annotations

from .base import Backend, BackendError


def get_backend(name: str, account: dict) -> Backend:
    """Instantiate the backend for an account.

    Args:
        name:
            The account name (used for token-cache file naming).
        account:
            The account settings dict from ``accounts.json``.

    Returns:
        A ready-to-use backend instance.

    Raises:
        BackendError:
            If the account's ``backend`` is unknown.
    """
    kind = account.get("backend")
    if kind == "owa":
        from .owa import OwaBackend

        return OwaBackend(name=name, account=account)
    raise BackendError(f"Unknown backend '{kind}' for account '{name}'.")


__all__ = ["Backend", "BackendError", "get_backend"]
