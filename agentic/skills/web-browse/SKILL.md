---
name: web-browse
description: >-
  Native Firefox browser automation through Pi's web_browse tool. Use for interactive
  websites, JavaScript-heavy pages, form filling, clicking, headed/headless browsing,
  login flows, and Bitwarden-assisted sign-in. Prefer this over agent-browser for
  normal web automation. The Firefox tool uses a dedicated persistent profile and
  supports human handoff without sending passwords through Pi.
last-updated: 2026-09-28
---

# Firefox web browsing

Pi's `web_browse` tool drives native Firefox through Selenium/geckodriver. It keeps one
persistent, dedicated profile across tool calls and Pi sessions. Start with `help` if
the exact command surface is unclear.

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

`open` starts headed Firefox automatically. Element refs come from the latest snapshot
and may become stale after navigation or clicking; take another snapshot when needed.
Quote text containing spaces when exact argument boundaries matter.

## Commands

| Command | Purpose |
|---|---|
| `help` | Show the supported command surface |
| `start [--headed\|--headless]` | Start Firefox; headed is the default |
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
| `handoff` | Pause headed automation for manual login/autofill |

## Bitwarden login flow

1. Start headed Firefox with `start --headed`.
2. On first use, manually install Bitwarden in that dedicated Firefox profile and sign
   in from the Firefox window. Never give Pi the master password, PIN, or recovery key.
3. Navigate to the login page.
4. Run `handoff`. While Pi waits, unlock Bitwarden and trigger autofill in Firefox.
5. Confirm the handoff in Pi, then run `snapshot` and continue with a submit button or
   another non-secret action.

The tool deliberately refuses to fill credential fields and does not expose password
values, cookies, browser storage, arbitrary JavaScript, network bodies, or screenshots.
This reduces accidental disclosure; it is not a cryptographic security boundary. A
browser agent with unrestricted OS or raw WebDriver access could still observe or
exfiltrate a filled credential.

## Headless mode

Use `start --headless` only when no human interaction is needed. The same persistent
profile is used, so authenticated cookies can remain available, but a locked Bitwarden
vault cannot be interactively unlocked headlessly. Close Firefox before switching
between headed and headless modes.

## Profile and environment

The default profile is outside the dotfiles repository:

- macOS: `~/Library/Application Support/Pi/firefox-profile`
- other systems: `$XDG_DATA_HOME/pi/firefox-profile` or
  `~/.local/share/pi/firefox-profile`

Overrides:

- `PI_FIREFOX_PROFILE` — dedicated profile path
- `PI_FIREFOX_BIN` — Firefox executable
- `PI_GECKODRIVER_BIN` — geckodriver executable

Only one Pi process may control the profile. The tool never removes Firefox's native
profile lock. Selenium Manager locates/downloads geckodriver when possible; on macOS,
`brew install geckodriver` is the manual fallback.

## Limits

- Only absolute HTTP(S) URLs and `about:blank` are accepted.
- There is no arbitrary script evaluation, cookie/storage access, network interception,
  screenshot capture, browser-chrome automation, or extension-popup automation.
- Bitwarden UI actions are manual and require headed mode.
- Closing the Firefox window manually may require `close` before restarting the session.
