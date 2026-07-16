"""FreshRSS CLI - interact with local FreshRSS instance via Google Reader API."""

from __future__ import annotations

import argparse
import getpass
import json
import re
import subprocess
import sys
import urllib.error
import urllib.request
from html import unescape
from pathlib import Path
from typing import TypedDict
from urllib.parse import quote_plus

KEYCHAIN_SERVICE = "freshrss-cli"
INTERESTS_FILE = Path.home() / ".config" / "freshrss-cli" / "interests.json"
DEFAULT_BASE_URL = "http://localhost:9999"
API_PATH = "/api/greader.php"
USER_AGENT = "freshrss-cli/1.0"


class InterestGroup(TypedDict):
    """Group type for interests."""

    name: str
    keywords: list[str]


def strip_html(text: str) -> str:
    """Remove HTML tags from text, decode entities, collapse whitespace."""
    text = re.sub(r"<[^>]+>", " ", text)
    text = unescape(text)
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def extract_content(raw: str | dict | None) -> str:
    """Extract text content from FreshRSS item fields.

    FreshRSS returns text fields in different formats:
    - Stream items: content is a dict with 'content' key (e.g. summary.content)
    - Item contents endpoint: content.content or just content string

    Args:
        raw: Raw content field which may be str, dict, or None.

    Returns:
        Extracted text content, or empty string if not found.
    """
    if raw is None:
        return ""
    if isinstance(raw, str):
        return raw
    if isinstance(raw, dict):
        # Prefer 'content' key first (covers both content.content and summary.content)
        content = raw.get("content", "")
        if isinstance(content, str):
            return content
    return ""


def run_security(
    args: list[str], input_data: str | None = None
) -> subprocess.CompletedProcess:
    """Run /usr/bin/security with optional stdin input."""
    return subprocess.run(
        ["/usr/bin/security"] + args,
        input=input_data.encode() if input_data else None,
        capture_output=True,
        text=True,
    )


def store_credentials(username: str, password: str) -> bool:
    """Store credentials in macOS Keychain. Returns True on success.

    Uses -U flag to update existing credentials without delete-first,
    preventing credential loss on failure.
    """
    add_result = run_security(
        [
            "add-generic-password",
            "-U",  # Update if exists, add if not (avoids delete-first loss)
            "-s",
            KEYCHAIN_SERVICE,
            "-a",
            username,
            "-w",
            password,
        ]
    )
    return add_result.returncode == 0


def get_credentials() -> tuple[str, str] | None:
    """Retrieve credentials from macOS Keychain.

    Returns (username, password) or None.
    """
    result = run_security(["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"])
    if result.returncode != 0:
        return None
    password = result.stdout.strip()
    result2 = run_security(["find-generic-password", "-s", KEYCHAIN_SERVICE, "-g"])
    # Combine stdout and stderr - account metadata may appear on either stream
    combined_output = result2.stdout + result2.stderr
    match = re.search(r'"acct"<blob>="([^"]+)"', combined_output)
    if not match:
        return None
    username = match.group(1)
    return (username, password)


