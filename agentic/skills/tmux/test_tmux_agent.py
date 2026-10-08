"""Integration checks against a private tmux socket (never the user's server)."""

import os
import subprocess
import time
import unittest
from pathlib import Path

CLI = Path(__file__).with_name("tmux-agent")


class CleanupTests(unittest.TestCase):
    def setUp(self):
        self.socket = f"pi-agent-test-{os.getpid()}"
        self.tmux = ["tmux", "-L", self.socket]

    def tearDown(self):
        subprocess.run([*self.tmux, "kill-server"], capture_output=True, check=False)

    def call(self, *args):
        return subprocess.run(args, text=True, capture_output=True, check=True).stdout

    def helper(self, *args):
        return self.call(str(CLI), "--socket", self.socket, *args)

    def exists(self, name):
        return (
            subprocess.run(
                [*self.tmux, "has-session", "-t", name],
                capture_output=True,
                check=False,
            ).returncode
            == 0
        )

    def send(self, name, command):
        self.call(*self.tmux, "send-keys", "-t", f"{name}:0.0", "-l", command)
        self.call(*self.tmux, "send-keys", "-t", f"{name}:0.0", "Enter")

    def test_only_idle_tagged_sessions_are_closed(self):
        for name in ("idle", "running", "background", "multipane"):
            self.helper("start", name, str(CLI.parent))
        self.call(*self.tmux, "new-session", "-d", "-s", "user")
        self.assertEqual(
            self.call(
                *self.tmux, "show-option", "-qv", "-t", "idle", "@pi_agent"
            ).strip(),
            "1",
        )
        self.send("running", "sleep 30")
        self.send("background", "sleep 30 &")
        self.call(*self.tmux, "split-window", "-d", "-t", "multipane:0")
        self.call(*self.tmux, "send-keys", "-t", "multipane:0.1", "-l", "sleep 30")
        self.call(*self.tmux, "send-keys", "-t", "multipane:0.1", "Enter")
        time.sleep(0.5)
        self.helper("cleanup")
        self.assertFalse(self.exists("idle"))
        for name in ("running", "background", "multipane", "user"):
            self.assertTrue(self.exists(name), name)
        self.call(*self.tmux, "send-keys", "-t", "running:0.0", "C-c")
        self.send("background", "kill $(jobs -pr)")
        self.call(*self.tmux, "send-keys", "-t", "multipane:0.1", "C-c")
        time.sleep(0.5)
        self.helper("cleanup")
        for name in ("running", "background", "multipane"):
            self.assertFalse(self.exists(name), name)
        self.assertTrue(self.exists("user"))


if __name__ == "__main__":
    unittest.main()
