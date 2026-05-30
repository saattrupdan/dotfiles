---
name: media-dk
description: Danish broadcast media via the `media` CLI — latest news headlines and keyword content search across dr.dk (DR) and tv2.dk (TV 2). Merges the dr-dk and tv2-dk skills. Use to fetch the latest Danish news or find recent coverage of a topic across both broadcasters.
last-updated: 2026-05-30
allowed-tools: Bash(media:*)
---

# media-dk

One CLI for Denmark's two big broadcasters — **DR** (public service, dr.dk) and
**TV 2** (commercial, tv2.dk). It reads their anonymous content feeds: DR via the
`__NEXT_DATA__` JSON embedded in its news pages, TV 2 via the internal `decks`
API.

All content is free and anonymous (DRTV/TV 2 Play video is geo-blocked and out
of scope here).

## CLI

```bash
media <command> [options]
```

### Prerequisites

```bash
which media || pipx install -e <path-to-this-skill>   # install the CLI
```

Standard library only. Every command takes `--json` for structured output.

## Commands

| Command | What it does |
| --- | --- |
| `media news [--source dr\|tv2\|all] [--section S] [-n N]` | Latest news headlines |
| `media search TERM… [--source …] [--match any\|all] [-n N]` | Keyword search over recent content |

### News

```bash
media news                          # latest from both DR and TV 2
media news --source dr -n 15        # just DR
media news --source dr --section indland     # a specific DR section
```

DR sections: `indland`, `udland`, `politik`, `penge`, `seneste`, `vejret`, …
(the slug after `/nyheder/`).

### Search

```bash
media search regering               # any source, headlines containing "regering"
media search klima energi --match all        # both words
media search valg --source dr -n 30
```

**Important:** neither broadcaster exposes a clean public search API (DR's
`/soeg` is HTML-only and robots-blocked; TV 2 has none). `search` is therefore a
**keyword filter over the broadcasters' current/recent feeds** — it sweeps the
live news sections and matches headlines. It finds live and recent items, **not
the full archive**. The result header shows how many recent items were swept.

## What this replaces

Supersedes the separate `dr-dk` and `tv2-dk` skills:

- **DR** news from `dr.dk/nyheder*` `__NEXT_DATA__` → `news`/`search --source dr`
- **TV 2** teasers from `decks.services.tv2.dk` → `news`/`search --source tv2`

For deeper, source-specific work the original reference still applies:
- DR DRTV streaming, radio (DR LYD), liveblogs, image API → see dr.dk directly.
- TV 2 sports/weather subdomains, Brightcove video, Play → see tv2.dk directly.

## How it works / robustness notes

- **DR** pages embed `<script id="__NEXT_DATA__">`. The CLI handles both layouts:
  the news front page (`viewProps.site.publications[].content`) and topical
  section pages (`viewProps.siteFrontPage.newsFlow.articles[]`). The plain
  home page (`dr.dk/`) has no `__NEXT_DATA__` — `/nyheder` is the entry point.
- **TV 2** decks return an HTML fragment wrapped in JSON (`body`), with teasers
  as `<article class="tc_teaser">`. A browser `User-Agent` is required (else
  403). Some cross-promo teasers are evergreen, so an occasional older item may
  appear.
- News sweeps hit several pages; a single failing section logs a warning to
  stderr and is skipped rather than aborting the command.

## Limits

- No full-text archive search (no public search API on either site).
- No DRTV / TV 2 Play video URLs (geo-blocked, undocumented, out of scope).
- Undocumented internal feeds — structure can change without notice.