def get_auth_token(base_url: str, username: str, password: str) -> str | None:
    """Get auth token from FreshRSS via POST form data.

    Uses Google Reader ClientLogin API with form-encoded POST body.
    Returns token or None on failure.
    """
    url = f"{base_url}{API_PATH}/accounts/ClientLogin"
    # POST form data - avoid sending password in URL query
    post_data = (
        f"Email={quote_plus(username)}&Passwd={quote_plus(password)}&service=reader"
    ).encode()

    req = urllib.request.Request(
        url,
        data=post_data,
        headers={
            "User-Agent": USER_AGENT,
            "Content-Type": "application/x-www-form-urlencoded",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            body = resp.read().decode()
            for line in body.splitlines():
                if line.startswith("Auth="):
                    return line[5:]
    except urllib.error.URLError:
        return None
    return None


def get_token(base_url: str, auth_token: str) -> str | None:
    """Get edit token from FreshRSS for state-changing operations.

    Returns token or None on failure.
    """
    url = f"{base_url}{API_PATH}/reader/api/0/token"
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Authorization": f"GoogleLogin auth={auth_token}",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.read().decode().strip()
    except urllib.error.URLError:
        return None


def api_request(
    base_url: str,
    path: str,
    auth_token: str,
    params: dict[str, str] | None = None,
    method: str = "GET",
    data: bytes | None = None,
) -> str | None:
    """Make authenticated API request. Returns response body or None on failure."""
    url = f"{base_url}{path}"
    if params and method == "GET":
        query = "&".join(f"{k}={quote_plus(v)}" for k, v in params.items())
        url = f"{url}?{query}"

    headers = {
        "User-Agent": USER_AGENT,
        "Authorization": f"GoogleLogin auth={auth_token}",
    }

    if method == "POST" and data:
        headers["Content-Type"] = "application/x-www-form-urlencoded"

    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.read().decode()
    except urllib.error.HTTPError as e:
        print(f"API error: {e.code} {e.reason}", file=sys.stderr)
        return None
    except urllib.error.URLError as e:
        print(f"Connection error: {e.reason}", file=sys.stderr)
        return None
    return None


def check_freshrss_reachable(base_url: str) -> tuple[bool, str]:
    """Check if FreshRSS is reachable. Returns (reachable, message)."""
    url = f"{base_url}{API_PATH}"
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=5):
            return (True, "FreshRSS is reachable")
    except urllib.error.URLError as e:
        reason = str(e.reason)
        if "Connection refused" in reason:
            return (
                False,
                "FreshRSS not running on port 9999. Start with: "
                "docker run -d -p 9999:80 --name freshrss freshrss/freshrss",
            )
        if "No route" in reason or "Network" in reason:
            return (False, "Network unreachable. Check Docker daemon is running.")
        return (False, f"Connection failed: {reason}")
    return (False, "Unknown error")


def list_streams(base_url: str, auth_token: str) -> list[dict] | None:
    """List all subscription streams. Returns list of stream dicts or None."""
    # Add output=json for proper JSON response
    body = api_request(
        base_url,
        f"{API_PATH}/reader/api/0/subscription/list",
        auth_token,
        {"output": "json"},
    )
    if not body:
        return None
    try:
        data = json.loads(body)
        return data.get("subscriptions", [])
    except json.JSONDecodeError:
        return None


def list_items(
    base_url: str,
    auth_token: str,
    unread_only: bool = False,
    limit: int | None = 20,
    stream: str = "reading-list",
    include_tag: str | None = None,
) -> list[dict] | None:
    """List items from a stream. Returns list of item dicts or None.

    Uses Google Reader-compatible /stream/contents/ endpoint.
    For unread items: xt= excludes read state.
    For read items: use reading-list stream with include_tag for read state.

    Pagination: when limit=None, fetches all matching items using continuation
    token (c parameter). Uses conservative page size to avoid large responses.
    Stops if continuation token repeats or item count stops changing.

    Args:
        base_url: FreshRSS base URL.
        auth_token: Authentication token.
        unread_only: Whether to filter for unread items only.
        limit: Max items to fetch per page, or None for all items.
        stream: Stream name (default: "reading-list").
        include_tag: Include items with this tag (e.g. "user/-/state/com.google/read").

    Returns:
        List of item dicts or None on failure.
    """
    all_items: list[dict] = []
    page_size = 100  # Conservative page size
    prev_count = -1  # Track to detect infinite loops
    continuation: str | None = None
    max_pages = 50  # Safety limit
    page = 0

    while True:
        # Build params for this page
        current_limit = limit if limit is not None else page_size
        params: dict[str, str] = {
            "n": str(current_limit),
            "output": "json",
        }
        if unread_only:
            params["xt"] = "user/-/state/com.google/read"
        if include_tag:
            params["it"] = include_tag
        if continuation:
            params["c"] = continuation

        body = api_request(
            base_url,
            f"{API_PATH}/reader/api/0/stream/contents/{stream}",
            auth_token,
            params,
        )
        if not body:
            return None if page == 0 else all_items

        try:
            data = json.loads(body)
            items = data.get("items", [])
            all_items.extend(items)

            # Check if we should stop
            # 1. If limit was explicit and we've reached it
            if limit is not None and len(all_items) >= limit:
                return all_items[:limit]

            # 2. Check for continuation token
            continuation = data.get("continuation")
            if not continuation:
                return all_items

            # 3. Safety: avoid infinite loops if continuation repeats or count stalls
            if continuation == params.get("c") or len(items) == 0:
                return all_items
            if len(all_items) == prev_count:
                return all_items
            prev_count = len(all_items)

            # 4. Safety: max pages limit
            page += 1
            if page >= max_pages:
                return all_items

        except json.JSONDecodeError:
            return None if page == 0 else all_items


def get_item_contents(
    base_url: str, auth_token: str, item_ids: list[str]
) -> list[dict] | None:
    """Fetch full contents for multiple items by ID.

    Uses /stream/items/contents endpoint with POSTed item IDs.
    Returns list of item dicts or None on failure.
    """
    if not item_ids:
        return []

    # POST item IDs as form data
    data_parts = [f"i={quote_plus(item_id)}" for item_id in item_ids]
    post_data = "&".join(data_parts).encode()

    body = api_request(
        base_url,
        f"{API_PATH}/reader/api/0/stream/items/contents",
        auth_token,
        method="POST",
        data=post_data,
    )
    if not body:
        return None

    try:
        data = json.loads(body)
        return data.get("items", [])
    except json.JSONDecodeError:
        return None


def mark_as_read(
    base_url: str, auth_token: str, edit_token: str, item_ids: list[str]
) -> bool:
    """Mark items as read. Returns True on success.

    Requires edit token (T parameter) for state-changing operations.
    """
    data_parts = []
    for item_id in item_ids:
        data_parts.append(f"i={quote_plus(item_id)}")
    # Include T (edit token) and add read state
    data_parts.append(f"T={quote_plus(edit_token)}")
    data_parts.append("a=user/-/state/com.google/read")
    data = "&".join(data_parts).encode()

    result = api_request(
        base_url,
        f"{API_PATH}/reader/api/0/edit-tag",
        auth_token,
        method="POST",
        data=data,
    )
    return result is not None


class GroupData(TypedDict):
    """Data for grouped digest output."""

    items: list[dict]
    interest: bool
    topic: str
    sources: list[str]


def load_interests() -> list[InterestGroup]:
    """Load interests from config file. Returns list of groups."""
    if not INTERESTS_FILE.exists():
        return []
    try:
        with INTERESTS_FILE.open() as f:
            data = json.load(f)
            return data.get("groups", [])
    except (json.JSONDecodeError, OSError):
        return []


def save_interests(groups: list[InterestGroup]) -> bool:
    """Save interests to config file. Returns True on success."""
    try:
        INTERESTS_FILE.parent.mkdir(parents=True, exist_ok=True)
        with INTERESTS_FILE.open("w") as f:
            json.dump({"groups": groups}, f, indent=2)
        return True
    except OSError:
        return False


def _derive_topic(title: str, content: str) -> str:
    """Derive a specific topic label from title and content using heuristics.

    Uses keyword matching to produce granular, story-level clusters rather than
    broad categories. Prioritises specific AI/tech sub-topics, then falls back
    to more general (but still specific) labels. Avoids overly broad labels like
    'Technology', 'Business', 'Programming', 'AI & Machine Learning', or 'General'.

    Args:
        title: Article title.
        content: Article content snippet.

    Returns:
        Specific topic label string for grouping, or 'Other updates' as fallback.
    """
    text = f"{title} {content}".lower()

    # AI/ML sub-topics (most specific first)
    ai_specific: dict[str, list[str]] = {
        "AI agents": [
            "agent",
            "autonomous",
            "code agent",
            "coding agent",
            "agentic",
        ],
        "AI regulation/policy": [
            "regulation",
            "policy",
            "governance",
            "ai act",
            "eu ai",
            "compliance",
            "policing",
            "safety guidelines",
        ],
        "Grok/xAI": [
            "grok",
            "x.ai",
            "xai",
            "musk ai",
        ],
        "model releases": [
            "model release",
            "new model",
            "model launch",
            "launched",
            "unveiled",
            "announced",
        ],
        "compute markets": [
            "compute",
            "cloud compute",
            "gpu cluster",
            "compute cost",
            "training cost",
        ],
        "AI hardware": [
            "nvidia",
            "amd chip",
            "intel chip",
            "tpu",
            "tensor chip",
            "inference chip",
            "ai accelerator",
        ],
        "LLM training": [
            "training",
            "pretraining",
            "fine-tuning",
            "rlhf",
            "alignment",
        ],
        "machine learning": [
            "machine learning",
            "ml model",
            "neural network",
            "deep learning",
            "transformer",
        ],
        "AI research": [
            "ai research",
            "ai breakthrough",
            "llm research",
        ],
    }

    for topic, keywords in ai_specific.items():
        for kw in keywords:
            if kw in text:
                return topic

    # Business/startup (before dev tools to avoid "api" in "capital" etc.)
    business_topics: dict[str, list[str]] = {
        "funding/VC": [
            "funding",
            "venture capital",
            "series a",
            "series b",
            "series c",
            "investor",
            "valuation",
            "seed round",
        ],
        "acquisitions": [
            "acquisition",
            "acquired",
            "merger",
            "bought",
            "purchase",
        ],
        "layoffs": [
            "layoff",
            "layoffs",
            "cut",
            "job cut",
            "workforce reduction",
        ],
        "earnings": [
            "earnings",
            "revenue",
            "quarterly",
            "profit",
            "loss",
        ],
    }

    for topic, keywords in business_topics.items():
        for kw in keywords:
            if kw in text:
                return topic

    # Programming/dev tools sub-topics
    dev_specific: dict[str, list[str]] = {
        "code tooling": [
            "lint",
            "linter",
            "ruff",
            "eslint",
            "formatter",
            "static analysis",
            "type checker",
            "mypy",
        ],
        "testing tools": [
            "pytest",
            "unit test",
            "integration test",
            "test framework",
            "test runner",
        ],
        "python": [
            "python",
            "pypi",
            "pip",
            "cpython",
        ],
        "javascript/typescript": [
            "javascript",
            "typescript",
            "node.js",
            "nodejs",
            "npm",
            "bun",
            "deno",
        ],
        "web frameworks": [
            "fastapi",
            "django",
            "flask",
            "react",
            "vue",
            "svelte",
            "next.js",
            "nuxt",
        ],
        "developer tools": [
            "vs code",
            "visual studio code",
            "cursor",
            "zed",
            "neovim",
            "ide",
            "editor",
        ],
        "api development": [
            "api endpoint",
            "rest api",
            "graphql",
            "http endpoint",
        ],
    }

    for topic, keywords in dev_specific.items():
        for kw in keywords:
            if kw in text:
                return topic

    # Security/privacy
    security_topics: dict[str, list[str]] = {
        "security vulnerabilities": [
            "vulnerability",
            "cve",
            "exploit",
            "zero-day",
            "patch",
            "security update",
        ],
        "data breaches": [
            "breach",
            "data leak",
            "leaked",
            "hacked",
            "compromised",
        ],
        "privacy": [
            "privacy",
            "encryption",
            "signal",
            "tor",
            "vpn",
            "surveillance",
        ],
    }

    for topic, keywords in security_topics.items():
        for kw in keywords:
            if kw in text:
                return topic

    # Science/health
    science_topics: dict[str, list[str]] = {
        "scientific research": [
            "research",
            "study",
            "paper",
            "journal",
            "peer-reviewed",
        ],
        "health/medical": [
            "health",
            "medical",
            "medicine",
            "clinical",
            "fda",
            "trial",
        ],
    }

    for topic, keywords in science_topics.items():
        for kw in keywords:
            if kw in text:
                return topic

    # Climate/environment
    if any(
        kw in text
        for kw in [
            "climate",
            "carbon",
            "emission",
            "renewable",
            "sustainability",
            "environment",
        ]
    ):
        return "climate/environment"

    # General tech (fallback for anything tech-related but not matched above)
    if any(
        kw in text
        for kw in [
            "tech",
            "software",
            "hardware",
            "device",
            "digital",
            "app",
            "startup",
            "company",
        ]
    ):
        return "tech updates"

    # Ultimate fallback
    return "Other updates"


def group_items_for_digest(
    items: list[dict], groups: list[InterestGroup]
) -> dict[str, GroupData]:
    """Group items by topic/interest for digest view.

    Primary grouping is by configured interests first, then by derived topic
    for non-interest items. Feed/source is stored as metadata, not used for
    grouping. This allows agents to regroup/summarise without relying on
    feed names.

    Args:
        items: List of FreshRSS item dicts.
        groups: List of configured interest groups.

    Returns:
        Dict mapping topic/interest name to grouped data with items,
        interest flag, topic label, and list of source feeds.
    """
    grouped: dict[str, GroupData] = {}
    for item in items:
        # FreshRSS returns crawlTimeMsec as a string, safely cast to int
        crawl_time_raw = item.get("crawlTimeMsec", 0)
        try:
            crawl_time_msec = int(crawl_time_raw) if crawl_time_raw else 0
        except (ValueError, TypeError):
            crawl_time_msec = 0
        date_key = str(crawl_time_msec // 86400000)
        feed_title = item.get("origin", {}).get("title", "Unknown feed")
        title_raw = item.get("title", "")
        title = strip_html(extract_content(title_raw))
        content_raw = item.get("content", "")
        content = strip_html(extract_content(content_raw))

        # Check for interest match first (configured interests take priority)
        interest_match = None
        for group in groups:
            for kw in group.get("keywords", []):
                if kw.lower() in title.lower() or kw.lower() in content.lower():
                    interest_match = group["name"]
                    break
            if interest_match:
                break

        # Determine grouping category: interest name or derived topic
        category = interest_match or _derive_topic(title, content)

        if category not in grouped:
            grouped[category] = {
                "items": [],
                "interest": interest_match is not None,
                "topic": category,
                "sources": [],
            }
        else:
            # Update interest flag: True if ANY item in group is interest match.
            # This handles name collisions where an interest group name matches
            # a derived topic name - the group's interest flag reflects whether
            # any item matched a configured interest.
            if interest_match is not None:
                grouped[category]["interest"] = True

        # Track source feeds as metadata (deduplicated)
        if feed_title not in grouped[category]["sources"]:
            grouped[category]["sources"].append(feed_title)

        grouped[category]["items"].append(
            {
                "id": item.get("id", ""),
                "title": title,
                "content_snippet": content[:200] if content else "",
                "link": item.get("alternate", [{}])[0].get("href", ""),
                "date": date_key,
                "source": feed_title,  # Include source per-item for provenance
                "interest": interest_match is not None,  # Per-item interest flag
            }
        )

    return grouped


def extractive_summary(text: str, max_sentences: int = 2) -> str:
    """Extractive summary - return first max_sentences sentences."""
    sentences = re.split(r"(?<=[.!?])\s+", text)
    return " ".join(sentences[:max_sentences]) if sentences else text[:200]


def cmd_init(args: argparse.Namespace) -> int:
    """Initialize credentials via Keychain."""
    reachable, msg = check_freshrss_reachable(args.base_url)
    if not reachable:
        print(f"Warning: {msg}", file=sys.stderr)
        print("Proceeding anyway - may need to start FreshRSS first.\n")

    print("FreshRSS CLI - Credential Setup")
    print("-" * 40)
    print(f"Target: {args.base_url}{API_PATH}")

    if not sys.stdin.isatty():
        print("\nStdin mode: provide username and password on separate lines")
        lines = sys.stdin.read().splitlines()
        if len(lines) < 2:
            print(
                "Error: Need username and password on separate lines",
                file=sys.stderr,
            )
            return 1
        username = lines[0].strip()
        password = lines[1]
    else:
        username = input("Username: ").strip()
        password = getpass.getpass("Password (or API password): ")

    if not username or not password:
        print("Error: Username and password required", file=sys.stderr)
        return 1

    auth_token = get_auth_token(args.base_url, username, password)
    if not auth_token:
        print("Error: Authentication failed. Check credentials.", file=sys.stderr)
        return 1

    print(f"\nAuth token received: {auth_token[:8]}...")

    if store_credentials(username, password):
        print("Credentials stored in macOS Keychain successfully.")
        return 0
    else:
        print(
            "Warning: Could not store in Keychain. Credentials validated but not saved."
        )
        print(f"Username: {username}")  # Only show username, not password
        return 0


def cmd_unread(args: argparse.Namespace) -> int:
    """List unread items with optional digest grouping.

    For --digest: defaults to fetching ALL unread items unless --limit is explicit.
    Non-digest mode defaults to a safe display limit (20).
    """
    creds = get_credentials()
    if not creds:
        print(
            "Error: No credentials found. Run 'freshrss init' first.",
            file=sys.stderr,
        )
        return 1
    username, password = creds

    auth_token = get_auth_token(args.base_url, username, password)
    if not auth_token:
        print(
            "Error: Authentication failed. Run 'freshrss init' to update credentials.",
            file=sys.stderr,
        )
        return 1

    reachable, msg = check_freshrss_reachable(args.base_url)
    if not reachable and not args.force:
        print(f"Error: {msg}", file=sys.stderr)
        return 1

    # Default: --digest fetches all, non-digest shows limited view
    if args.digest:
        # For digest, default to ALL unread (limit=None triggers pagination)
        limit = args.limit  # None means all, explicit value means bounded
    else:
        # Non-digest defaults to safe display limit
        limit = args.limit or 20

    items = list_items(args.base_url, auth_token, unread_only=True, limit=limit)
    if items is None:
        print("Error: Failed to fetch unread items", file=sys.stderr)
        return 1

    # Track whether result is complete or bounded
    is_complete = args.limit is None or len(items) < args.limit
    limit_applied = args.limit if args.limit is not None else None

    if args.raw:
        # Raw output returns grouped JSON with completeness metadata
        groups = load_interests()
        grouped = group_items_for_digest(items, groups)
        output = {
            "groups": grouped,
            "fetched_count": len(items),
            "complete": is_complete,
            "limit_applied": limit_applied,
        }
        print(json.dumps(output, indent=2))
        return 0

    if not items:
        print("No unread items")
        return 0

    if args.digest:
        groups = load_interests()
        grouped = group_items_for_digest(items, groups)

        # Header distinguishes complete vs bounded review
        if is_complete and limit_applied is None:
            print(f"FreshRSS Digest - reviewed all {len(items)} unread items\n")
        else:
            print(
                f"FreshRSS Digest - reviewed {len(items)} fetched items "
                f"(bounded by --limit; more may exist)\n"
            )

        # Build curated highlights: 5-8 top items with brief summaries.
        # Collect all items with priority scoring, then select top 5-8.
        # Interest-matched items are prioritised, then fill from other items.
        highlights: list[dict] = []

        # Collect all items from all groups, using per-item interest flag
        all_items: list[tuple[str, dict]] = []  # (category, item)
        for category, data in grouped.items():
            for item in data["items"]:
                all_items.append((category, item))

        # Sort by interest flag (True first), preserving order within each group
        interest_items = [
            (cat, item) for cat, item in all_items if item.get("interest", False)
        ]
        other_items = [
            (cat, item) for cat, item in all_items if not item.get("interest", False)
        ]

        # Select up to 8 highlights: prioritise interest items, then fill
        # Aim for 5-8 highlights. If fewer than 5 total items, show all.
        target_min, target_max = 5, 8

        # Add interest-matched items first (up to target_max)
        for category, item in interest_items[:target_max]:
            highlights.append(
                {
                    "id": item["id"],
                    "title": item["title"],
                    "summary": (
                        extractive_summary(item["content_snippet"])
                        if item["content_snippet"]
                        else ""
                    ),
                    "category": category,
                    "interest": item.get("interest", False),
                    "source": item.get("source", ""),
                }
            )

        # Fill remaining slots from other items if needed
        if len(highlights) < target_min:
            remaining = target_max - len(highlights)
            for category, item in other_items[:remaining]:
                highlights.append(
                    {
                        "id": item["id"],
                        "title": item["title"],
                        "summary": (
                            extractive_summary(item["content_snippet"])
                            if item["content_snippet"]
                            else ""
                        ),
                        "category": category,
                        "interest": item.get("interest", False),
                        "source": item.get("source", ""),
                    }
                )

        # Print curated highlights section
        if highlights:
            print("📌 Highlights (most relevant first):\n")
            for hl in highlights[:8]:
                icon = "★" if hl["interest"] else "○"
                source_note = f" | {hl['source']}" if hl.get("source") else ""
                print(f"{icon} {hl['title']}{source_note}")
                if hl["summary"]:
                    print(f"   → {hl['summary']}")
                print(f"   [ID: {hl['id']}]")
                print()

            if len(highlights) > 8:
                print(f"... and {len(highlights) - 8} more highlights available\n")

        # Print topic groups (feed names only as provenance metadata)
        print("📁 Topics:\n")
        for category, data in grouped.items():
            icon = "★" if data["interest"] else "○"
            count = len(data["items"])
            sources_str = ""
            if data["sources"]:
                sources_list = ", ".join(data["sources"][:3])
                if len(data["sources"]) > 3:
                    sources_list += f" +{len(data['sources']) - 3} more"
                sources_str = f" (from {sources_list})"
            else:
                sources_str = ""
            items_text = "item" if count == 1 else "items"
            print(f"{icon} {category}: {count} {items_text}{sources_str}")

        # Note about bounded review
        if not is_complete:
            print(
                f"\nⓘ  Reviewed {len(items)} items (bounded by --limit); "
                "more unread items may exist."
            )
        print()
    else:
        print(f"Unread items ({len(items)}):\n")
        for i, item in enumerate(items[: args.limit or len(items)], 1):
            title = strip_html(item.get("title", ""))
            feed = item.get("origin", {}).get("title", "")
            print(f"{i}. [{feed}] {title}")
            print(f"   Link: {item.get('alternate', [{}])[0].get('href', '')}")
            if item.get("id"):
                print(f"   ID: {item['id']}")
            print()

    return 0


def cmd_read(args: argparse.Namespace) -> int:
    """List recently read items."""
    creds = get_credentials()
    if not creds:
        print(
            "Error: No credentials found. Run 'freshrss init' first.",
            file=sys.stderr,
        )
        return 1
    username, password = creds

    auth_token = get_auth_token(args.base_url, username, password)
    if not auth_token:
        print("Error: Authentication failed", file=sys.stderr)
        return 1

    # Fetch from reading-list with it= filter for read state
    # Correct API: /stream/contents/reading-list?it=user/-/state/com.google/read
    items = list_items(
        args.base_url,
        auth_token,
        unread_only=False,
        limit=args.limit or 10,
        stream="reading-list",
        include_tag="user/-/state/com.google/read",
    )
    if items is None:
        print("Error: Failed to fetch read items", file=sys.stderr)
        return 1

    if args.raw:
        print(json.dumps(items, indent=2))
        return 0

    if not items:
        print("No recent read items")
        return 0

    print(f"Recently read items ({len(items)}):\n")
    for i, item in enumerate(items[: args.limit or len(items)], 1):
        title = strip_html(item.get("title", ""))
        feed = item.get("origin", {}).get("title", "")
        print(f"{i}. [{feed}] {title}")
    print()
    return 0


def cmd_view(args: argparse.Namespace) -> int:
    """View a single item by ID."""
    creds = get_credentials()
    if not creds:
        print(
            "Error: No credentials found. Run 'freshrss init' first.",
            file=sys.stderr,
        )
        return 1
    username, password = creds

    auth_token = get_auth_token(args.base_url, username, password)
    if not auth_token:
        print("Error: Authentication failed", file=sys.stderr)
        return 1

    # Extract item ID (supports full ID or just the numeric part)
    item_id = args.id.split("/")[-1] if "/" in args.id else args.id
    contents = get_item_contents(args.base_url, auth_token, [item_id])
    if not contents:
        print("Error: Failed to fetch item", file=sys.stderr)
        return 1

    if not contents:
        print("Error: Item not found", file=sys.stderr)
        return 1

    item = contents[0]

    if args.raw:
        print(json.dumps(item, indent=2))
        return 0

    title = strip_html(extract_content(item.get("title", "")))
    content = strip_html(extract_content(item.get("content", "")))
    feed = item.get("origin", {}).get("title", "")
    link = item.get("alternate", [{}])[0].get("href", "")

    print(f"Title: {title}")
    print(f"Feed: {feed}")
    print(f"Link: {link}")
    print(f"\nContent:\n{content[:2000]}")
    if len(content) > 2000:
        print("\n... (content truncated)")
    print()
    return 0


def cmd_mark_read(args: argparse.Namespace) -> int:
    """Mark items as read by ID."""
    creds = get_credentials()
    if not creds:
        print(
            "Error: No credentials found. Run 'freshrss init' first.",
            file=sys.stderr,
        )
        return 1
    username, password = creds

    auth_token = get_auth_token(args.base_url, username, password)
    if not auth_token:
        print("Error: Authentication failed", file=sys.stderr)
        return 1

    # Fetch edit token for state-changing operation
    edit_token = get_token(args.base_url, auth_token)
    if not edit_token:
        print("Error: Failed to get edit token", file=sys.stderr)
        return 1

    items = list(args.id) if args.id else []
    if not items:
        if not sys.stdin.isatty():
            items = sys.stdin.read().split()
        if not items:
            print("Error: Provide item IDs as arguments or via stdin", file=sys.stderr)
            return 1

    if mark_as_read(args.base_url, auth_token, edit_token, items):
        print(f"Marked {len(items)} item(s) as read")
        return 0
    else:
        print("Error: Failed to mark items as read", file=sys.stderr)
        return 1


def cmd_interests_show(args: argparse.Namespace) -> int:
    """Show current interests."""
    groups = load_interests()
    if args.raw:
        print(json.dumps({"groups": groups}, indent=2))
        return 0

    if not groups:
        print("No interests configured")
        print("\nAdd interests with:")
        print("  freshrss interests set --name python --keywords python,programming")
        return 0

    print("Current interests:\n")
    for group in groups:
        print(f"  {group['name']}: {', '.join(group['keywords'])}")
    print()
    return 0


def cmd_interests_set(args: argparse.Namespace) -> int:
    """Set an interest group (replaces existing group with same name)."""
    groups = load_interests()
    groups = [g for g in groups if g["name"] != args.name]
    groups.append({"name": args.name, "keywords": args.keywords.split(",")})

    if save_interests(groups):
        print(f"Interest group '{args.name}' saved")
        return 0
    else:
        print("Error: Failed to save interests", file=sys.stderr)
        return 1


def cmd_interests_remove_all(args: argparse.Namespace) -> int:
    """Remove all interest groups."""
    if INTERESTS_FILE.exists():
        try:
            INTERESTS_FILE.unlink()
            print("All interests removed")
            return 0
        except OSError:
            print("Error: Failed to remove interests file", file=sys.stderr)
            return 1
    else:
        print("No interests file found")
        return 0


def cmd_health(args: argparse.Namespace) -> int:
    """Check FreshRSS connectivity and credentials."""
    reachable, msg = check_freshrss_reachable(args.base_url)
    print(f"Connectivity: {'✓' if reachable else '✗'} - {msg}")

    creds = get_credentials()
    auth_ok = False
    if creds:
        username, password = creds
        auth_token = get_auth_token(args.base_url, username, password)
        if auth_token:
            auth_ok = True
            print(f"Credentials: ✓ - authenticated as {username}")
            streams = list_streams(args.base_url, auth_token)
            if streams:
                print(f"Subscriptions: {len(streams)} feeds")
            else:
                print("Subscriptions: Unable to fetch")
        else:
            print("Credentials: ✗ - authentication failed")
    else:
        print("Credentials: ✗ - not found (run 'freshrss init')")

    # Exit 0 only when reachable and (no credentials configured or auth succeeds)
    # Exit 1 when not reachable, or when credentials exist but auth fails
    return 0 if reachable and (creds is None or auth_ok) else 1


def add_base_url_arg(parser: argparse.ArgumentParser) -> None:
    """Add --base-url argument to a subcommand parser.

    Uses argparse.SUPPRESS as default so that top-level --base-url
    is respected. Subcommand --base-url works independently.
    """
    parser.add_argument(
        "--base-url",
        default=argparse.SUPPRESS,
        help="FreshRSS base URL (default: inherited from top-level)",
    )


def main() -> int:
    """Entry point."""
    parser = argparse.ArgumentParser(
        prog="freshrss",
        description="FreshRSS CLI - interact with local FreshRSS instance",
    )
    parser.add_argument(
        "--base-url",
        default=DEFAULT_BASE_URL,
        help=f"FreshRSS base URL (default: {DEFAULT_BASE_URL})",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Proceed even if FreshRSS is not reachable",
    )

    subparsers = parser.add_subparsers(dest="command", required=True)

    sub_init = subparsers.add_parser("init", help="Initialize credentials")
    add_base_url_arg(sub_init)
    sub_init.set_defaults(func=cmd_init)

    sub_unread = subparsers.add_parser("unread", help="List unread items")
    add_base_url_arg(sub_unread)
    sub_unread.add_argument(
        "--force",
        action="store_true",
        help="Proceed even if FreshRSS is not reachable",
    )
    sub_unread.add_argument(
        "-n",
        "--limit",
        type=int,
        help="Optional max items to fetch (default: all for --digest, 20 otherwise)",
    )
    sub_unread.add_argument("--digest", action="store_true", help="Show digest view")
    sub_unread.add_argument("--raw", action="store_true", help="Output raw JSON")
    sub_unread.set_defaults(func=cmd_unread)

    sub_read = subparsers.add_parser("read", help="List recently read items")
    add_base_url_arg(sub_read)
    sub_read.add_argument(
        "-n",
        "--limit",
        type=int,
        help="Optional max items to show (default: 10)",
    )
    sub_read.add_argument("--raw", action="store_true", help="Output raw JSON")
    sub_read.set_defaults(func=cmd_read)

    sub_view = subparsers.add_parser("view", help="View single item by ID")
    add_base_url_arg(sub_view)
    sub_view.add_argument("id", help="Item ID")
    sub_view.add_argument("--raw", action="store_true", help="Output raw JSON")
    sub_view.set_defaults(func=cmd_view)

    sub_mark = subparsers.add_parser("mark-read", help="Mark items as read")
    add_base_url_arg(sub_mark)
    sub_mark.add_argument("id", nargs="*", help="Item IDs to mark as read")
    sub_mark.set_defaults(func=cmd_mark_read)

    sub_health = subparsers.add_parser(
        "health", help="Check connectivity and credentials"
    )
    add_base_url_arg(sub_health)
    sub_health.set_defaults(func=cmd_health)

    sub_interests = subparsers.add_parser("interests", help="Manage interests")
    add_base_url_arg(sub_interests)
    interests_sub = sub_interests.add_subparsers(dest="interests_cmd", required=True)

    sub_show = interests_sub.add_parser("show", help="Show current interests")
    sub_show.add_argument("--raw", action="store_true", help="Output raw JSON")
    sub_show.set_defaults(func=cmd_interests_show)

    sub_set = interests_sub.add_parser("set", help="Set interest group")
    sub_set.add_argument("--name", required=True, help="Group name")
    sub_set.add_argument("--keywords", required=True, help="Comma-separated keywords")
    sub_set.set_defaults(func=cmd_interests_set)

    sub_remove_all = interests_sub.add_parser("remove-all", help="Remove all interests")
    sub_remove_all.set_defaults(func=cmd_interests_remove_all)

    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
