"""Unit tests for freshrss CLI - no live FreshRSS or Keychain required."""

from __future__ import annotations

import argparse
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
    _derive_topic,
    cmd_health,
    cmd_read,
    cmd_unread,
    extract_content,
    extractive_summary,
    get_auth_token,
    get_credentials,
    get_token,
    group_items_for_digest,
    list_items,
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
    def test_returns_none_on_connection_error(self, mock_urlopen: MagicMock) -> None:
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

    def test_groups_by_topic_not_feed(self) -> None:
        """Should group items by derived topic, not by feed title."""
        items = [
            {
                "id": "1",
                "title": "Python coding tips",
                "origin": {"title": "Feed A"},
                "crawlTimeMsec": 1000,
            },
            {
                "id": "2",
                "title": "More programming advice",
                "origin": {"title": "Feed A"},
                "crawlTimeMsec": 2000,
            },
            {
                "id": "3",
                "title": "AI breakthrough announced",
                "origin": {"title": "Feed B"},
                "crawlTimeMsec": 3000,
            },
        ]
        groups: list[InterestGroup] = []
        grouped = group_items_for_digest(items, groups)
        # Items should be grouped by topic (Programming, AI & Machine Learning)
        # not by feed name
        self.assertIn("Programming", grouped)
        self.assertIn("AI & Machine Learning", grouped)
        self.assertEqual(len(grouped["Programming"]["items"]), 2)
        # Sources should track feeds as metadata
        self.assertIn("Feed A", grouped["Programming"]["sources"])

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

    def test_no_match_uses_topic_bucket(self) -> None:
        """Should use derived topic bucket when no interest match (not feed)."""
        items = [
            {
                "id": "1",
                "title": "Random News",
                "content": "Nothing special here",
                "origin": {"title": "NewsFeed"},
                "crawlTimeMsec": 1000,
            }
        ]
        groups: list[InterestGroup] = [{"name": "Tech", "keywords": ["python", "ai"]}]
        grouped = group_items_for_digest(items, groups)
        # Should use neutral "General" bucket for non-interest items
        self.assertIn("General", grouped)
        self.assertFalse(grouped["General"]["interest"])
        # Feed should be tracked as source metadata, not as group name
        self.assertIn("NewsFeed", grouped["General"]["sources"])
        self.assertEqual(grouped["General"]["topic"], "General")


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


class TestDeriveTopic(unittest.TestCase):
    """Tests for _derive_topic function."""

    def test_derives_ai_topic(self) -> None:
        """Should derive AI topic from relevant keywords."""
        title = "New AI Model Released"
        content = "The latest machine learning breakthrough"
        result = _derive_topic(title, content)
        self.assertEqual(result, "AI & Machine Learning")

    def test_derives_programming_topic(self) -> None:
        """Should derive Programming topic from code-related keywords."""
        title = "Python Best Practices"
        content = "Tips for writing better code"
        result = _derive_topic(title, content)
        self.assertEqual(result, "Programming")

    def test_derives_technology_topic(self) -> None:
        """Should derive Technology topic from tech keywords."""
        title = "New Smartphone Launch"
        content = "Latest device features improved hardware"
        result = _derive_topic(title, content)
        self.assertEqual(result, "Technology")

    def test_derives_science_topic(self) -> None:
        """Should derive Science topic from research keywords."""
        title = "Research Breakthrough"
        content = "Scientists discover new phenomenon in laboratory"
        result = _derive_topic(title, content)
        self.assertEqual(result, "Science")

    def test_derives_health_topic(self) -> None:
        """Should derive Health topic from medical keywords."""
        title = "New Medicine Released"
        content = "Hospital treatment works for disease patients"
        result = _derive_topic(title, content)
        self.assertEqual(result, "Health")

    def test_derives_business_topic(self) -> None:
        """Should derive Business topic from company keywords."""
        title = "Startup Merger Announced"
        content = "Firm reports revenue growth and new CEO hired"
        result = _derive_topic(title, content)
        self.assertEqual(result, "Business")

    def test_derives_climate_topic(self) -> None:
        """Should derive Climate topic from environment keywords."""
        title = "Climate Report Released"
        content = "Carbon emission targets for renewable energy"
        result = _derive_topic(title, content)
        self.assertEqual(result, "Climate & Environment")

    def test_derives_security_topic(self) -> None:
        """Should derive Security topic from cybersecurity keywords."""
        title = "Data Breach Disclosed"
        content = "Hackers exploit system vulnerability for cyber attack"
        result = _derive_topic(title, content)
        self.assertEqual(result, "Security")

    def test_defaults_to_general(self) -> None:
        """Should use General bucket when no topic keywords match."""
        title = "Random News Update"
        content = "Nothing special here today"
        result = _derive_topic(title, content)
        self.assertEqual(result, "General")

    def test_case_insensitive(self) -> None:
        """Topic matching should be case-insensitive."""
        title = "PYTHON Programming GUIDE"
        content = "Learn CODE development"
        result = _derive_topic(title, content)
        self.assertEqual(result, "Programming")


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


