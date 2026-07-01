---
name: linkedin
description: Draft, post, and review Dan's LinkedIn posts (handle saattrupdan) via the `linkedin` CLI, which drives the real LinkedIn web UI with agent-browser. Use when the user wants to write/post a LinkedIn post, save or view a draft, or fetch their recent posts with engagement stats. Also use whenever drafting LinkedIn content, to match Dan's voice and formatting.
last-updated: 2026-07-01
---

# linkedin

Manage Dan's LinkedIn presence (profile handle: **`saattrupdan`**) from the
terminal. LinkedIn has **no public API** for drafts, scheduling, or reading your
own posts, so this skill drives the **real LinkedIn web UI** via `agent-browser`,
wrapped in a `linkedin` CLI so the browser steps are deterministic.

## CLI

```bash
linkedin <command> [options]
```

### Prerequisites

```bash
which agent-browser || npm i -g agent-browser && agent-browser install
```

The `linkedin` command is an editable install pointing at
`linkedin_skill/main.py`, so edits to the source take effect immediately. The
CLI shells out to `agent-browser` and runs the browser **headless** — no window
appears. It does send keystrokes to the editor (via `agent-browser type`, which
targets the editor element), but these are in-page key events, never OS-level
chords, so nothing leaks to the OS. Standard library only.

All browser commands use `--session-name linkedin` for persistent cookies/storage
between invocations, so login state is preserved automatically.

### Authentication

Credentials live in the **macOS Keychain** (service `linkedin`), never in a file
and never echoed. Read/set them with:

```bash
security find-generic-password -s linkedin -a username -w      # read
security add-generic-password  -s linkedin -a username -w <email>
security add-generic-password  -s linkedin -a password -w <password>
```

Then:

```bash
linkedin login
```

The login flow (all automated except the one 2FA step):

1. The CLI opens the login page and fills the credentials from Keychain. After a
   logout LinkedIn shows a **"Welcome back" page that remembers the account** and
   asks only for the password — the CLI handles both that and the full
   email+password form (the email field is optional). It clicks the real
   **"Sign in"** button, carefully skipping the "Sign in with Google/Apple" SSO
   buttons.
2. LinkedIn then issues a **verification challenge** — this is the one manual
   step:
   - **App push:** approve it on your phone. `linkedin login` polls for up to
     `--wait-push` seconds (default 60) and completes automatically.
   - **Authenticator code** (LinkedIn often demands this instead of a push): the
     browser daemon stays alive on the code page, so supply the code with:

     ```bash
     linkedin login --code 123456
     ```

On success the session persists and future runs skip login. `linkedin login
--verify` checks the current state; `--force` re-runs even if a session exists
(a still-valid session redirects to the feed and is treated as already logged
in).

> **Session fragility:** rapid/interleaved browser activity (e.g. mixing raw
> `agent-browser` commands with `linkedin` CLI calls, or killing/restarting the
> daemon) can get the session **logged out**, forcing another 2FA round. Prefer
> the CLI commands, and don't restart the daemon mid-task unless it has hung.

## Commands

| Command | What it does | Verified |
| --- | --- | --- |
| `linkedin login [--code N] [--force] [--verify] [--wait-push N]` | Log in / finish 2FA; saves session | ✅ |
| `linkedin posts [-n N] [--full] [--include-reposts] [--json]` | Fetch recent posts with engagement stats (default 10) | ✅ |
| `linkedin post "<text>" [--yes]` | Publish now (dry run unless `--yes`) | ✅ type; publish via `--yes` |
| `linkedin draft "<text>"` | Save the text as a draft (empty composer only) | ✅ |
| `linkedin drafts` | Show the current draft (non-destructive) | ✅ |

> Scheduling is intentionally **not** supported: LinkedIn's schedule dialog
> (date field + calendar + time picker) was too brittle to automate reliably.
> Schedule manually in the browser when needed.

### Fetching posts

```bash
linkedin posts                 # last 10, first line + 👍/💬/🔁 stats + URL
linkedin posts -n 20 --full    # 20 posts, full text
linkedin posts --json          # machine-readable
```

**Reposts:** bare reposts (reshares with no commentary of your own) are
**excluded by default** — per Dan, a repost only counts when he added his own
thoughts. Use `--include-reposts` to include them; reposts-with-commentary are
always included and tagged `[repost +commentary]`.

### Posting / drafting

- `post` is **dry-run by default** — it types the content into the composer and
  shows you what it entered but does nothing irreversible. Add `--yes` to
  actually publish. Always show Dan the composed text and get the OK first.
- Opening the composer **auto-loads the most recent draft**. LinkedIn keeps a
  **single** server-side draft, and the editor cannot be cleared in place (see
  below), so `post`/`draft` **refuse to type over a non-empty composer**.
