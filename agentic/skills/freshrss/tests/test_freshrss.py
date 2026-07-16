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
    InterestGroup,
    extract_content,
    extractive_summary,
    get_auth_token,
    get_token,
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
    def test_uses_update_flag(self, mock_run: MagicMock) -> None:
        """Should use -U flag to update credentials without delete-first."""
        mock_run.return_value = CompletedProcess([], 0, "", "")
        store_credentials("user", "pass")
        # Should only call add-generic-password once (with -U flag)
        mock_run.assert_called_once()
        call_args = mock_run.call_args[0][0]
        self.assertEqual(call_args[0], "add-generic-password")
        self.assertIn("-U", call_args)  # Update flag should be present

    @patch("freshrss.main.run_security")
    def test_returns_success_on_add(self, mock_run: MagicMock) -> None:
        """Should return True when add succeeds."""
        mock_run.return_value = CompletedProcess([], 0, "", "")
        result = store_credentials("user", "pass")
        self.assertTrue(result)

    @patch("freshrss.main.run_security")
    def test_returns_failure_on_add_error(self, mock_run: MagicMock) -> None:
        """Should return False when add fails."""
        mock_run.return_value = CompletedProcess([], 1, "", "")
        result = store_credentials("user", "pass")
        self.assertFalse(result)


class TestGetAuthToken(unittest.TestCase):
    """Tests for auth token retrieval via POST."""

    @patch("freshrss.main.urllib.request.urlopen")
    def test_uses_post_with_form_data(self, mock_urlopen: MagicMock) -> None:
        """Should use POST with form-encoded data, not URL query params."""
        mock_response = MagicMock()
        mock_response.__enter__.return_value.read.return_value = b"Auth=abc123"
        mock_urlopen.return_value = mock_response

        get_auth_token("http://localhost", "user", "pass")

        # Check that urlopen was called with POST and form data
        call_args = mock_urlopen.call_args[0][0]
        self.assertEqual(call_args.data, b"Email=user&Passwd=pass&service=reader")
        self.assertEqual(call_args.method, "POST")

    @patch("freshrss.main.urllib.request.urlopen")
    def test_excludes_non_ascii_from_service(self, mock_urlopen: MagicMock) -> None:
        """Should use service=reader without non-ASCII suffix."""
        mock_response = MagicMock()
        mock_response.__enter__.return_value.read.return_value = b"Auth=abc123"
        mock_urlopen.return_value = mock_response

        get_auth_token("http://localhost", "user", "pass")

        call_args = mock_urlopen.call_args[0][0]
        # Check no non-ASCII suffix in service param
        self.assertNotIn(b"service=reader\xe6\xb4\xbe", call_args.data)
        self.assertIn(b"service=reader", call_args.data)

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


class TestGetToken(unittest.TestCase):
    """Tests for edit token retrieval."""

    @patch("freshrss.main.urllib.request.urlopen")
    def test_fetches_token(self, mock_urlopen: MagicMock) -> None:
        """Should fetch token from /token endpoint."""
        mock_response = MagicMock()
        mock_response.__enter__.return_value.read.return_value = b"12345abcde"
        mock_urlopen.return_value = mock_response

        token = get_token("http://localhost", "auth_token")
        self.assertEqual(token, "12345abcde")

    @patch("freshrss.main.urllib.request.urlopen")
    def test_returns_none_on_error(self, mock_urlopen: MagicMock) -> None:
        """Should return None on connection error."""
        import urllib.error

        mock_urlopen.side_effect = urllib.error.URLError("Connection refused")
        token = get_token("http://localhost", "auth_token")
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
        groups: list[InterestGroup] = []
        grouped = group_items_for_digest(items, groups)
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
        groups: list[InterestGroup] = [
            {"name": "Programming", "keywords": ["python", "programming"]}
        ]
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
        groups: list[InterestGroup] = [
            {"name": "Tech", "keywords": ["python", "ai"]}
        ]
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

        groups: list[InterestGroup] = [{"name": "Test", "keywords": ["a"]}]
        save_interests(groups)
        mock_parent.mkdir.assert_called_once_with(parents=True, exist_ok=True)

    @patch("freshrss.main.INTERESTS_FILE")
    def test_save_writes_json(self, mock_file: MagicMock) -> None:
        """Should write JSON to file."""
        mock_handle = MagicMock()
        mock_file.open.return_value.__enter__.return_value = mock_handle

        groups: list[InterestGroup] = [{"name": "Tech", "keywords": ["python"]}]
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

    def test_subcommand_base_url(self) -> None:
        """Subcommands should accept --base-url."""
        from freshrss.main import main

        with patch.object(
            sys,
            "argv",
            ["freshrss", "--base-url", "http://test:9999", "unread", "--help"],
        ):
            with self.assertRaises(SystemExit) as cm:
                main()
            self.assertEqual(cm.exception.code, 0)


