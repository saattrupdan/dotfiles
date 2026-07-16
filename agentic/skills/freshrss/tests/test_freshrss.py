"""Unit tests for freshrss CLI - no live FreshRSS or Keychain required."""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path
from subprocess import CompletedProcess
from unittest.mock import MagicMock, patch

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

from freshrss.main import (
    KEYCHAIN_SERVICE,
    build_auth_url,
    extractive_summary,
    get_auth_token,
    group_items_for_digest,
    load_interests,
    run_security,
    save_interests,
    store_credentials,
    strip_html,
)


class TestStripHtml(unittest.TestCase):
    """Tests for HTML stripping utility."""

    def test_strips_tags(self) -> None:
        """Should remove HTML tags."""
        self.assertEqual(strip_html("<p>Hello <b>World</b></p>"), "Hello World")

    def test_decodes_entities(self) -> None:
        """Should decode HTML entities."""
        self.assertEqual(strip_html("&lt;script&gt;"), "<script>")

    def test_collapses_whitespace(self) -> None:
        """Should collapse multiple whitespace."""
        self.assertEqual(strip_html("Hello    World"), "Hello World")

    def test_empty_input(self) -> None:
        """Should handle empty input."""
        self.assertEqual(strip_html(""), "")

    def test_mixed_content(self) -> None:
        """Should handle mixed HTML content."""
        result = strip_html("<div>Line 1</div><div>Line 2</div>")
        self.assertIn("Line 1", result)
        self.assertIn("Line 2", result)


class TestRunSecurity(unittest.TestCase):
    """Tests for security command wrapper."""

    @patch("freshrss.main.subprocess.run")
    def test_calls_security_binary(self, mock_run: MagicMock) -> None:
        """Should call /usr/bin/security with correct args."""
        mock_run.return_value = CompletedProcess([], 0, "", "")
        run_security(["find-generic-password", "-s", "test"])
        mock_run.assert_called_once()
        call_args = mock_run.call_args[0][0]
        self.assertEqual(call_args[0], "/usr/bin/security")
        self.assertEqual(call_args[1], "find-generic-password")

    @patch("freshrss.main.subprocess.run")
    def test_passes_stdin_when_provided(self, mock_run: MagicMock) -> None:
        """Should encode and pass stdin input."""
        mock_run.return_value = CompletedProcess([], 0, "", "")
        run_security(["add-generic-password"], input_data="secret")
        call_kwargs = mock_run.call_args[1]
        self.assertEqual(call_kwargs["input"], b"secret")

    @patch("freshrss.main.subprocess.run")
    def test_no_stdin_when_none(self, mock_run: MagicMock) -> None:
        """Should not pass stdin when None."""
        mock_run.return_value = CompletedProcess([], 0, "", "")
        run_security(["find-generic-password"], input_data=None)
        call_kwargs = mock_run.call_args[1]
        self.assertIsNone(call_kwargs["input"])


class TestStoreCredentials(unittest.TestCase):
    """Tests for credential storage."""

    @patch("freshrss.main.run_security")
    def test_deletes_existing_first(self, mock_run: MagicMock) -> None:
        """Should delete existing credentials before adding."""
        mock_run.return_value = CompletedProcess([], 0, "", "")
        store_credentials("user", "pass")
        calls = mock_run.call_args_list
        self.assertEqual(len(calls), 2)
        # First call should be delete
        self.assertEqual(calls[0][0][0][0], "delete-generic-password")

    @patch("freshrss.main.run_security")
    def test_returns_success_on_add(self, mock_run: MagicMock) -> None:
        """Should return True when add succeeds."""
        mock_run.return_value = CompletedProcess([], 0, "", "")
        result = store_credentials("user", "pass")
        self.assertTrue(result)

    @patch("freshrss.main.run_security")
    def test_returns_failure_on_add_error(self, mock_run: MagicMock) -> None:
        """Should return False when add fails."""
        mock_run.side_effect = [
            CompletedProcess([], 0, "", ""),  # delete succeeds
            CompletedProcess([], 1, "", ""),  # add fails
        ]
        result = store_credentials("user", "pass")
        self.assertFalse(result)


