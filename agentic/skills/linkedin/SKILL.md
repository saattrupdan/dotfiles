---
name: linkedin
description: Draft, post, schedule, and review Dan's LinkedIn posts (handle saattrupdan). Drives the real LinkedIn web UI via agent-browser. Use when the user wants to write/post/schedule a LinkedIn post, save or view a draft, list scheduled posts, or fetch their recent posts and engagement stats. Also use whenever drafting LinkedIn content, to match Dan's voice and formatting.
last-updated: 2026-05-30
allowed-tools: Bash(agent-browser:*), Bash(npx agent-browser:*)
---

# linkedin

Manage Dan's LinkedIn presence (profile handle: **`saattrupdan`**) from the
terminal: write posts in his voice, publish or schedule them, save and view
drafts, list scheduled posts, and fetch recent posts with engagement stats.

LinkedIn has **no public API** for drafts, scheduling, or reading your own
posts, so this skill works by driving the **real LinkedIn web UI** through the
`agent-browser` skill. Everything is point-and-click against the live site.

## Prerequisites

1. **agent-browser** must be installed and you must load its core workflow
   first — it is the engine for every operation here:

   ```bash
   which agent-browser || npm i -g agent-browser && agent-browser install
   agent-browser skills get core      # READ THIS before any agent-browser command
   ```

   Key idea: `agent-browser snapshot -i` to see interactive elements with
   `@eN` refs, act on a ref (`click`/`fill`), then **re-snapshot** because refs
   go stale the moment the page changes. Prefer `find role/text` locators when
   a ref is ambiguous. UI labels below are guides — always confirm against a
   fresh snapshot, since LinkedIn changes its DOM often.

2. **A logged-in session.** LinkedIn requires auth. Reuse a persisted state so
   you are not logging in every time:

   ```bash
   # First time only: open, let the user log in, then save the session.
   agent-browser open https://www.linkedin.com/login
   # → ask the user to complete login + any 2FA in the browser window
   agent-browser wait --url "**/feed/**"
   agent-browser state save ~/.linkedin-session.json

   # Subsequent runs: restore before navigating.
   agent-browser state load ~/.linkedin-session.json
   agent-browser open https://www.linkedin.com/feed/
   ```

   If a navigation lands on `/login` or `/checkpoint`, the session expired —
   ask the user to log in again and re-save the state. Never type the user's
   password into a command; let them enter it in the browser.

---

## Writing in Dan's voice

When **drafting** any post (before posting/scheduling), match Dan's established
style. Show him the draft text for approval before publishing.

- **Hook opener**: start with a question or "Did you know…", often in
  bold-unicode characters (e.g. 𝗗𝗼 𝘆𝗼𝘂…). One short hook line, then a blank line.
- **Voice**: conversational but technical; explains concepts clearly without
  dumbing them down. First-person plural "we" for Alexandra Instituttet
  research work; "I" for talks/personal actions.
- **Structure**: a few labelled sections, each led by a single emoji as a
  bullet marker (📊 🧭 🔒 🌐 🔍 📈 📴), section title often in bold-unicode,
  then a sentence or two.
- **Emojis**: sparing and purposeful — section markers and the occasional
  reaction (🎉 😬 🤔). Not decorative spam.
- **Links**: trailing call-to-action lines with the 👉 arrow, e.g.
  `Read more 👉 <link>`, `Slides 👉 <link>`. Write full URLs — LinkedIn
  auto-shortens to lnkd.in, so do not shorten manually.
- **Collaborators**: thank coauthors/colleagues by name when relevant.
- **Closing**: a short list of lowercase hashtags, commonly
  `#nlp #evaluation #llm #opensource #machinelearning #research`.
- Posts in **English** even when underlying material (slides/papers) is Danish.
- **Audience** mostly already knows what LLM evals are — don't justify why
  evaluation matters or explain basics; lead with what's new/novel. Recurring
  topic: EuroEval, multilingual LLM evaluation, hallucination/bias/values
  benchmarks.

(This mirrors the `linkedin-post-style` memory; keep the two in sync.)

### Pasting text into the composer

LinkedIn's composer is a `contenteditable` box, not a normal `<input>`. Bold-
unicode characters, emoji, and newlines all paste fine via `fill`/`type`, but:

- Type the **whole post in one `fill`** so newlines land as soft breaks.
- After typing, **snapshot and read the box back** (`get text @ref`) to confirm
  the content and that no `@mention`/`#hashtag` autocomplete popup ate a line.
- If a mention/emoji autocomplete dropdown appears, press `Escape` before
  continuing.

---

## Operations

All flows start from the feed composer unless noted. Open it with:

```bash
agent-browser open https://www.linkedin.com/feed/
agent-browser snapshot -i
agent-browser find text "Start a post" click     # opens the share modal
agent-browser snapshot -i                          # composer modal is now open
```

The composer modal has a `contenteditable` body, and a bottom bar whose
right side holds (left→right): a **clock / Schedule** icon, then the primary
**Post** button. Save these landmarks from the snapshot.

