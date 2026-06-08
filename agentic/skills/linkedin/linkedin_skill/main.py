#!/usr/bin/env python3
"""CLI for managing Dan's LinkedIn presence (handle: saattrupdan).

LinkedIn has no public API for drafts, scheduling, or reading your own posts,
so this drives the real LinkedIn web UI by shelling out to the `agent-browser`
binary. Standard library only.

The agent-browser browser is a long-lived daemon: it stays running between CLI
invocations and keeps its page/session. That is what makes two-stage login
work -- `linkedin login` leaves the browser on the authenticator-code page, and
a later `linkedin login --code XXXXXX` fills it in.

See ./SKILL.md for the human-facing guide and Dan's post-style notes.
"""

from __future__ import annotations

import argparse
import json
import logging
import re
import subprocess
import sys
import typing as t
from pathlib import Path

from .credentials import get_linkedin_credentials, save_credential

ENV_FILE = Path.home() / ".env"
BROWSER_SESSION_NAME = "linkedin"  # Persistent browser session for faster logins

HANDLE = "saattrupdan"
FEED_URL = "https://www.linkedin.com/feed/"
LOGIN_URL = "https://www.linkedin.com/login"
ACTIVITY_URL = f"https://www.linkedin.com/in/{HANDLE}/recent-activity/all/"
UPDATE_URL = "https://www.linkedin.com/feed/update/{urn}/"

# Stable selectors discovered against the live site. LinkedIn's element ids are
# dynamic (":r3:" etc.) and labels are localised, so we key off type/autocomplete
# attributes and pick the *visible* match (offsetParent !== null).
EMAIL_SEL = "input[autocomplete=username]"
PASSWORD_SEL = "input[autocomplete=current-password]"
SUBMIT_SEL = "button[type=submit]"
CODE_SEL = "input[type=text], input[type=tel], input[type=number]"

logging.basicConfig(level=logging.INFO, format="%(message)s", stream=sys.stdout)
logger = logging.getLogger("linkedin")


# --------------------------------------------------------------------------- #
# agent-browser plumbing
# --------------------------------------------------------------------------- #
class BrowserError(RuntimeError):
    """An agent-browser command failed."""


