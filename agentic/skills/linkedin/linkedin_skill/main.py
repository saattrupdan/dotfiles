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
from pathlib import Path

SESSION_FILE = Path.home() / ".linkedin-session.json"
ENV_FILE = Path.home() / ".env"

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
    """Run an agent-browser command and return its stripped stdout."""
    try:
        proc = subprocess.run(
            ["agent-browser", *args],
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
def restore_session() -> bool:
    """Load a saved session and confirm it lands on the feed. True if logged in."""
    if not SESSION_FILE.exists():
        return False
    ab("state", "load", str(SESSION_FILE), check=False)
    ab("open", FEED_URL, check=False)
    ab("wait", "2000", check=False)
    return "/feed" in get_url()


def save_session() -> None:
    ab("state", "save", str(SESSION_FILE))


def ensure_logged_in() -> None:
    """Raise with guidance if no usable session exists."""
    if restore_session():
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
        save_session()
        logger.info("✓ Logged in and session saved to %s", SESSION_FILE)
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

    # Already logged in?
    if not args.force and restore_session():
        save_session()
        logger.info("✓ Already logged in (session restored from %s)", SESSION_FILE)
        return 0

    user = read_env_var("LINKEDIN_USER")
    pw = read_env_var("LINKEDIN_PASS")
    if not user or not pw:
        logger.error(
            "Missing credentials. Add to %s (dotenv format):\n"
            "  LINKEDIN_USER=you@example.com\n"
            "  LINKEDIN_PASS=your-password",
            ENV_FILE,
        )
        return 1

    ab("open", LOGIN_URL)
    ab("wait", "2000", check=False)
    if not tag_visible(EMAIL_SEL, "ab_email"):
        logger.error("Could not find the email field on the login page.")
        return 1
    ab("fill", "#ab_email", user)
    if not tag_visible(PASSWORD_SEL, "ab_pw"):
        logger.error("Could not find the password field on the login page.")
        return 1
    ab("fill", "#ab_pw", pw)
    click_visible_submit()
    ab("wait", "4000", check=False)

    url = get_url()
    if "/feed" in url:
        save_session()
        logger.info("✓ Logged in and session saved to %s", SESSION_FILE)
        return 0

    if "checkpoint" in url or "challenge" in url:
        # Try a brief poll in case it's a push notification the user approves.
        for _ in range(args.wait_push // 3):
            ab("wait", "3000", check=False)
            if "/feed" in get_url():
                save_session()
                logger.info("✓ Login approved via app. Session saved.")
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
    ensure_logged_in()
    ab("open", ACTIVITY_URL)
    ab("wait", "--load", "networkidle", check=False)
    # We read posts straight from the DOM via eval, so the cookie banner does
    # not need dismissing (and clicking a stray "Accept" would be risky).
    # Filter to "Posts" only (JS toggle; URL is unchanged).
    ab("find", "text", "Posts", "click", check=False)
    ab("wait", "--load", "networkidle", check=False)

    keep = "true" if args.include_reposts else "false"
    extract = lambda limit: ab_eval(  # noqa: E731
        TOPLEVEL_JS.replace("LIMIT", str(limit)).replace("KEEP", keep)
    ) or []

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
        body = p["text"] if args.full else (first_line[:100] + ("…" if len(first_line) > 100 else ""))
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
EDITOR_NAMES = ("text editor for creating content", "editor", "what do you want to talk about")
SHARE_TRIGGER = ("start a post", "opret et opslag", "start indl\u00e6g")
BTN_POST = ("post", "opsl\u00e5", "del")
BTN_SCHEDULE = ("schedule post", "schedule", "planl\u00e6g")
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
            nodes.append({
                "role": nm.group("role").lower(),
                "name": nm.group("name").strip(),
                "ref": rm.group(1),
                "disabled": "disabled" in line.lower(),
                "line": line.strip(),
            })
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


def click_node(names, role: str | None = None, exact: bool = False, required: bool = True) -> bool:
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
    ab("open", FEED_URL)
    ab("wait", "--load", "networkidle", check=False)
    # Find + click the share trigger ONCE (retry only the *find*, since the feed
    # may still be rendering -- re-clicking would cancel the opening modal).
    clicked = False
    for _ in range(5):
        if find_node(EDITOR_NAMES, role="textbox"):  # already open?
            return
        if click_node(SHARE_TRIGGER, role="button", required=False):
            clicked = True
            break
        ab("wait", "1000", check=False)
    if not clicked:
        raise BrowserError("could not find the 'Start a post' button on the feed")
    # Poll for the composer editor (it loads inside the preload iframe).
    for _ in range(12):
        ab("wait", "1200", check=False)
        if find_node(EDITOR_NAMES, role="textbox"):
            return
    raise BrowserError("the post composer did not open")


def editor_ref() -> str:
    n = find_node(EDITOR_NAMES, role="textbox")
    if not n:
        raise BrowserError("could not find the composer editor")
    return n["ref"]


def type_into_editor(text: str) -> None:
    # NB: do not press Escape afterwards -- in this composer Escape closes the
    # whole modal (discarding content), it does not just dismiss autocomplete.
    ref = editor_ref()
    ab("click", f"@{ref}")
    # Explicitly clear first: LinkedIn may auto-restore prior unsaved content,
    # and `fill` does not reliably clear a contenteditable. Select-all + delete
    # (try both Meta and Control so it works regardless of platform).
    for combo in ("Meta+a", "Control+a"):
        ab("press", combo, check=False)
    ab("press", "Backspace", check=False)
    ab("fill", f"@{ref}", text)


def read_editor() -> str:
    n = find_node(EDITOR_NAMES, role="textbox")
    return ab("get", "text", f"@{n['ref']}", check=False) if n else ""


def close_composer(save_draft: bool) -> None:
    """Close the composer, choosing Save-as-draft or Discard if prompted."""
    # Exact match: a substring match on "close" would hit "Close jump menu".
    click_node(BTN_CLOSE, role="button", exact=True, required=False)
    ab("wait", "1500", check=False)
    want = BTN_SAVE_DRAFT if save_draft else BTN_DISCARD
    click_node(want, role="button", required=False)
    ab("wait", "1000", check=False)


def cmd_post(args):
    ensure_logged_in()
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
    ensure_logged_in()
    open_composer()
    type_into_editor(args.text)
    logger.info("Draft content:\n---\n%s\n---", read_editor().strip())
    close_composer(save_draft=True)
    logger.info("\u2713 Saved as draft (view with `linkedin drafts`).")
    return 0


def parse_when(when: str) -> tuple[str, str]:
    """Parse 'YYYY-MM-DD HH:MM' into LinkedIn's (MM/DD/YYYY, 'H:MM AM/PM')."""
    import datetime

    when = when.strip().replace("T", " ")
    for fmt in ("%Y-%m-%d %H:%M", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d"):
        try:
            dt = datetime.datetime.strptime(when, fmt)
            break
        except ValueError:
            dt = None
    if dt is None:
        raise BrowserError(
            f"could not parse --at {when!r}; use 'YYYY-MM-DD HH:MM' (e.g. 2026-06-02 09:00)"
        )
    date_str = dt.strftime("%m/%d/%Y")
    hour12 = dt.hour % 12 or 12
    time_str = f"{hour12}:{dt.minute:02d} {'AM' if dt.hour < 12 else 'PM'}"
    return date_str, time_str


def cmd_schedule(args):
    ensure_logged_in()
    date_str, time_str = parse_when(args.at)
    open_composer()
    type_into_editor(args.text)
    logger.info("Scheduling content:\n---\n%s\n---", read_editor().strip())
    click_node(BTN_SCHEDULE, role="button")
    ab("wait", "1500", check=False)
    # Fill the date and time fields (best effort -- the picker varies by locale).
    dn = find_node(("Date",), role="textbox")
    if dn:
        ab("fill", f"@{dn['ref']}", date_str)
    tn = find_node(("Time",), role="combobox")
    if tn:
        ab("fill", f"@{tn['ref']}", time_str, check=False)
        ab("press", "Enter", check=False)
    logger.info("Set date=%s time=%s", date_str, time_str)
    click_node(("Next",), role="button", required=False)
    ab("wait", "1200", check=False)
    if not args.yes:
        logger.info(
            "Review step reached but NOT scheduled (dry run). Verify the date/time "
            "in the browser and re-run with --yes to confirm scheduling."
        )
        return 0
    # Final confirm: the primary button now reads "Schedule".
    if not click_node(("Schedule",), role="button", exact=True, required=False):
        click_node(BTN_SCHEDULE, role="button")
    ab("wait", "2500", check=False)
    logger.info("✓ Scheduled for %s %s (verify with `linkedin scheduled`).", date_str, time_str)
    return 0


# --------------------------------------------------------------------------- #
# View drafts / scheduled
# --------------------------------------------------------------------------- #
def cmd_drafts(args):
    ensure_logged_in()
    # Opening the composer auto-loads the most recent draft into the editor
    # (LinkedIn shows a "Draft:" label). A fresh composer with no draft is empty.
    open_composer()
    content = read_editor().strip()
    if content:
        logger.info("Current draft:\n---\n%s\n---", content)
    else:
        logger.info("No draft found.")
    # Leave the draft intact (re-save on close rather than discard).
    close_composer(save_draft=True)
    return 0


def cmd_scheduled(args):
    ensure_logged_in()
    open_composer()
    click_node(BTN_SCHEDULE, role="button")
    ab("wait", "1500", check=False)
    click_node(("view all scheduled", "scheduled posts", "planlagte opslag"), required=False)
    ab("wait", "1500", check=False)
    # If the composer held content, leaving it prompts "save as draft?" -- keep
    # the draft so we don't lose it, which also lets the scheduled view open.
    click_node(BTN_SAVE_DRAFT, role="button", required=False)
    ab("wait", "--load", "networkidle", check=False)

    full = ab("snapshot", check=False).splitlines()
    if find_node(("no scheduled posts", "ingen planlagte"), nodes=parse_nodes(full)):
        logger.info("No scheduled posts.")
        return 0
    # Best effort: print the text content of the "Scheduled posts" dialog.
    inside, shown = False, False
    for line in full:
        low = line.lower()
        if 'dialog "scheduled posts"' in low or 'heading "scheduled posts"' in low:
            inside = True
            continue
        if inside:
            mt = re.search(r'StaticText "([^"]+)"', line)
            if mt:
                logger.info("  %s", mt.group(1))
                shown = True
            elif 'dialog "' in low and "scheduled" not in low:
                break
    if not shown:
        logger.info("Scheduled posts dialog opened but no entries were parsed.")
    return 0


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #
def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="linkedin", description=__doc__.strip().splitlines()[0])
    sub = p.add_subparsers(dest="cmd", required=True)

    sp = sub.add_parser("login", help="log in (saves session; --code for 2FA stage 2)")
    sp.add_argument("--code", help="authenticator code for stage 2 of login")
    sp.add_argument("--force", action="store_true", help="re-login even if a session exists")
    sp.add_argument("--wait-push", type=int, default=18, help="seconds to wait for an app-push approval before asking for a code")
    sp.set_defaults(func=cmd_login)

    sp = sub.add_parser("posts", help="fetch recent posts with engagement stats")
    sp.add_argument("-n", "--number", type=int, default=10, help="how many posts (default 10)")
    sp.add_argument("--full", action="store_true", help="print full post text, not just the first line")
    sp.add_argument("--include-reposts", action="store_true", help="include bare reposts (reshares with no commentary of your own)")
    sp.add_argument("--json", action="store_true", help="output JSON")
    sp.set_defaults(func=cmd_posts)

    sp = sub.add_parser("post", help="publish a post now")
    sp.add_argument("text", help="the full post text")
    sp.add_argument("--yes", action="store_true", help="actually publish (otherwise dry run)")
    sp.set_defaults(func=cmd_post)

    sp = sub.add_parser("draft", help="save a post as a draft")
    sp.add_argument("text", help="the full post text")
    sp.set_defaults(func=cmd_draft)

    sp = sub.add_parser("schedule", help="schedule a post for a future date/time")
    sp.add_argument("text", help="the full post text")
    sp.add_argument("--at", required=True, help="target date/time, e.g. '2026-06-02 09:00'")
    sp.add_argument("--yes", action="store_true", help="confirm scheduling (otherwise stops at the review step)")
    sp.set_defaults(func=cmd_schedule)

    sp = sub.add_parser("drafts", help="view saved drafts")
    sp.set_defaults(func=cmd_drafts)

    sp = sub.add_parser("scheduled", help="view scheduled posts")
    sp.set_defaults(func=cmd_scheduled)

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