class TestCmdHealth(unittest.TestCase):
    """Tests for cmd_health exit code logic."""

    @patch("freshrss.main.get_auth_token")
    @patch("freshrss.main.get_credentials")
    @patch("freshrss.main.check_freshrss_reachable")
    def test_health_reachable_no_creds(
        self,
        mock_reachable: MagicMock,
        mock_creds: MagicMock,
        mock_auth: MagicMock,
    ) -> None:
        """Should exit 0 when reachable and no credentials configured."""
        mock_reachable.return_value = (True, "FreshRSS is reachable")
        mock_creds.return_value = None

        args = argparse.Namespace(base_url="http://localhost:9999")
        result = cmd_health(args)
        self.assertEqual(result, 0)

    @patch("freshrss.main.list_streams")
    @patch("freshrss.main.get_auth_token")
    @patch("freshrss.main.get_credentials")
    @patch("freshrss.main.check_freshrss_reachable")
    def test_health_reachable_auth_success(
        self,
        mock_reachable: MagicMock,
        mock_creds: MagicMock,
        mock_auth: MagicMock,
        mock_streams: MagicMock,
    ) -> None:
        """Should exit 0 when reachable and auth succeeds."""
        mock_reachable.return_value = (True, "FreshRSS is reachable")
        mock_creds.return_value = ("user", "pass")
        mock_auth.return_value = "auth_token_123"
        mock_streams.return_value = []

        args = argparse.Namespace(base_url="http://localhost:9999")
        result = cmd_health(args)
        self.assertEqual(result, 0)

    @patch("freshrss.main.get_auth_token")
    @patch("freshrss.main.get_credentials")
    @patch("freshrss.main.check_freshrss_reachable")
    def test_health_reachable_auth_failure(
        self,
        mock_reachable: MagicMock,
        mock_creds: MagicMock,
        mock_auth: MagicMock,
    ) -> None:
        """Should exit 1 when reachable but auth fails with credentials configured."""
        mock_reachable.return_value = (True, "FreshRSS is reachable")
        mock_creds.return_value = ("user", "pass")
        mock_auth.return_value = None

        args = argparse.Namespace(base_url="http://localhost:9999")
        result = cmd_health(args)
        self.assertEqual(result, 1)

    @patch("freshrss.main.get_credentials")
    @patch("freshrss.main.check_freshrss_reachable")
    def test_health_not_reachable(
        self,
        mock_reachable: MagicMock,
        mock_creds: MagicMock,
    ) -> None:
        """Should exit 1 when FreshRSS is not reachable."""
        mock_reachable.return_value = (False, "Connection refused")
        mock_creds.return_value = None

        args = argparse.Namespace(base_url="http://localhost:9999")
        result = cmd_health(args)
        self.assertEqual(result, 1)


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
        # Should not crash and should group by topic (General for generic article)
        self.assertIn("General", grouped)
        self.assertEqual(len(grouped["General"]["items"]), 1)
        # Feed should be tracked as source metadata
        self.assertIn("Feed A", grouped["General"]["sources"])

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
        self.assertIn("General", grouped)

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
        self.assertIn("General", grouped)

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
        self.assertIn("General", grouped)


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
            [
                "freshrss",
                "--base-url",
                "http://top:9999",
                "health",
                "--base-url",
                "http://sub:9999",
            ],
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