def ab(*args: str, check: bool = True, timeout: int = 90) -> str:
    """Run an agent-browser command and return its stripped stdout.
    
    Always uses --session-name for persistent cookies/storage between invocations.
    """
    # Prepend session name to all commands for persistent auth state
    all_args = ["agent-browser", "--session-name", BROWSER_SESSION_NAME, *args]
    try:
        proc = subprocess.run(
            all_args,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except FileNotFoundError as exc:  # pragma: no cover - env issue
        raise BrowserError(
            "agent-browser is not installed. Install it with:\n"
            "  npm i -g agent-browser && agent-browser install"
        ) from exc
    except subprocess.TimeoutExpired as exc:
        raise BrowserError(f"agent-browser {args[0]} timed out") from exc
    if check and proc.returncode != 0:
        raise BrowserError(
            f"agent-browser {' '.join(args)} failed:\n{proc.stderr.strip() or proc.stdout.strip()}"
        )
    return proc.stdout.strip()


def ab_eval(js: str):
    """Run JS in the page and return the parsed result.

    `agent-browser eval` already serialises return values as JSON (objects
    pretty-printed, strings quoted, bools/numbers raw), so we json.loads its
    output directly -- no JSON.stringify wrapper (that double-encodes).
    """
    out = ab("eval", js).strip()
    if not out or out in ("undefined", "null"):
        return None
    try:
        return json.loads(out)
    except json.JSONDecodeError as exc:
        raise BrowserError(f"could not parse eval output: {out[:200]}") from exc


def get_url() -> str:
    return ab("get", "url", check=False)


def tag_visible(selector: str, new_id: str) -> bool:
    """Give the first *visible* element matching `selector` a known id.

    Returns True if such an element was found. Lets us target a deterministic
    `#id` afterwards even when the page has duplicate/hidden copies of a field.
    """
    js = (
        "(() => { const e = [...document.querySelectorAll(%s)]"
        ".find(x => x.offsetParent !== null); "
        "if (e) { e.id = %s; return true; } return false; })()"
        % (json.dumps(selector), json.dumps(new_id))
    )
    return bool(ab_eval(js))


def click_visible_submit() -> None:
    if not tag_visible(SUBMIT_SEL, "ab_submit"):
        raise BrowserError("no visible submit button found")
    ab("click", "#ab_submit")


# --------------------------------------------------------------------------- #
# .env credential parsing (dotenv files are NOT valid shell, so do not source)
# --------------------------------------------------------------------------- #
def read_env_var(key: str) -> str | None:
    """Read KEY from ~/.env literally, tolerating unquoted special chars."""
    if not ENV_FILE.exists():
        return None
    pat = re.compile(rf"^\s*(?:export\s+)?{re.escape(key)}=(.*)$")
    for line in ENV_FILE.read_text(encoding="utf-8", errors="replace").splitlines():
        m = pat.match(line)
        if not m:
            continue
        val = m.group(1).strip()
        if len(val) >= 2 and val[0] == val[-1] and val[0] in "\"'":
            val = val[1:-1]
        return val
    return None


# --------------------------------------------------------------------------- #
# Session / login
# --------------------------------------------------------------------------- #
def is_logged_in() -> bool:
    """Check if already logged in by visiting feed and checking URL."""
    ab("open", FEED_URL, check=False)
    ab("wait", "--load", "networkidle", check=False, timeout=30)
    url = get_url()
    return "/feed" in url and "/login" not in url


def ensure_logged_in() -> None:
    """Check if logged in via persistent session; raise with guidance if not.
    
    The --session-name flag on all ab() calls persists cookies/storage between
    invocations, so this is fast when already authenticated.
    """
    if is_logged_in():
        return
    raise BrowserError(
        "Not logged in. Run `linkedin login` first "
        "(and `linkedin login --code XXXXXX` if it asks for an authenticator code)."
    )


def has_visible(selector: str) -> bool:
    return bool(
        ab_eval(
            "(() => [...document.querySelectorAll(%s)].some(x => x.offsetParent !== null))()"
            % json.dumps(selector)
        )
    )


def goto_authenticator_code_page() -> bool:
    """From a checkpoint page, switch to authenticator-code entry if needed.

    Returns True once a code input is visible on the page.
    """
    if has_visible(CODE_SEL):
        return True
    # App-notification challenge: click the "verify with authenticator app" link.
    js = (
        "(() => { const a = [...document.querySelectorAll('a, button')]"
        ".find(x => /authenticat|autentifik|verifikation|verification app/i.test(x.textContent || '')); "
        "if (a) { a.click(); return true; } return false; })()"
    )
    if ab_eval(js):
        ab("wait", "2500", check=False)
    return has_visible(CODE_SEL)


def submit_code(code: str) -> int:
    """Stage 2: enter the authenticator code on the current challenge page."""
    if not tag_visible(CODE_SEL, "ab_code"):
        logger.error(
            "No code field on the current page (URL: %s).\n"
            "Run `linkedin login` first to reach the challenge.",
            get_url(),
        )
        return 1
    ab("fill", "#ab_code", code)
    click_visible_submit()
    ab("wait", "4000", check=False)
    url = get_url()
    if "/feed" in url:
        logger.info("✓ Logged in (session persists via --session-name)")
        return 0
    if "checkpoint" in url or "challenge" in url:
        logger.error(
            "Code rejected or another step appeared (URL: %s).\n"
            "If the code expired, get a fresh one and run "
            "`linkedin login --code XXXXXX` again.",
            url,
        )
        return 1
    logger.error("Unexpected page after code submit: %s", url)
    return 1


def cmd_login(args: argparse.Namespace) -> int:
    # Stage 2: a code was supplied -> operate on the live challenge page.
    if args.code:
        return submit_code(args.code)

    # Verify flag: just check if logged in after manual browser login.
    if args.verify:
        if is_logged_in():
            logger.info("✓ Logged in and session saved.")
            return 0
        else:
            logger.error("Not logged in yet. Please complete login in the browser.")
            return 1

    # Already logged in?
    if not args.force and is_logged_in():
        logger.info("✓ Already logged in")
        return 0

    # Open login page - user should complete auth manually in browser.
    # The --session-name flag auto-saves cookies/storage after login.
    ab("open", LOGIN_URL)
    logger.info(
        " aidia» Opened LinkedIn login in browser.\n"
        "Please log in manually (username/password or SSO).\n"
        "Once logged in, the session will be auto-saved for future CLI commands.\n"
        "\n"
        "After completing login, run: linkedin login --verify"
    )
    return 0
    ab("wait", "4000", check=False)
    url = get_url()
    if "/feed" in url:
        logger.info("✓ Logged in")
        return 0

    if "checkpoint" in url or "challenge" in url:
        # Try a brief poll in case it's a push notification the user approves.
        for _ in range(args.wait_push // 3):
            ab("wait", "3000", check=False)
            if "/feed" in get_url():
                logger.info("✓ Login approved via app.")
                return 0
        # Fall back to authenticator-code entry.
        goto_authenticator_code_page()
        logger.info(
            "🔐 LinkedIn needs a verification code.\n"
            "Open your authenticator app and run:\n"
            "    linkedin login --code XXXXXX\n"
            "(The browser stays on the code page, so just supply the 6-digit code.)"
        )
        return 2

    logger.error("Login did not reach the feed (URL: %s).", url)
    return 1


# --------------------------------------------------------------------------- #
# Fetch recent posts
# --------------------------------------------------------------------------- #
# Shared JS: collect *top-level* activity cards and classify each.
#
# A repost is identified by the "X reposted this" banner header. In a repost the
# DOM order is: [repost header] -> [original author's actor] -> [original text].
# Dan's own commentary, when present, appears as a text block BEFORE the original
# author's actor. So:
#   - bare repost  (only text is after the actor)  -> dropped unless keepReposts
#   - repost +commentary (text before the actor)   -> kept, using Dan's text
#   - original post (no repost header)             -> kept, using its text
TOPLEVEL_JS = """
(keepReposts => {
  const REPOST_RE = /reposted this|delte dette igen|reposted$/i;
  const isActivity = n => (n.getAttribute('data-urn') || '').includes('activity');
  const all = [...document.querySelectorAll('div[data-urn]')].filter(isActivity);
  const top = all.filter(n => {
    for (let p = n.parentElement; p; p = p.parentElement) {
      if (p.matches && p.matches('div[data-urn]') && isActivity(p)) return false;
    }
    return true;
  });
  const clean = s => (s || '').replace(/\\s+/g, ' ').trim();
  const out = [];
  for (const n of top) {
    const urn = n.getAttribute('data-urn') || '';
    const hdr = n.querySelector('.update-components-header__text-view, .update-components-header');
    const isRepost = hdr ? REPOST_RE.test(hdr.innerText || '') : false;

    // Ordered walk: record actor blocks and text blocks in DOM order.
    const seq = [];
    (function walk(el) {
      for (const c of el.children) {
        const cl = (c.className || '').toString();
        if (/actor__name|actor__title/.test(cl)) seq.push({k: 'actor'});
        else if (/update-components-text|commentary/.test(cl)) seq.push({k: 'text', t: clean(c.innerText)});
        walk(c);
      }
    })(n);
    const firstText = (seq.find(s => s.k === 'text' && s.t) || {}).t || '';

    let text = firstText;
    let commentary = false;
    if (isRepost) {
      const actorIdx = seq.findIndex(s => s.k === 'actor');
      const own = seq.filter((s, i) => s.k === 'text' && s.t && (actorIdx < 0 || i < actorIdx));
      commentary = own.length > 0;
      if (!commentary && !keepReposts) continue;  // bare repost -> skip
      text = commentary ? own.map(s => s.t).join(' ').trim() : firstText;
    }

    const counts = [...n.querySelectorAll('.social-details-social-counts')].pop();
    out.push({urn, text, repost: isRepost, commentary, counts: counts ? clean(counts.innerText) : ''});
    if (out.length >= LIMIT) break;
  }
  return out;
})(KEEP)
"""


def parse_counts(counts: str) -> dict[str, int]:
    """Turn LinkedIn's social-counts string into {reactions, comments, reposts}."""
    reactions = comments = reposts = 0
    m = re.match(r"\s*([\d,]+)", counts)
    if m:
        reactions = int(m.group(1).replace(",", ""))
    m = re.search(r"([\d,]+)\s+comment", counts, re.I)
    if m:
        comments = int(m.group(1).replace(",", ""))
    m = re.search(r"([\d,]+)\s+repost", counts, re.I)
    if m:
        reposts = int(m.group(1).replace(",", ""))
    return {"reactions": reactions, "comments": comments, "reposts": reposts}


def cmd_posts(args: argparse.Namespace) -> int:
    # Skip explicit login check - operation will fail naturally if not authed
    ab("open", ACTIVITY_URL)
    ab("wait", "--load", "networkidle", check=False)
    # We read posts straight from the DOM via eval, so the cookie banner does
    # not need dismissing (and clicking a stray "Accept" would be risky).
    # Filter to "Posts" only (JS toggle; URL is unchanged).
    ab("find", "text", "Posts", "click", check=False)
    ab("wait", "--load", "networkidle", check=False)

    keep = "true" if args.include_reposts else "false"

    def extract(limit: int) -> list[dict[str, t.Any]]:
        """Extract posts from LinkedIn feed using JS evaluation."""
        result = ab_eval(TOPLEVEL_JS.replace("LIMIT", str(limit)).replace("KEEP", keep))
        return result or []

    # Lazy-load until we have enough qualifying posts (or stop making progress).
    last = -1
    for _ in range(args.number + 8):
        count = len(extract(args.number))
        if count >= args.number or count == last:
            if count >= args.number:
                break
        last = count
        ab("scroll", "down", "2000", check=False)
        ab("wait", "900", check=False)

    posts = extract(args.number)
    if not posts:
        logger.info("No posts found.")
        return 0

    if args.json:
        enriched = [
            {
                "url": UPDATE_URL.format(urn=p["urn"]),
                "text": p["text"],
                "repost": p.get("repost", False),
                "commentary": p.get("commentary", False),
                **parse_counts(p["counts"]),
            }
            for p in posts
        ]
        print(json.dumps(enriched, indent=2, ensure_ascii=False))
        return 0

    for i, p in enumerate(posts, 1):
        c = parse_counts(p["counts"])
        tag = ""
        if p.get("repost"):
            tag = " [repost +commentary]" if p.get("commentary") else " [bare repost]"
        first_line = (p["text"].splitlines() or [""])[0]
        body = (
            p["text"]
            if args.full
            else (first_line[:100] + ("…" if len(first_line) > 100 else ""))
        )
        if not body:
            body = "[no text]"
        logger.info(
            "%2d. %s%s\n    👍 %d  💬 %d  🔁 %d   %s\n",
            i,
            body,
            tag,
            c["reactions"],
            c["comments"],
            c["reposts"],
            UPDATE_URL.format(urn=p["urn"]),
        )
    return 0


# --------------------------------------------------------------------------- #
# Composer: post / draft / schedule
#
# The share box renders inside the linkedin.com/preload/ iframe, so main-frame
# `eval` cannot see it. We drive it through `agent-browser snapshot` (which
# pierces frames) and ref-based actions instead.
# --------------------------------------------------------------------------- #
# Accessible-name candidates for each control we drive. Multiple candidates per
# control absorb wording/locale changes (English + Danish) and minor relabels;
# "contains" matching tolerates extra words. If LinkedIn renames something, add
# a candidate here rather than touching the command logic.
EDITOR_NAMES = (
    "text editor for creating content",
    "editor",
    "what do you want to talk about",
)
SHARE_TRIGGER = ("start a post", "opret et opslag", "start indl\u00e6g")
BTN_POST = ("post", "opsl\u00e5", "del")
BTN_CLOSE = ("close", "dismiss", "luk")
BTN_SAVE_DRAFT = ("save as draft", "gem som kladde")
BTN_DISCARD = ("discard", "kass\u00e9r", "slet")


def snapshot_lines() -> list[str]:
    return ab("snapshot", "-i", check=False).splitlines()


# A snapshot line looks like:  `  - button "Start a post" [disabled, ref=e38]`
NODE_RE = re.compile(r'(?P<role>[A-Za-z]+)\s+"(?P<name>[^"]*)"')
REF_RE = re.compile(r"ref=(e\d+)")


def parse_nodes(lines: list[str] | None = None) -> list[dict]:
    """Parse snapshot lines into {role, name, ref, disabled, line} dicts."""
    nodes = []
    for line in lines if lines is not None else snapshot_lines():
        nm = NODE_RE.search(line)
        rm = REF_RE.search(line)
        if nm and rm:
            nodes.append(
                {
                    "role": nm.group("role").lower(),
                    "name": nm.group("name").strip(),
                    "ref": rm.group(1),
                    "disabled": "disabled" in line.lower(),
                    "line": line.strip(),
                }
            )
    return nodes


def find_node(
    names,
    role: str | None = None,
    exact: bool = False,
    nodes: list[dict] | None = None,
) -> dict | None:
    """Find a node by role and accessible name.

    `names` is a string or iterable of candidate names (lower-cased). With
    `exact`, the name must equal a candidate; otherwise it must contain one.
    Candidates are tried in order, so list the most specific first.
    """
    if isinstance(names, str):
        names = (names,)
    pool = nodes if nodes is not None else parse_nodes()
    for cand in names:
        c = cand.lower()
        for n in pool:
            if role and n["role"] != role:
                continue
            nm = n["name"].lower()
            if (nm == c) if exact else (c in nm):
                return n
    return None


def click_node(
    names, role: str | None = None, exact: bool = False, required: bool = True
) -> bool:
    n = find_node(names, role=role, exact=exact)
    if not n:
        if required:
            raise BrowserError(f"could not find element to click: {names!r}")
        return False
    ab("click", f"@{n['ref']}")
    return True


def open_composer() -> None:
    # Note: we deliberately do NOT dismiss the cookie-consent banner. It does
    # not block the composer, and clicking a stray "Accept" risks hitting an
    # unrelated control (e.g. a connection invite) and navigating away.
    ab("open", FEED_URL, check=False)
    # Brief wait for header elements to be ready.
    ab("wait", "500", check=False)
    # Click share button and poll for editor to appear in iframe.
    btn = find_node(SHARE_TRIGGER, role="button")
    if not btn:
        raise BrowserError("could not find the 'Start a post' button on the feed")
    ab("click", f"@{btn['ref']}")
    # Poll for composer editor (inside iframe, needs fresh snapshots each time).
    for _ in range(10):  # Up to 5s
        ab("snapshot", "-i", check=False)
        try:
            ref = editor_ref()
            return
        except BrowserError:
            ab("wait", "400", check=False)
    raise BrowserError("the post composer did not open")


def editor_ref() -> str:
    n = find_node(EDITOR_NAMES, role="textbox")
    if not n:
        raise BrowserError("could not find the composer editor")
    return n["ref"]


def type_into_editor(text: str) -> None:
    # Keystroke-free by design: we never send key chords. Synthetic Cmd/Ctrl
    # combinations (e.g. select-all) can leak to the OS, so we avoid `press`
    # entirely and rely on click + fill (in-page CDP events).
    #
    # The composer auto-loads any saved draft. Rather than clobbering or merging
    # it (which previously required a select-all keystroke), refuse to type over
    # existing content and tell the user to deal with the draft first.
    ref = editor_ref()
    if read_editor().strip():
        raise BrowserError(
            "the composer already contains text (an auto-loaded draft). Review it "
            "with `linkedin drafts`, then discard that draft in the browser before "
            "posting/scheduling fresh text."
        )
    ab("click", f"@{ref}")
    ab("fill", f"@{ref}", text)


def read_editor() -> str:
    n = find_node(EDITOR_NAMES, role="textbox")
    return ab("get", "text", f"@{n['ref']}", check=False) if n else ""


def close_composer(save_draft: bool) -> None:
    """Close the composer, choosing Save-as-draft or Discard if prompted."""
    # Exact match: a substring match on "close" would hit "Close jump menu".
    click_node(BTN_CLOSE, role="button", exact=True, required=False)
    # Poll for save/discard dialog with snapshots.
    want_names = BTN_SAVE_DRAFT if save_draft else BTN_DISCARD
    btn = None
    for _ in range(6):  # Up to 3s
        ab("snapshot", "-i", check=False)
        btn = find_node(want_names, role="button")
        if btn:
            ab("click", f"@{btn['ref']}", check=False)
            # Wait for LinkedIn to persist the draft to storage.
            ab("wait", "1500", check=False)
            return
        ab("wait", "400", check=False)


def cmd_post(args):
    # Skip explicit login check - operation will fail naturally if not authed
    open_composer()
    type_into_editor(args.text)
    logger.info("Composer now contains:\n---\n%s\n---", read_editor().strip())
    if not args.yes:
        logger.info("Dry run -- nothing posted. Re-run with --yes to publish.")
        close_composer(save_draft=False)  # leave LinkedIn clean
        return 0
    # The Post button is disabled until there is content; click the enabled one.
    if not click_node(BTN_POST, role="button", exact=True, required=False):
        raise BrowserError("could not find an enabled Post button")
    ab("wait", "3000", check=False)
    logger.info("\u2713 Posted (verify on your feed).")
    return 0


def cmd_draft(args):
    # Skip explicit login check - operation will fail naturally if not authed
    open_composer()
    type_into_editor(args.text)
    logger.info("Draft content:\n---\n%s\n---", read_editor().strip())
    close_composer(save_draft=True)
    logger.info("\u2713 Saved as draft (view with `linkedin drafts`).")
    return 0


# --------------------------------------------------------------------------- #
# View drafts / scheduled
# --------------------------------------------------------------------------- #
def cmd_drafts(args):
    # Skip explicit login check - operation will fail naturally if not authed
    # Opening the composer auto-loads the most recent draft into the editor
    # (LinkedIn shows a "Draft:" label). A fresh composer with no draft is empty.
    open_composer()
    # Brief wait for LinkedIn to auto-load the draft from storage.
    ab("wait", "1000", check=False)
    content = read_editor().strip()
    if content:
        logger.info("Current draft:\n---\n%s\n---", content)
    else:
        logger.info("No draft found.")
    # Leave the draft intact (re-save on close rather than discard).
    close_composer(save_draft=True)
    return 0


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #
def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="linkedin", description=__doc__.strip().splitlines()[0]
    )
    sub = p.add_subparsers(dest="cmd", required=True)

    sp = sub.add_parser("login", help="log in (saves session; --code for 2FA stage 2)")
    sp.add_argument("--code", help="authenticator code for stage 2 of login")
    sp.add_argument(
        "--force", action="store_true", help="re-login even if a session exists"
    )
    sp.add_argument(
        "--wait-push",
        type=int,
        default=18,
        help="seconds to wait for an app-push approval before asking for a code",
    )
    sp.add_argument(
        "--verify",
        action="store_true",
        help="verify login completed (used after manual browser login)",
    )
    sp.set_defaults(func=cmd_login)

    sp = sub.add_parser("posts", help="fetch recent posts with engagement stats")
    sp.add_argument(
        "-n", "--number", type=int, default=10, help="how many posts (default 10)"
    )
    sp.add_argument(
        "--full",
        action="store_true",
        help="print full post text, not just the first line",
    )
    sp.add_argument(
        "--include-reposts",
        action="store_true",
        help="include bare reposts (reshares with no commentary of your own)",
    )
    sp.add_argument("--json", action="store_true", help="output JSON")
    sp.set_defaults(func=cmd_posts)

    sp = sub.add_parser("post", help="publish a post now")
    sp.add_argument("text", help="the full post text")
    sp.add_argument(
        "--yes", action="store_true", help="actually publish (otherwise dry run)"
    )
    sp.set_defaults(func=cmd_post)

    sp = sub.add_parser("draft", help="save a post as a draft")
    sp.add_argument("text", help="the full post text")
    sp.set_defaults(func=cmd_draft)

    sp = sub.add_parser("drafts", help="view saved drafts")
    sp.set_defaults(func=cmd_drafts)

    return p


def main() -> None:
    args = build_parser().parse_args()
    try:
        sys.exit(args.func(args))
    except BrowserError as exc:
        logger.error("%s", exc)
        sys.exit(1)
    except KeyboardInterrupt:  # pragma: no cover
        sys.exit(130)


if __name__ == "__main__":
    main()
