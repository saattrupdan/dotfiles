#!/usr/bin/env python3
"""
Does this terminal report key-RELEASE events (Kitty keyboard protocol, flag 2)?

That capability is what decides whether pi's voice-input extension can do true
hold-to-talk (press-and-hold, release to stop) versus falling back to tap-to-
toggle. Run this INSIDE the terminal you use for pi:

    ! python3 ~/.pi/agent/extensions/voice-input/verify-key-release.py

Then, when prompted, press and release a single key (e.g. F8 or the spacebar).
The script enables the Kitty protocol with flag 7 (which includes release
reporting), reads the raw escape sequences your terminal emits, and tells you
whether a distinct release event arrived.
"""

import os
import select
import sys
import termios
import tty

# Kitty progressive-enhancement flags: 1 disambiguate + 2 report-event-types
# (press/repeat/RELEASE) + 4 report-alternate-keys = 7. The trailing CSI c
# (DA1) gives us something every terminal answers, so we never hang.
ENABLE = "\x1b[>7u"
DISABLE = "\x1b[<u"


def main() -> int:
    if not sys.stdin.isatty():
        print("Not a TTY — run this directly in your terminal, not piped.")
        return 2

    fd = sys.stdin.fileno()
    old = termios.tcgetattr(fd)
    saw_release = False
    chunks: list[str] = []
    try:
        tty.setraw(fd)
        sys.stdout.write(ENABLE)
        sys.stdout.flush()

        sys.stderr.write("\r\nPress and release ONE key (e.g. F8 or space)… ")
        sys.stderr.flush()

        # Collect input for up to ~4s of idle time after the first byte.
        deadline_idle = 4.0
        first = True
        while True:
            timeout = 6.0 if first else deadline_idle
            r, _, _ = select.select([fd], [], [], timeout)
            if not r:
                break
            data = os.read(fd, 1024).decode("latin-1", "replace")
            if not data:
                break
            first = False
            chunks.append(data)
            # Kitty release events carry an event-type of 3: "…:3u" / "…:3~" /
            # "…:3<letter>". A repeat is ":2", a press ":1" (or no suffix).
            if any(m in data for m in (":3u", ":3~", ":3A", ":3B", ":3C", ":3D", ":3H", ":3F")):
                saw_release = True
            # Stop early once we've seen a release.
            if saw_release:
                break
    finally:
        sys.stdout.write(DISABLE)
        sys.stdout.flush()
        termios.tcsetattr(fd, termios.TCSADRAIN, old)

    raw = "".join(chunks)
    printable = raw.replace("\x1b", "\\x1b")
    sys.stderr.write("\r\n\r\n")
    print(f"Raw sequence(s) received: {printable!r}")
    if saw_release:
        print("\n✅ This terminal REPORTS key releases.")
        print("   → voice-input can do TRUE hold-to-talk (hold key, release to stop).")
    else:
        print("\n❌ No key-release event detected.")
        print("   → This terminal is legacy-only; voice-input falls back to")
        print("     tap-to-toggle (press to start, press again to stop).")
        print("   Terminals that support releases: Ghostty, Kitty, WezTerm, foot.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