class TestGetCredentials(unittest.TestCase):
    """Tests for credential retrieval from Keychain."""

    @patch("freshrss.main.run_security")
    def test_finds_account_in_stderr(self, mock_run_security: MagicMock) -> None:
        """Should find account metadata when emitted on stderr."""
        mock_run_security.return_value = CompletedProcess([], 0, "mysecretpassword", "")
        mock_run_security.side_effect = [
            CompletedProcess([], 0, "mysecretpassword", ""),
            CompletedProcess(
                [],
                0,
                "",
                'keychain: "/Users/test/Keychains/login.keychain-db"'
                '\n"acct"<blob>="testuser"\n',
            ),
        ]

        result = get_credentials()
        self.assertEqual(result, ("testuser", "mysecretpassword"))

    @patch("freshrss.main.run_security")
    def test_finds_account_in_stdio(self, mock_run_security: MagicMock) -> None:
        """Should find account metadata when emitted on stdout."""
        mock_run_security.side_effect = [
            CompletedProcess([], 0, "mysecretpassword", ""),
            CompletedProcess(
                [],
                0,
                'keychain: "/Users/test/Keychains/login.keychain-db"'
                '\n"acct"<blob>="testuser"\n',
                "",
            ),
        ]

        result = get_credentials()
        self.assertEqual(result, ("testuser", "mysecretpassword"))

    @patch("freshrss.main.run_security")
    def test_finds_account_across_streams(self, mock_run_security: MagicMock) -> None:
        """Should find account metadata when split across stdout and stderr."""
        mock_run_security.side_effect = [
            CompletedProcess([], 0, "mysecretpassword", ""),
            CompletedProcess(
                [],
                0,
                'keychain: "/Users/test/Library/Keychains/login.keychain-db"\n"',
                'acct"<blob>="testuser"\n',
            ),
        ]

        result = get_credentials()
        self.assertEqual(result, ("testuser", "mysecretpassword"))

    @patch("freshrss.main.run_security")
    def test_returns_none_on_password_lookup_fail(
        self, mock_run_security: MagicMock
    ) -> None:
        """Should return None when password lookup fails."""
        mock_run_security.return_value = CompletedProcess(
            [], 1, "", "error: no credentials found"
        )

        result = get_credentials()
        self.assertIsNone(result)

    @patch("freshrss.main.run_security")
    def test_returns_none_on_missing_account_metadata(
        self, mock_run_security: MagicMock
    ) -> None:
        """Should return None when account metadata is not found in output."""
        mock_run_security.side_effect = [
            CompletedProcess([], 0, "mysecretpassword", ""),
            CompletedProcess([], 0, "some output", "no account info"),
        ]

        result = get_credentials()
        self.assertIsNone(result)


class TestListItems(unittest.TestCase):
    """Tests for list_items API helper."""

    @patch("freshrss.main.api_request")
    def test_unread_uses_xt_parameter(self, mock_api: MagicMock) -> None:
        """Unread items should use xt= to exclude read state."""
        mock_api.return_value = json.dumps({"items": []})

        list_items("http://localhost", "token", unread_only=True, limit=10)

        # Check api_request was called with xt parameter
        call_args = mock_api.call_args
        params = call_args[0][3]  # params is 4th positional arg
        self.assertEqual(params["xt"], "user/-/state/com.google/read")
        self.assertNotIn("it", params)

    @patch("freshrss.main.api_request")
    def test_read_uses_it_parameter(self, mock_api: MagicMock) -> None:
        """Read items should use it= parameter with reading-list stream."""
        mock_api.return_value = json.dumps({"items": []})

        list_items(
            "http://localhost",
            "token",
            unread_only=False,
            limit=10,
            stream="reading-list",
            include_tag="user/-/state/com.google/read",
        )

        # Check api_request was called with it parameter
        call_args = mock_api.call_args
        params = call_args[0][3]  # params is 4th positional arg
        self.assertEqual(params["it"], "user/-/state/com.google/read")
        self.assertNotIn("xt", params)

    @patch("freshrss.main.api_request")
    def test_default_stream_is_reading_list(self, mock_api: MagicMock) -> None:
        """Default stream should be reading-list."""
        mock_api.return_value = json.dumps({"items": []})

        list_items("http://localhost", "token", limit=10)

        # Check the path uses reading-list
        call_args = mock_api.call_args
        path = call_args[0][1]  # path is 2nd positional arg
        self.assertIn("reading-list", path)


