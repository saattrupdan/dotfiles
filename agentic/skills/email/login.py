"""Simple two-stage login to Microsoft OWA."""

import sys

import re

import subprocess
from argparse import ArgumentParser


def main() -> None:
    """Main function."""
    parser = ArgumentParser()
    parser.add_argument(
        "--mfa-code-approved",
        help="Whether the MFA code has been approved by the user.",
        action="store_true",
        default=False,
    )
    args = parser.parse_args()

    if not args.mfa_code_approved:
        code = get_mfa_code()
        print(f"Your MFA code is {code}")
    else:
        finish_login()
        print("Now logged in!")


def get_mfa_code() -> int:
    """Login to Microsoft OWA and return the MFA code.

    Returns:
        int: The MFA code.
    """
    _open_owa()
    _login()
    _get_to_mfa()
    while (mfa_code := _extract_code()) is None:
        _wait()
    return int(mfa_code)


def finish_login() -> None:
    """Finish the login process."""
    print("Finishing login...")
    while (finish_ref := _get_finish_click_ref()) is None:
        _wait()
    subprocess.run(
        ["agent-browser", "click", finish_ref],
        check=True,
        capture_output=True,
    )
    _wait()


def _open_owa() -> None:
    """Open Microsoft OWA in a new browser window."""
    subprocess.run(
        ["agent-browser", "close"],
        check=True,
        capture_output=True,
    )
    try:
        subprocess.run(
            [
                "agent-browser",
                "open",
                "--session-name",
                "outlook",
                "https://outlook.office365.com/mail",
            ],
            check=True,
            capture_output=True,
        )
    except subprocess.CalledProcessError as e:
        raise ConnectionError(
            "Failed to open Microsoft OWA - internet is probably down."
        ) from e
    _wait()


def _login() -> None:
    """Login to Microsoft OWA."""
    print("Logging in...")

    while (username_refs := _get_username_click_refs()) is None and (
        account_ref := _get_account_click_ref()
    ) is None:
        _wait()

    # If we have previously logged in, we can skip the username + password
    if account_ref is not None:
        subprocess.run(
            ["agent-browser", "click", account_ref],
            check=True,
            capture_output=True,
        )
        _wait()
        return

    assert username_refs is not None

    # Username
    subprocess.run(
        ["agent-browser", "type", username_refs[0], "dan.smart@alexandra.dk"],
        check=True,
        capture_output=True,
    )
    subprocess.run(
        ["agent-browser", "click", username_refs[1]],
        check=True,
        capture_output=True,
    )
    _wait()

    # Password
    while (password_refs := _get_password_click_refs()) is None:
        _wait()
    subprocess.run(
        ["agent-browser", "type", password_refs[0], "@UK9YKYC9U"],
        check=True,
        capture_output=True,
    )
    subprocess.run(
        ["agent-browser", "click", password_refs[1]],
        check=True,
        capture_output=True,
    )
    _wait()


def _get_to_mfa() -> None:
    print("Dealing with multi-factor authentication...")

    while (first_mfa_click_ref := _get_first_mfa_click_ref()) is None:
        _wait()
    subprocess.run(
        ["agent-browser", "click", first_mfa_click_ref],
        check=True,
        capture_output=True,
    )
    _wait()

    while (second_mfa_click_ref := _get_second_mfa_click_ref()) is None:
        _wait()
    subprocess.run(
        ["agent-browser", "click", second_mfa_click_ref],
        check=True,
        capture_output=True,
    )
    _wait()


def _extract_code() -> int | None:
    code_match = re.search(r'approve the request.*([0-9]{2})"', _snapshot())
    if code_match is None:
        # Sometimes step 2 fails and we need to do it again
        if (
            "verify your identity" in _snapshot()
            and (page_2_ref := _get_second_mfa_click_ref()) is not None
        ):
            subprocess.run(
                ["agent-browser", "click", page_2_ref],
                check=True,
                capture_output=True,
            )

        # Sometimes there's an extra 'security window'
        if "security window" in _snapshot():
            print("Extra security check. Open your app and follow the instructions.")
            sys.exit(0)
        return None

    return int(code_match.group(1))


def _get_username_click_refs() -> tuple[str, str] | None:
    input_ref = re.search(
        r"enter your email.* \[required, ref=([a-z]+[0-9]+)\]", _snapshot()
    )
    if input_ref is None:
        return None
    submit_ref = re.search(r'"next" \[ref=([a-z]+[0-9]+)\]', _snapshot())
    if submit_ref is None:
        return None
    return ("@" + input_ref.group(1), "@" + submit_ref.group(1))


def _get_account_click_ref() -> str | None:
    ref = re.search(r"sign in with.* \[ref=([a-z]+[0-9]+)\]", _snapshot())
    if ref is None:
        return None
    return "@" + ref.group(1)


def _get_password_click_refs() -> tuple[str, str] | None:
    input_ref = re.search(
        r"enter the password.* \[required, ref=([a-z]+[0-9]+)\]", _snapshot()
    )
    if input_ref is None:
        return None
    submit_ref = re.search(r'"sign in" \[ref=([a-z]+[0-9]+)\]', _snapshot())
    if submit_ref is None:
        return None
    return ("@" + input_ref.group(1), "@" + submit_ref.group(1))


def _get_first_mfa_click_ref() -> str | None:
    ref = re.search(r"sign in another way.* \[ref=([a-z]+[0-9]+)\]", _snapshot())
    if ref is None:
        return None
    return "@" + ref.group(1)


def _get_second_mfa_click_ref() -> str | None:
    ref = re.search(r"microsoft authenticator.* \[ref=([a-z]+[0-9]+)\]", _snapshot())
    if ref is None:
        return None
    return "@" + ref.group(1)


def _get_finish_click_ref() -> str | None:
    ref = re.search(r'button "yes".* \[ref=([a-z]+[0-9]+)\]', _snapshot())
    if ref is None:
        return None
    return "@" + ref.group(1)


def _snapshot() -> str:
    """Take a snapshot of the current browser window.

    Returns:
        str: The snapshot.
    """
    return (
        subprocess.run(
            ["agent-browser", "snapshot", "-c"],
            capture_output=True,
            text=True,
            check=True,
            encoding="utf-8",
        )
        .stdout.strip()
        .lower()
    )


def _wait(milliseconds: int = 500) -> None:
    """Wait for some time."""
    subprocess.run(
        ["agent-browser", "wait", str(milliseconds)],
        check=True,
        capture_output=True,
    )


if __name__ == "__main__":
    main()