class TestExtractContent(unittest.TestCase):
    """Tests for extract_content helper."""

    def test_string_input(self) -> None:
        """Should return string as-is."""
        self.assertEqual(extract_content("plain text"), "plain text")

    def test_dict_with_content_key(self) -> None:
        """Should extract content from dict with content key."""
        raw = {"content": "nested content"}
        self.assertEqual(extract_content(raw), "nested content")

    def test_none_input(self) -> None:
        """Should return empty string for None."""
        self.assertEqual(extract_content(None), "")

    def test_empty_dict(self) -> None:
        """Should return empty string for dict without content key."""
        self.assertEqual(extract_content({}), "")

    def test_dict_with_non_string_content(self) -> None:
        """Should handle dict with non-string content."""
        raw = {"content": None}
        self.assertEqual(extract_content(raw), "")


class TestGroupItemsCrawlTimeMsec(unittest.TestCase):
    """Tests for crawlTimeMsec handling in group_items_for_digest."""

    def test_crawl_time_as_string(self) -> None:
        """Should handle crawlTimeMsec as string (FreshRSS actual format)."""
        items = [
            {
                "id": "1",
                "title": "Article 1",
                "origin": {"title": "Feed A"},
                "crawlTimeMsec": "1700000000000",  # String format from FreshRSS
            }
        ]
        groups: list[InterestGroup] = []
        grouped = group_items_for_digest(items, groups)
        # Should not crash and should group correctly
        self.assertIn("Feed A", grouped)
        self.assertEqual(len(grouped["Feed A"]["items"]), 1)

    def test_crawl_time_as_int(self) -> None:
        """Should still handle crawlTimeMsec as int for backwards compatibility."""
        items = [
            {
                "id": "1",
                "title": "Article 1",
                "origin": {"title": "Feed A"},
                "crawlTimeMsec": 1700000000000,  # Int format
            }
        ]
        groups: list[InterestGroup] = []
        grouped = group_items_for_digest(items, groups)
        self.assertIn("Feed A", grouped)

    def test_crawl_time_missing(self) -> None:
        """Should handle missing crawlTimeMsec."""
        items = [
            {
                "id": "1",
                "title": "Article 1",
                "origin": {"title": "Feed A"},
            }
        ]
        groups: list[InterestGroup] = []
        grouped = group_items_for_digest(items, groups)
        self.assertIn("Feed A", grouped)

    def test_crawl_time_empty_string(self) -> None:
        """Should handle empty string crawlTimeMsec."""
        items = [
            {
                "id": "1",
                "title": "Article 1",
                "origin": {"title": "Feed A"},
                "crawlTimeMsec": "",
            }
        ]
        groups: list[InterestGroup] = []
        grouped = group_items_for_digest(items, groups)
        self.assertIn("Feed A", grouped)


class TestBaseUrLPosition(unittest.TestCase):
    """Tests for --base-url argument position handling."""

    def test_base_url_top_level(self) -> None:
        """Top-level --base-url should be inherited by subcommand."""
        from freshrss.main import main

        with patch.object(
            sys,
            "argv",
            ["freshrss", "--base-url", "http://custom:9999", "health"],
        ):
            with patch("freshrss.main.cmd_health") as mock_health:
                mock_health.return_value = 0
                try:
                    main()
                except SystemExit:
                    pass
                # Check that cmd_health was called with args.base_url = custom URL
                call_args = mock_health.call_args[0][0]
                self.assertEqual(call_args.base_url, "http://custom:9999")

    def test_base_url_subcommand(self) -> None:
        """Subcommand --base-url should override top-level."""
        from freshrss.main import main

        with patch.object(
            sys,
            "argv",
            ["freshrss", "--base-url", "http://top:9999", "health", "--base-url", "http://sub:9999"],
        ):
            with patch("freshrss.main.cmd_health") as mock_health:
                mock_health.return_value = 0
                try:
                    main()
                except SystemExit:
                    pass
                call_args = mock_health.call_args[0][0]
                self.assertEqual(call_args.base_url, "http://sub:9999")

    def test_base_url_default(self) -> None:
        """Default base URL should be used when neither is provided."""
        from freshrss.main import DEFAULT_BASE_URL, main

        with patch.object(
            sys,
            "argv",
            ["freshrss", "health"],
        ):
            with patch("freshrss.main.cmd_health") as mock_health:
                mock_health.return_value = 0
                try:
                    main()
                except SystemExit:
                    pass
                call_args = mock_health.call_args[0][0]
                self.assertEqual(call_args.base_url, DEFAULT_BASE_URL)


if __name__ == "__main__":
    unittest.main()