### 1. Post now

```bash
# (composer open, content not yet typed)
agent-browser find role textbox fill "<the full post text>"
agent-browser snapshot -i
agent-browser get text "<composer body ref>"     # verify content
agent-browser find role button click --name "Post"
agent-browser wait --text "Post successful"        # or re-snapshot to confirm modal closed
```

Confirm success by re-snapshotting (the modal closes) or by checking the feed
shows the new post at top.

### 2. Create / save a draft

LinkedIn auto-saves composer content as a draft when you close the modal with
text present.

```bash
# (composer open, text typed and verified)
agent-browser find role button click --name "Close"   # the X on the modal
agent-browser snapshot -i
# A "Save this post as a draft?" dialog appears:
agent-browser find text "Save as draft" click
```

The post is now stored in **Drafts** (see #4 to view it).

### 3. Schedule a post

```bash
# (composer open, text typed and verified)
agent-browser find role button click --name "Schedule"   # the clock icon; confirm via snapshot
agent-browser snapshot -i                                  # schedule dialog opens
# Set the date and time fields (read their refs from the snapshot):
agent-browser find role textbox fill "<MM/DD/YYYY>"        # date field
# pick the time from its dropdown/field:
agent-browser snapshot -i
agent-browser find role button click --name "Next"
agent-browser snapshot -i
# Back in the composer the primary button now reads "Schedule":
agent-browser find role button click --name "Schedule"
agent-browser wait --text "scheduled"
```

Notes:
- LinkedIn requires the scheduled time to be **at least ~1 hour in the future**
  and on the hour/half-hour increments offered by the time picker. If the user
  gives a relative time ("tomorrow 9am"), compute the absolute date/time first
  (today is in the environment context) and confirm the timezone shown in the
  dialog.
- Always read back the confirmed date/time from the dialog and report it.

### 4. View the current draft(s)

```bash
agent-browser open https://www.linkedin.com/feed/
agent-browser find text "Start a post" click
agent-browser snapshot -i
# In the composer, find the drafts entry point (a link like "Drafts" or
# "N drafts" — usually near the composer header/footer):
agent-browser find text "draft" click
agent-browser snapshot
agent-browser get text "<drafts list ref>"     # read draft titles/snippets
```

Report each draft's text. To resume one, click it to load it back into the
composer, then post/schedule as above.

### 5. View scheduled posts

```bash
agent-browser open https://www.linkedin.com/feed/
agent-browser find text "Start a post" click
agent-browser find role button click --name "Schedule"   # clock icon
agent-browser snapshot -i
agent-browser find text "View all scheduled posts" click
agent-browser wait --load networkidle
agent-browser snapshot
agent-browser get text "<scheduled list container ref>"
```

For each scheduled post, report its **scheduled date/time** and the post text.
Scheduled posts can be edited or deleted from this list (look for a "…" / edit
menu per item).

### 6. Fetch recent posts with stats

Default: the **10 most recent** posts, returning **post text + engagement
stats (reactions, comments, reposts) + the post URL**. Override the count if
the user asks ("last 5", "last 20", etc.).

```bash
agent-browser open https://www.linkedin.com/in/saattrupdan/recent-activity/all/
agent-browser wait --load networkidle
agent-browser snapshot -i
# Filter to posts only if a filter pill is present:
agent-browser find text "Posts" click
agent-browser wait --load networkidle
```

The activity feed lazy-loads. Scroll to materialise enough posts for N, then
read them:

```bash
# Repeat until at least N post cards are present:
agent-browser scroll down 1500
agent-browser wait 800
agent-browser snapshot -c          # compact; count the post cards
# Then extract text + social counts per card:
agent-browser get text "<post card ref>"
```

Each card exposes the post body and a social-counts row (e.g.
"123 reactions · 4 comments · 2 reposts"). Capture the permalink via the
card's "…" menu → "Copy link to post", or from the timestamp link's `href`
(`snapshot -i -u` shows hrefs). Return a tidy list:

```
1. <first line of post…>   — 123 reactions · 4 comments · 2 reposts   <url>
2. ...
```

If a card is a **repost/share** of someone else's content (no original text),
note it as such rather than reporting empty text.

---

## Gotchas

- **Stale refs**: re-snapshot after every click that opens a dialog, navigates,
  or re-renders. Most failures here are stale-ref failures, not wrong selectors.
- **`wait N` is milliseconds**, not seconds (`wait 800` = 0.8 s).
- **Composer is `contenteditable`** — verify content with `get text` after
  typing; dismiss autocomplete popups with `Escape`.
- **Modals vs. pages**: drafts and scheduled-posts views are modals layered
  over the feed; closing them returns to the feed, not back-navigation.
- **Session expiry**: landing on `/login` or `/checkpoint` means re-auth.
- **Always show drafts/scheduled content to the user before publishing**, and
  report back the exact scheduled time and the live URL after posting.
