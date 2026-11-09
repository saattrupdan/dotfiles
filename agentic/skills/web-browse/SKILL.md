---
name: web-browse
description: >-
  Native Firefox browser automation through Pi's web_browse tool. Use for interactive
  websites, JavaScript-heavy pages, form filling, clicking, headed/headless browsing,
  login flows, and Bitwarden-assisted sign-in. Prefer this over agent-browser for
  normal web automation. The Firefox tool uses a dedicated persistent profile and
  supports human handoff without sending passwords through Pi.
last-updated: 2026-10-01
---

# Firefox web browsing

Pi's `web_browse` tool drives native Firefox through Selenium/geckodriver. The first
session uses a persistent, dedicated profile; simultaneous agents get isolated profiles
seeded with saved login state from a stopped primary browser. Start with `help` if the
exact command surface is unclear.

For static pages, use `read` instead. It is faster and returns cleaner Markdown.

## Common flow

```text
web_browse({ command: "open https://example.com" })
web_browse({ command: "snapshot" })
web_browse({ command: "click @e1" })
web_browse({ command: "fill @e2 search terms" })
web_browse({ command: "press @e2 Enter" })
web_browse({ command: "close" })
```

`open` starts headless Firefox automatically. Element refs come from the latest snapshot
and may become stale after navigation or clicking; take another snapshot when needed.
Quote text containing spaces when exact argument boundaries matter.

## Commands

| Command | Purpose |
|---|---|
| `help` | Show the supported command surface |
| `start [--headed\|--headless]` | Start Firefox; headless is the default |
| `status` / `close` | Inspect or stop the current session |
| `open <https-url>` | Navigate and return a semantic snapshot |
| `snapshot` | Return page text and interactive `@eN` refs |
| `click @eN` | Click an element and return a fresh snapshot |
| `fill @eN <text>` | Clear and fill a non-secret field |
| `type @eN <text>` | Type into a non-secret field without clearing |
| `press [@eN] <key>` | Send a named key such as Enter, Tab, or Escape |
| `select @eN <option>` | Select by visible text or value |
| `check @eN` / `uncheck @eN` | Change checkbox/radio state |
| `back` / `forward` / `reload` | Navigate and return a fresh snapshot |
| `wait <milliseconds>` | Wait, then return a fresh snapshot |
| `handoff [<url>]` | Open normal Firefox for sign-in, then resume the same profile |

## Normal Firefox sign-in

1. Open the destination with `open <url>`; existing logins use the saved profile.
2. When sign-in is needed, run `handoff <url>`, using the destination app's URL rather
   than an expired Google error or callback URL. Automation closes and normal Firefox
   opens with the same profile, without a WebDriver connection. Handoff defaults to a
   ten-minute timeout and works from headed or headless automation.
3. Sign in manually, including submitting the form and completing verification. Unlock
   Bitwarden and trigger autofill in that window. On first use, install Bitwarden there
   manually. Never give Pi the master password, PIN, recovery key, or sign-in password.
4. Quit that Firefox instance (**Cmd+Q** on Mac, not just closing its window), then
   confirm the handoff in Pi. Automation resumes in its original mode with the saved
   login and returns to the destination URL.
5. Run `snapshot` to continue.

Google rejects sign-in in automated Firefox even when the window is visible. Use the
normal-browser handoff rather than retrying in `start --headed`.

The profile stays reserved during handoff. Canceling or timing out leaves the normal
window untouched; quit it and run `handoff` again to resume, or `close` to stop. Pi does
not terminate a normal sign-in window. If Pi shuts down or reloads, Firefox's native
lock protects that window until you quit it. Concurrent Pi sessions use their own
profile clones; a login in a clone does not update the primary profile.

The tool deliberately refuses to fill credential fields and does not expose password
values, cookies, browser storage, arbitrary JavaScript, network bodies, or screenshots.
This reduces accidental disclosure; it is not a cryptographic security boundary. A
browser agent with unrestricted OS or raw WebDriver access could still observe or
exfiltrate a filled credential.

## Browser mode

Headless mode is the default for both `start` and `open`. The same persistent profile
is used, so authenticated cookies and an unlocked Bitwarden vault can remain available.
Use `start --headed` for visible automation and `handoff` for human sign-in in normal
Firefox. Close automation before switching between headed and headless modes.

## Profile and environment

The default profile is outside the dotfiles repository:

- macOS: `~/Library/Application Support/Pi/firefox-profile`
- other systems: `$XDG_DATA_HOME/pi/firefox-profile` or
  `~/.local/share/pi/firefox-profile`

Overrides:

- `PI_FIREFOX_PROFILE` — dedicated profile path
- `PI_FIREFOX_BIN` — Firefox executable
- `PI_GECKODRIVER_BIN` — geckodriver executable

Only one process controls each profile. When another Pi agent is browsing, a new agent
uses a private clone of a **quiescent** seed, not the live Firefox profile. The seed is
refreshed before the primary starts and after it closes; secondary profiles are removed
on normal session shutdown. Persistent cookies, saved logins and Bitwarden data may be
copied, but session-only cookies and locked vault state may not survive cloning. These
private directories contain sensitive login material: do not share or back them up.
Logging out in one browser does not log out already-running clones; a crashed agent can
also leave a private profile behind under `<primary>.pi-agents/`. Close those browsers
and remove abandoned clones if necessary. If the primary is already open and no seed
exists yet, close it once and retry. A Pi
process may automatically close a *verified orphaned* Firefox holding its profile;
active or uncertain owners are left alone. Unsaved tabs in an orphan can be lost.
The tool never deletes Firefox's native profile lock. Selenium Manager locates/downloads
geckodriver when possible; on macOS, `brew install geckodriver` is the manual fallback.

## Limits

- Only absolute HTTP(S) URLs and `about:blank` are accepted.
- There is no arbitrary script evaluation, cookie/storage access, network interception,
  screenshot capture, browser-chrome automation, or extension-popup automation.
- Bitwarden UI actions are manual and require headed mode.
- Closing the Firefox window manually may require `close` before restarting the session.