class TestCmdRead(unittest.TestCase):
    """Tests for cmd_read command."""

    @patch("freshrss.main.list_items")
    @patch("freshrss.main.get_auth_token")
    @patch("freshrss.main.get_credentials")
    def test_uses_reading_list_with_it_param(
        self,
        mock_creds: MagicMock,
        mock_auth: MagicMock,
        mock_list: MagicMock,
    ) -> None:
        """cmd_read should use reading-list stream with it= parameter."""
        mock_creds.return_value = ("user", "pass")
        mock_auth.return_value = "token"
        mock_list.return_value = []

        args = argparse.Namespace(
            base_url="http://localhost:9999",
            limit=10,
            raw=False,
        )
        cmd_read(args)

        # Verify list_items was called with correct parameters
        mock_list.assert_called_once()
        call_kwargs = mock_list.call_args[1]
        self.assertEqual(call_kwargs["stream"], "reading-list")
        self.assertEqual(call_kwargs["include_tag"], "user/-/state/com.google/read")
        self.assertFalse(call_kwargs["unread_only"])

    @patch("freshrss.main.list_items")
    @patch("freshrss.main.get_auth_token")
    @patch("freshrss.main.get_credentials")
    def test_no_credentials_error(
        self,
        mock_creds: MagicMock,
        mock_auth: MagicMock,
        mock_list: MagicMock,
    ) -> None:
        """Should error when no credentials found."""
        mock_creds.return_value = None

        args = argparse.Namespace(
            base_url="http://localhost:9999",
            limit=10,
            raw=False,
        )
        result = cmd_read(args)

        self.assertEqual(result, 1)
        mock_list.assert_not_called()

    @patch("freshrss.main.list_items")
    @patch("freshrss.main.get_auth_token")
    @patch("freshrss.main.get_credentials")
    def test_auth_failure_error(
        self,
        mock_creds: MagicMock,
        mock_auth: MagicMock,
        mock_list: MagicMock,
    ) -> None:
        """Should error when authentication fails."""
        mock_creds.return_value = ("user", "pass")
        mock_auth.return_value = None

        args = argparse.Namespace(
            base_url="http://localhost:9999",
            limit=10,
            raw=False,
        )
        result = cmd_read(args)

        self.assertEqual(result, 1)
        mock_list.assert_not_called()


if __name__ == "__main__":
    unittest.main()