class TestBuildAuthUrl(unittest.TestCase):
    """Tests for authentication URL building."""

    def test_builds_correct_url(self) -> None:
        """Should build correct authentication URL."""
        url = build_auth_url("http://localhost:9999", "user", "pass")
        self.assertIn("http://localhost:9999/api/greader.php", url)
        self.assertIn("Email=user", url)
        self.assertIn("Passwd=pass", url)
        self.assertIn("service=reader", url)

    def test_url_encodes_special_chars(self) -> None:
        """Should URL-encode special characters in credentials."""
        url = build_auth_url("http://localhost:9999", "user@test.com", "p@ss")
        self.assertIn("Email=user%40test.com", url)


class TestGetAuthToken(unittest.TestCase):
    """Tests for auth token retrieval."""

    @patch("freshrss.main.urllib.request.urlopen")
    def test_extracts_auth_token(self, mock_urlopen: MagicMock) -> None:
        """Should extract Auth= token from response."""
        mock_response = MagicMock()
        mock_response.__enter__.return_value.read.return_value = b"Auth=abc123\nSid=xyz"
        mock_urlopen.return_value = mock_response

        token = get_auth_token("http://localhost", "user", "pass")
        self.assertEqual(token, "abc123")

    @patch("freshrss.main.urllib.request.urlopen")
    def test_returns_none_on_no_auth(self, mock_urlopen: MagicMock) -> None:
        """Should return None when no Auth= in response."""
        mock_response = MagicMock()
        mock_response.__enter__.return_value.read.return_value = b"Error=BadAuth"
        mock_urlopen.return_value = mock_response

        token = get_auth_token("http://localhost", "user", "pass")
        self.assertIsNone(token)

    @patch("freshrss.main.urllib.request.urlopen")
    def test_returns_none_on_connection_error(
        self, mock_urlopen: MagicMock
    ) -> None:
        """Should return None on connection error."""
        import urllib.error

        mock_urlopen.side_effect = urllib.error.URLError("Connection refused")
        token = get_auth_token("http://localhost", "user", "pass")
        self.assertIsNone(token)


class TestGroupItemsForDigest(unittest.TestCase):
    """Tests for digest grouping logic."""

    def test_groups_by_feed(self) -> None:
        """Should group items by feed title."""
        items = [
            {
                "id": "1",
                "title": "Article 1",
                "origin": {"title": "Feed A"},
                "crawlTimeMsec": 1000,
            },
            {
                "id": "2",
                "title": "Article 2",
                "origin": {"title": "Feed A"},
                "crawlTimeMsec": 2000,
            },
            {
                "id": "3",
                "title": "Article 3",
                "origin": {"title": "Feed B"},
                "crawlTimeMsec": 3000,
            },
        ]
        grouped = group_items_for_digest(items, [])
        self.assertEqual(len(grouped), 2)
        self.assertIn("Feed A", grouped)
        self.assertIn("Feed B", grouped)
        self.assertEqual(len(grouped["Feed A"]["items"]), 2)

    def test_groups_by_interest_match(self) -> None:
        """Should group matching items by interest name."""
        items = [
            {
                "id": "1",
                "title": "Python Tutorial",
                "content": "Learn Python programming",
                "origin": {"title": "DevFeed"},
                "crawlTimeMsec": 1000,
            }
        ]
        groups = [{"name": "Programming", "keywords": ["python", "programming"]}]
        grouped = group_items_for_digest(items, groups)
        self.assertIn("Programming", grouped)
        self.assertTrue(grouped["Programming"]["interest"])

    def test_no_match_uses_feed(self) -> None:
        """Should use feed title when no interest match."""
        items = [
            {
                "id": "1",
                "title": "Random News",
                "content": "Nothing special here",
                "origin": {"title": "NewsFeed"},
                "crawlTimeMsec": 1000,
            }
        ]
        groups = [{"name": "Tech", "keywords": ["python", "ai"]}]
        grouped = group_items_for_digest(items, groups)
        self.assertIn("NewsFeed", grouped)
        self.assertFalse(grouped["NewsFeed"]["interest"])