- **Replacing an existing draft is not automated** — the discard-then-resave
  chain proved too flaky and can lose the draft. To overwrite: open the draft in
  the browser, **Discard** it there, then run `linkedin draft "<new text>"` on
  the now-empty composer. (`linkedin draft` on an empty composer is reliable.)
- **Trailing whitespace:** pass text via `"$(cat file)"` — command substitution
  strips trailing newlines. Reading a file into a variable that keeps a trailing
  `\n` will save a draft with a stray blank line.

## Writing in Dan's voice

When **drafting** any post, match Dan's established style and show him the draft
for approval before publishing.

- **Hook opener**: a question or "Did you know…", often in bold-unicode (e.g.
  𝗗𝗼 𝘆𝗼𝘂…). One short hook line, then a blank line.
- **Voice**: conversational but technical; explains clearly without dumbing
  down. "we" for Alexandra Instituttet research work; "I" for talks/personal
  actions.
- **Structure**: a few labelled sections, each led by a single emoji marker
  (📊 🧭 🔒 🌐 🔍 📈 📴), section title often in bold-unicode, then a sentence
  or two.
- **Emojis**: sparing and purposeful — section markers and the occasional
  reaction (🎉 😬 🤔). Not decorative spam.
- **Links**: trailing CTA lines with the 👉 arrow (`Read more 👉 <link>`).
  Write full URLs — LinkedIn auto-shortens to lnkd.in. **Do not use markdown-style
  links** (`[text](url)` doesn't work in LinkedIn posts) — paste raw URLs instead.
- **Collaborators**: thank coauthors/colleagues by name when relevant.
- **Closing**: a short list of lowercase hashtags, commonly
  `#nlp #evaluation #llm #opensource #machinelearning #research`.
- Posts in **English** even when the underlying material is Danish.
- **Audience** mostly already knows what LLM evals are — lead with what's
  new/novel, don't justify why evaluation matters. Recurring topic: EuroEval,
  multilingual LLM evaluation, hallucination/bias/values benchmarks.

## Post length & engagement

LinkedIn allows up to 3,000 characters. Engagement patterns by length:

| Length | Engagement Pattern |
| --- | --- |
| < 500 chars | Lower engagement |
| 500–1,000 chars | Moderate engagement |
| 1,000–1,500 chars | Good engagement |
| 1,800–2,100 chars | Highest engagement |
| 2,100–3,000 chars | Strong for deep content |

Aim for 1,800–2,100 characters for optimal engagement, or 2,100–3,000 for
technical deep-dives.

(This mirrors the `linkedin-post-style` memory; keep the two in sync.)

## How it works / robustness notes

The composer is a **Lexical contenteditable inside an iframe**, which drives most
of the gotchas below. The CLI reads the page with `agent-browser snapshot -i`
(pierces frames) and acts via ref-based clicks; page-level `eval`/`keyboard`
don't reach into the iframe. These behaviours were established the hard way — do
not "simplify" them away:

- **Enter text with `type`, not `fill`.** `agent-browser fill` only mutates the
  DOM: it does **not** reliably flip Lexical's "dirty" flag (so the save prompt
  never appears) and can drop the caret mid-text, misplacing characters. `type`
  fires real per-char key events on the editor element and preserves order.
  `type_into_editor` uses `type`; keep it that way.
- **The "Save this post as a draft?" prompt only appears when the composer has
  unsaved changes**, and is triggered by pressing **Escape** on the focused
  editor. Do **not** click the composer's "Dismiss"/X control — LinkedIn's a11y
  tree exposes **hidden decoy "Dismiss" buttons** that ref-clicks silently
  no-op on.
- **Never take a snapshot between entering text and pressing Escape** — it loses
  the trigger. That's why `cmd_draft`/`cmd_post` log the *input* text rather than
  reading the editor back before closing.
- Choosing **Discard** in that prompt **deletes the single draft entirely** (it
  doesn't just revert changes).
- Elements are matched by **accessible role + name** with multiple candidates
  (English + Danish) and exact-vs-contains rules, so small LinkedIn relabels
  usually don't break it. If LinkedIn renames a control, add a candidate to the
  `*_NAMES`/`BTN_*` tuples near the top of `linkedin_skill/main.py`.
- **"Start a post"** is rendered as a **link** in the current layout (previously
  a button); `open_composer` accepts either role and polls for it, since the
  heavy feed takes a few seconds to render.
- Composer helpers poll and retry (open, save/discard, draft auto-load) because
  the live UI is slow and occasionally flaky. Sustained snapshots on the heavy
  feed can **hang the agent-browser daemon** — the polling keeps snapshot volume
  modest; if the daemon hangs, killing it usually also logs the session out.
- If a command reports a session problem, re-run `linkedin login`.