class TestCmdUnread(unittest.TestCase):
    """Tests for cmd_unread command."""

    @patch("freshrss.main.list_items")
    @patch("freshrss.main.get_auth_token")
    @patch("freshrss.main.get_credentials")
    def test_no_credentials_error(
        self,
        mock_creds: MagicMock,
        mock_auth: MagicMock,
        mock_list: MagicMock,
    ) -> None:
        """Should error when no credentials found."""
        mock_creds.return_value = None

        args = argparse.Namespace(
            base_url="http://localhost:9999",
            limit=20,
            digest=False,
            raw=False,
            force=False,
        )
        result = cmd_unread(args)

        self.assertEqual(result, 1)
        mock_list.assert_not_called()

    @patch("freshrss.main.list_items")
    @patch("freshrss.main.get_auth_token")
    @patch("freshrss.main.get_credentials")
    def test_auth_failure_error(
        self,
        mock_creds: MagicMock,
        mock_auth: MagicMock,
        mock_list: MagicMock,
    ) -> None:
        """Should error when authentication fails."""
        mock_creds.return_value = ("user", "pass")
        mock_auth.return_value = None

        args = argparse.Namespace(
            base_url="http://localhost:9999",
            limit=20,
            digest=False,
            raw=False,
            force=False,
        )
        result = cmd_unread(args)

        self.assertEqual(result, 1)
        mock_list.assert_not_called()

    @patch("freshrss.main.load_interests")
    @patch("freshrss.main.group_items_for_digest")
    @patch("freshrss.main.list_items")
    @patch("freshrss.main.get_auth_token")
    @patch("freshrss.main.get_credentials")
    def test_digest_output_does_not_claim_total_count(
        self,
        mock_creds: MagicMock,
        mock_auth: MagicMock,
        mock_list: MagicMock,
        mock_group: MagicMock,
        mock_load_interests: MagicMock,
    ) -> None:
        """Digest output should say 'fetched' not imply limit is total unread count."""
        import io
        from contextlib import redirect_stdout

        mock_creds.return_value = ("user", "pass")
        mock_auth.return_value = "token"
        mock_list.return_value = [
            {"id": "item:1", "title": "Test", "content": "Test content"}
        ]
        mock_group.return_value = {
            "General": {
                "items": [
                    {
                        "id": "item:1",
                        "title": "Test",
                        "content_snippet": "Test",
                        "link": "",
                        "source": "Test Feed",
                        "interest": False,
                    }
                ],
                "interest": False,
                "topic": "General",
                "sources": ["Test Feed"],
            }
        }
        mock_load_interests.return_value = []

        args = argparse.Namespace(
            base_url="http://localhost:9999",
            limit=50,
            digest=True,
            raw=False,
            force=False,
        )

        f = io.StringIO()
        with redirect_stdout(f):
            result = cmd_unread(args)

        self.assertEqual(result, 0)
        output = f.getvalue()

        # Verify output says "fetched" not "50 unread items"
        self.assertIn("fetched", output)
        # Should NOT say "50 unread items" as if that's the total
        self.assertNotIn("50 unread items", output)

    @patch("freshrss.main.load_interests")
    @patch("freshrss.main.group_items_for_digest")
    @patch("freshrss.main.list_items")
    @patch("freshrss.main.get_auth_token")
    @patch("freshrss.main.get_credentials")
    def test_digest_shows_highlights_section(
        self,
        mock_creds: MagicMock,
        mock_auth: MagicMock,
        mock_list: MagicMock,
        mock_group: MagicMock,
        mock_load_interests: MagicMock,
    ) -> None:
        """Digest output should include curated highlights section."""
        import io
        from contextlib import redirect_stdout

        mock_creds.return_value = ("user", "pass")
        mock_auth.return_value = "token"
        mock_list.return_value = [
            {"id": "item:1", "title": "Test 1", "content": "Content 1"},
            {"id": "item:2", "title": "Test 2", "content": "Content 2"},
        ]
        mock_group.return_value = {
            "Programming": {
                "items": [
                    {
                        "id": "item:1",
                        "title": "Test 1",
                        "content_snippet": "Content 1",
                        "link": "",
                        "source": "DevFeed",
                        "interest": True,
                    },
                    {
                        "id": "item:2",
                        "title": "Test 2",
                        "content_snippet": "Content 2",
                        "link": "",
                        "source": "DevFeed",
                        "interest": True,
                    },
                ],
                "interest": True,
                "topic": "Programming",
                "sources": ["DevFeed"],
            }
        }
        mock_load_interests.return_value = []

        args = argparse.Namespace(
            base_url="http://localhost:9999",
            limit=50,
            digest=True,
            raw=False,
            force=False,
        )

        f = io.StringIO()
        with redirect_stdout(f):
            result = cmd_unread(args)

        self.assertEqual(result, 0)
        output = f.getvalue()

        # Verify highlights section is present
        self.assertIn("Highlights", output)
        # Verify items are shown with IDs for follow-up
        self.assertIn("item:1", output)

    @patch("freshrss.main.load_interests")
    @patch("freshrss.main.group_items_for_digest")
    @patch("freshrss.main.list_items")
    @patch("freshrss.main.get_auth_token")
    @patch("freshrss.main.get_credentials")
    def test_digest_shows_sample_note_when_limit_reached(
        self,
        mock_creds: MagicMock,
        mock_auth: MagicMock,
        mock_list: MagicMock,
        mock_group: MagicMock,
        mock_load_interests: MagicMock,
    ) -> None:
        """Digest should note when sample limit was reached."""
        import io
        from contextlib import redirect_stdout

        mock_creds.return_value = ("user", "pass")
        mock_auth.return_value = "token"
        # Return exactly `limit` items to trigger the sample note
        mock_list.return_value = [
            {"id": f"item:{i}", "title": f"Test {i}", "content": f"Content {i}"}
            for i in range(50)
        ]
        mock_group.return_value = {
            "General": {
                "items": [
                    {
                        "id": f"item:{i}",
                        "title": f"Test {i}",
                        "content_snippet": f"Content {i}",
                        "link": "",
                        "source": "Test Feed",
                        "interest": False,
                    }
                    for i in range(50)
                ],
                "interest": False,
                "topic": "General",
                "sources": ["Test Feed"],
            }
        }
        mock_load_interests.return_value = []

        args = argparse.Namespace(
            base_url="http://localhost:9999",
            limit=50,
            digest=True,
            raw=False,
            force=False,
        )

        f = io.StringIO()
        with redirect_stdout(f):
            result = cmd_unread(args)

        self.assertEqual(result, 0)
        output = f.getvalue()

        # Verify sample note is shown
        self.assertIn("more may be available", output.lower())

    @patch("freshrss.main.load_interests")
    @patch("freshrss.main.group_items_for_digest")
    @patch("freshrss.main.list_items")
    @patch("freshrss.main.get_auth_token")
    @patch("freshrss.main.get_credentials")
    def test_digest_non_interest_items_no_star(
        self,
        mock_creds: MagicMock,
        mock_auth: MagicMock,
        mock_list: MagicMock,
        mock_group: MagicMock,
        mock_load_interests: MagicMock,
    ) -> None:
        """Non-interest items in interest-matched group should not show with star."""
        import io
        from contextlib import redirect_stdout

        mock_creds.return_value = ("user", "pass")
        mock_auth.return_value = "token"
        mock_list.return_value = [
            {"id": "item:1", "title": "Interest match", "content": "Matches keyword"},
            {"id": "item:2", "title": "No match", "content": "Generic content"},
        ]
        # Group has interest=True (at least one match), but items have per-item flags
        mock_group.return_value = {
            "Programming": {
                "items": [
                    {
                        "id": "item:1",
                        "title": "Interest match",
                        "content_snippet": "Matches keyword",
                        "link": "",
                        "source": "DevFeed",
                        "interest": True,  # This item matched
                    },
                    {
                        "id": "item:2",
                        "title": "No match",
                        "content_snippet": "Generic content",
                        "link": "",
                        "source": "DevFeed",
                        "interest": False,  # This item did not match
                    },
                ],
                "interest": True,  # Group has at least one match
                "topic": "Programming",
                "sources": ["DevFeed"],
            }
        }
        mock_load_interests.return_value = []

        args = argparse.Namespace(
            base_url="http://localhost:9999",
            limit=50,
            digest=True,
            raw=False,
            force=False,
        )

        f = io.StringIO()
        with redirect_stdout(f):
            result = cmd_unread(args)

        self.assertEqual(result, 0)
        output = f.getvalue()

        # Interest-matched item should have star
        self.assertIn("★ Interest match", output)
        # Non-interest item should NOT have star (should use ○ or no icon in highlights)
        # The highlights section uses ★ for interest, ○ for non-interest
        lines = output.split("\n")
        for line in lines:
            if "No match" in line and "★" in line:
                self.fail("Non-interest item 'No match' should not have star icon")