class TestExtractiveSummary(unittest.TestCase):
    """Tests for extractive summary."""

    def test_returns_first_sentences(self) -> None:
        """Should return first N sentences."""
        text = "First sentence. Second sentence! Third sentence?"
        result = extractive_summary(text, max_sentences=2)
        self.assertEqual(result, "First sentence. Second sentence!")

    def test_handles_short_text(self) -> None:
        """Should handle text with fewer sentences than requested."""
        text = "Just one sentence."
        result = extractive_summary(text, max_sentences=5)
        self.assertEqual(result, "Just one sentence.")

    def test_default_limit(self) -> None:
        """Should default to 2 sentences."""
        text = "One. Two. Three. Four."
        result = extractive_summary(text)
        self.assertEqual(result, "One. Two.")


class TestInterestsStorage(unittest.TestCase):
    """Tests for interests file operations."""

    @patch("freshrss.main.INTERESTS_FILE")
    def test_load_empty_when_no_file(self, mock_file: MagicMock) -> None:
        """Should return empty list when file doesn't exist."""
        mock_file.exists.return_value = False
        result = load_interests()
        self.assertEqual(result, [])

    @patch("freshrss.main.INTERESTS_FILE")
    def test_load_from_file(self, mock_file: MagicMock) -> None:
        """Should load interests from file."""
        mock_file.exists.return_value = True
        data = {"groups": [{"name": "Test", "keywords": ["a", "b"]}]}
        mock_file.open.return_value.__enter__.return_value = MagicMock()
        mock_file.open.return_value.__enter__.return_value.read.return_value = (
            json.dumps(data)
        )

        result = load_interests()
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["name"], "Test")

    @patch("freshrss.main.INTERESTS_FILE")
    def test_save_creates_parent_dirs(self, mock_file: MagicMock) -> None:
        """Should create parent directories when saving."""
        mock_parent = MagicMock()
        mock_file.parent = mock_parent
        mock_file.open.return_value.__enter__.return_value = MagicMock()

        save_interests([{"name": "Test", "keywords": ["a"]}])
        mock_parent.mkdir.assert_called_once_with(parents=True, exist_ok=True)

    @patch("freshrss.main.INTERESTS_FILE")
    def test_save_writes_json(self, mock_file: MagicMock) -> None:
        """Should write JSON to file."""
        mock_handle = MagicMock()
        mock_file.open.return_value.__enter__.return_value = mock_handle

        groups = [{"name": "Tech", "keywords": ["python"]}]
        save_interests(groups)

        mock_handle.write.assert_called()
        # Collect all write calls (json.dump writes in chunks)
        written = "".join(call[0][0] for call in mock_handle.write.call_args_list)
        parsed = json.loads(written)
        self.assertEqual(parsed["groups"][0]["name"], "Tech")


class TestCLIHelp(unittest.TestCase):
    """Tests for CLI help output."""

    def test_main_help(self) -> None:
        """Main command should show help."""
        from freshrss.main import main

        with patch.object(sys, "argv", ["freshrss", "--help"]):
            with self.assertRaises(SystemExit) as cm:
                main()
            # Help exits with 0
            self.assertEqual(cm.exception.code, 0)

    def test_init_help(self) -> None:
        """Init subcommand should show help."""
        from freshrss.main import main

        with patch.object(sys, "argv", ["freshrss", "init", "--help"]):
            with self.assertRaises(SystemExit) as cm:
                main()
            self.assertEqual(cm.exception.code, 0)

    def test_unread_help(self) -> None:
        """Unread subcommand should show help."""
        from freshrss.main import main

        with patch.object(sys, "argv", ["freshrss", "unread", "--help"]):
            with self.assertRaises(SystemExit) as cm:
                main()
            self.assertEqual(cm.exception.code, 0)


if __name__ == "__main__":
    unittest.main()
