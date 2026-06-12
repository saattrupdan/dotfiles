---
name: linkedin
description: Draft, post, and review Dan's LinkedIn posts (handle saattrupdan) via the `linkedin` CLI, which drives the real LinkedIn web UI with agent-browser. Use when the user wants to write/post a LinkedIn post, save or view a draft, or fetch their recent posts with engagement stats. Also use whenever drafting LinkedIn content, to match Dan's voice and formatting.
last-updated: 2026-05-30
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

The `linkedin` command is a wrapper that runs from source (via `uv run --directory`)
so you always have the latest version without reinstalling. The CLI shells out to
`agent-browser` and runs the browser **headless** — no window appears and synthetic
keystrokes never reach the OS. Standard library only.

All browser commands use `--session-name linkedin` for persistent cookies/storage
between invocations, so login state is preserved automatically.

### Authentication (one-time)

Credentials live in `~/.env` (dotenv format), read literally — never echoed:

```
LINKEDIN_USER=you@example.com
LINKEDIN_PASS=your-password
```

Then:

```bash
linkedin login
```

- The CLI uses `agent-browser --session-name linkedin` for all commands, so
  cookies and localStorage persist automatically between invocations.
- Otherwise the CLI submits the credentials. LinkedIn usually then issues a
  **verification challenge**. If it sends an app push, approve it on your phone.
  If it asks for an authenticator code (or no push arrives), run stage 2:

  ```bash
  linkedin login --code 123456
  ```

  The browser daemon stays alive between the two calls, so it is sitting on the
  code page ready for the code. On success the session persists and future runs
  skip login entirely.

## Commands

| Command | What it does | Verified |
| --- | --- | --- |
| `linkedin login [--code N] [--force]` | Log in / finish 2FA; saves session | ✅ |
| `linkedin posts [-n N] [--full] [--include-reposts] [--json]` | Fetch recent posts with engagement stats (default 10) | ✅ |
| `linkedin post "<text>" [--yes]` | Publish now (dry run unless `--yes`) | ✅ fill; publish via `--yes` |
| `linkedin draft "<text>"` | Save the text as a draft | ✅ |
| `linkedin drafts` | Show the current draft | ✅ |

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

- `post` is **dry-run by default** — it fills the composer and shows you the
  content but does nothing irreversible. Add `--yes` to actually publish.
  Always show Dan the composed text and get the OK first.
- Opening the composer **auto-loads the most recent draft**. To avoid mangling
  an existing draft, `post`/`draft` refuse to type over a non-empty composer —
  review it with `linkedin drafts` and discard it in the browser first if
  needed.

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

- The composer renders inside the `linkedin.com/preload/` **iframe**, so the CLI
  drives it via `agent-browser snapshot` (which pierces frames) and ref-based
  clicks, not page `eval`.
- Elements are matched by **accessible role + name** with multiple candidates
  (English + Danish) and exact-vs-contains rules — so small LinkedIn relabels
  usually don't break it. If LinkedIn renames a control, add a candidate to the
  `*_NAMES`/`BTN_*` tuples near the top of `linkedin_skill/main.py` rather than
  changing command logic.
- The close button is named **"Dismiss"**; closing a loaded draft and choosing
  **Discard** deletes it.
- **Draft saving limitation**: The save/discard dialog appears reliably for short
  posts (< 750 chars) but may not appear for longer posts when using the CLI. For
  posts in the optimal engagement range (1,800–3,000 chars), save drafts manually
  in the browser if the CLI fails.
- If a command reports a session problem, re-run `linkedin login`.