class TestHighlightSelection(unittest.TestCase):
    """Tests for highlight selection logic - fixes capping per group."""

    @patch("freshrss.main.load_interests")
    @patch("freshrss.main.group_items_for_digest")
    @patch("freshrss.main.list_items")
    @patch("freshrss.main.get_auth_token")
    @patch("freshrss.main.get_credentials")
    def test_single_topic_many_items_yields_multiple_highlights(
        self,
        mock_creds: MagicMock,
        mock_auth: MagicMock,
        mock_list: MagicMock,
        mock_group: MagicMock,
        mock_load_interests: MagicMock,
    ) -> None:
        """Single topic with many items yields multiple highlights."""
        import io
        from contextlib import redirect_stdout

        mock_creds.return_value = ("user", "pass")
        mock_auth.return_value = "token"
        # 50 items in a single topic
        mock_list.return_value = [
            {"id": f"item:{i}", "title": f"Item {i}", "content": f"Content {i}"}
            for i in range(50)
        ]
        mock_group.return_value = {
            "AI & Machine Learning": {
                "items": [
                    {
                        "id": f"item:{i}",
                        "title": f"Item {i}",
                        "content_snippet": f"Content {i}",
                        "link": "",
                        "source": "Tech Feed",
                        "interest": True,  # Per-item interest flag
                    }
                    for i in range(50)
                ],
                "interest": True,
                "topic": "AI & Machine Learning",
                "sources": ["Tech Feed"],
            }
        }
        mock_load_interests.return_value = []

        args = argparse.Namespace(
            base_url="http://localhost:9999",
            limit=50,
            digest=True,
            raw=False,
            force=False,
        )

        f = io.StringIO()
        with redirect_stdout(f):
            result = cmd_unread(args)

        self.assertEqual(result, 0)
        output = f.getvalue()

        # Should have 8 highlights (the max) from the single topic
        # Count ★ symbols in the Highlights section only (before Topics section)
        highlights_section = output.split("Topics:")[0]
        highlight_count = highlights_section.count("★")
        self.assertEqual(
            highlight_count,
            8,
            "Should select 8 highlights from single topic with 50 items",
        )
        # Verify first few items are shown
        self.assertIn("item:0", output)
        self.assertIn("item:7", output)

    @patch("freshrss.main.load_interests")
    @patch("freshrss.main.group_items_for_digest")
    @patch("freshrss.main.list_items")
    @patch("freshrss.main.get_auth_token")
    @patch("freshrss.main.get_credentials")
    def test_few_items_shows_all_as_highlights(
        self,
        mock_creds: MagicMock,
        mock_auth: MagicMock,
        mock_list: MagicMock,
        mock_group: MagicMock,
        mock_load_interests: MagicMock,
    ) -> None:
        """When fewer than 5 items total, all should be shown as highlights."""
        import io
        from contextlib import redirect_stdout

        mock_creds.return_value = ("user", "pass")
        mock_auth.return_value = "token"
        mock_list.return_value = [
            {"id": f"item:{i}", "title": f"Item {i}", "content": f"Content {i}"}
            for i in range(3)
        ]
        mock_group.return_value = {
            "General": {
                "items": [
                    {
                        "id": f"item:{i}",
                        "title": f"Item {i}",
                        "content_snippet": f"Content {i}",
                        "link": "",
                        "source": "Feed",
                        "interest": False,
                    }
                    for i in range(3)
                ],
                "interest": False,
                "topic": "General",
                "sources": ["Feed"],
            }
        }
        mock_load_interests.return_value = []

        args = argparse.Namespace(
            base_url="http://localhost:9999",
            limit=50,
            digest=True,
            raw=False,
            force=False,
        )

        f = io.StringIO()
        with redirect_stdout(f):
            result = cmd_unread(args)

        self.assertEqual(result, 0)
        output = f.getvalue()

        # All 3 items should be shown as highlights
        # Count icons in Highlights section only (before Topics section)
        highlights_section = output.split("Topics:")[0]
        highlight_count = highlights_section.count("★") + highlights_section.count("○")
        self.assertEqual(
            highlight_count, 3, "Should show all 3 items when fewer than 5 total"
        )


class TestInterestTopicCollision(unittest.TestCase):
    """Tests for interest/topic name collision handling."""

    def test_interest_match_preserved_when_topic_same_name(self) -> None:
        """Interest matches should not be hidden when derived topic has same name."""
        # Use "General" as the keyword since _derive_topic returns "General" for
        # non-matching content, creating a potential collision scenario.
        items = [
            # First item: no interest match, derives to "General"
            {
                "id": "1",
                "title": "Random News Update",
                "content": "Generic content with no specific topic",
                "origin": {"title": "News Feed"},
                "crawlTimeMsec": 1000,
            },
            # Second item: interest match for "General" (same name as derived topic)
            {
                "id": "2",
                "title": "Breaking News",
                "content": "Important update",
                "origin": {"title": "News Wire"},
                "crawlTimeMsec": 2000,
            },
        ]
        groups: list[InterestGroup] = [
            {"name": "General", "keywords": ["important", "breaking"]}
        ]

        grouped = group_items_for_digest(items, groups)

        # Group should exist
        self.assertIn("General", grouped)
        # Group's interest flag should be True because item 2 is an interest match
        # (even though item 1 created the group first without interest match)
        self.assertTrue(
            grouped["General"]["interest"],
            "Group interest flag should be True when any item is interest match",
        )
        # Both items should be in the group
        self.assertEqual(len(grouped["General"]["items"]), 2)

    def test_non_interest_items_do_not_inherit_star(self) -> None:
        """Non-interest items do not inherit interest star."""
        items = [
            # Interest match item
            {
                "id": "1",
                "title": "Python framework update",
                "content": "New features for the popular framework",
                "origin": {"title": "Python Weekly"},
                "crawlTimeMsec": 1000,
            },
            # Non-interest item that happens to derive to "Programming" topic
            {
                "id": "2",
                "title": "Code review tips",
                "content": "Best practices for reviewing code",
                "origin": {"title": "Dev Blog"},
                "crawlTimeMsec": 2000,
            },
        ]
        groups: list[InterestGroup] = [
            {"name": "Programming", "keywords": ["framework"]}
        ]

        grouped = group_items_for_digest(items, groups)

        # Both items should be in "Programming" group
        self.assertIn("Programming", grouped)
        self.assertEqual(len(grouped["Programming"]["items"]), 2)
        # Group should have interest=True because at least one item matched
        self.assertTrue(grouped["Programming"]["interest"])
        # Per-item interest flags: first item matched, second did not
        self.assertTrue(
            grouped["Programming"]["items"][0]["interest"],
            "Interest-matched item should have interest=True",
        )
        self.assertFalse(
            grouped["Programming"]["items"][1]["interest"],
            "Non-interest item should not inherit interest=True from group",
        )

    def test_interest_flag_computed_correctly_across_orderings(self) -> None:
        """Interest flag should be True regardless of item processing order."""
        interest_item = {
            "id": "interest",
            "title": "Interest Match",
            "content": "Matches keyword",
            "origin": {"title": "Feed A"},
            "crawlTimeMsec": 1000,
        }
        non_interest_item = {
            "id": "other",
            "title": "Other Topic",
            "content": "No match here",
            "origin": {"title": "Feed B"},
            "crawlTimeMsec": 2000,
        }

        groups: list[InterestGroup] = [{"name": "General", "keywords": ["match"]}]

        # Order 1: non-interest first
        grouped1 = group_items_for_digest([non_interest_item, interest_item], groups)
        self.assertTrue(grouped1["General"]["interest"])

        # Order 2: interest first
        grouped2 = group_items_for_digest([interest_item, non_interest_item], groups)
        self.assertTrue(grouped2["General"]["interest"])
