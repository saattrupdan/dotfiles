---
name: citizen-dk
description: Search Danish citizen / public-service portals via the `citizen` CLI — Q&A search across borger.dk (national), nyidanmark.dk (immigration) and frederiksberg.dk (municipal), plus factual pages for any of the 98 municipalities (kommune.dk). Merges borger-dk, frederiksberg-dk, kk-dk, kommune-dk and nyidanmark-dk. Use to find official Danish citizen-service info.
last-updated: 2026-05-30
allowed-tools: Bash(citizen:*)
---

# citizen-dk

A slim CLI over Denmark's official citizen and public-service portals. It
queries their internal JSON search APIs so you can find the right
citizen-service topic/article quickly, plus pull factual pages on any of the 98
municipalities.

All data is anonymous and free (no MitID needed for the public Q&A surface).

## CLI

```bash
citizen <command> [options]
```

### Prerequisites

```bash
which citizen || pipx install -e <path-to-this-skill>   # install the CLI
```

Standard library only. Every command takes `--json` for the raw upstream JSON
and exits non-zero on HTTP/API errors.

## Commands

| Command | What it does |
| --- | --- |
| `citizen search QUERY [--source borger\|nyidanmark\|frederiksberg\|all] [-n N]` | Search a portal's Q&A surface |
| `citizen municipality NAME [--section S] [--chars N]` | Factual page for one of the 98 municipalities (kommune.dk) |

### Search

```bash
citizen search "pas"                          # borger.dk (default) topic suggestions
citizen search "arbejdstilladelse" --source nyidanmark   # full results + links
citizen search "flytning" --source frederiksberg
citizen search "flytning" --source all        # fan out to all three
```

Source characteristics:

- **borger** (default) — `borger.dk`, the national portal. Returns **autocomplete
  suggestions** (the topics people search for); there is no public full-results
  API, so use the suggestions to find the exact topic, then read it on borger.dk.
- **nyidanmark** — `nyidanmark.dk`, the immigration portal. Returns **full
  results with titles and links** (the richest source).
- **frederiksberg** — `frederiksberg.dk`, Frederiksberg Kommune. Returns
  **typeahead suggestions**.

### Municipality facts

```bash
citizen municipality "København"
citizen municipality "Aarhus" --section borgerservice
citizen municipality "Hørsholm" --json
```

Pulls the kommune.dk page for the municipality (WordPress REST API) and prints
readable text. Names are transliterated to the site's slug convention
(`æ→ae`, `ø→oe`, `å→a`). Pages have sections like `overblik`, `borgerservice`,
`boligmarkedet`, `skoler`, `kulturliv`, `erhvervsliv` — jump to one with
`--section`.

## What this replaces

Supersedes the separate `borger-dk`, `nyidanmark-dk`, `frederiksberg-dk`,
`kommune-dk`, and `kk-dk` skills:

- **borger.dk** `/api/search` → `search --source borger`
- **nyidanmark.dk** `/api/search/getsearchresults` → `search --source nyidanmark`
- **frederiksberg.dk** `/api/search/GetTypeAhead` → `search --source frederiksberg`
- **kommune.dk** WordPress REST API → `municipality`
- **kk.dk** (City of Copenhagen) has **no JSON search API** — its `/soeg?k=`
  results are JS-rendered. Browse `https://www.kk.dk/soeg?k=<query>` directly, or
  use `agent-browser` if you need to script it.

## How it works / robustness notes

- **borger.dk** `/api/search` is a POST needing the Sitecore `portalId`
  (`ecfef56c-98e7-42f9-9e22-37d9268009ad`). If borger.dk re-keys it, refresh the
  `data-portal-id` from the home-page HTML and update `BORGER_PORTAL_ID` in
  `citizen_dk/main.py`.
- **frederiksberg.dk** search needs a `pageId` (`15719`, the site-wide search
  page); update `FBG_SEARCH_PAGE_ID` if it changes.
- All endpoints are undocumented internal APIs and can change without notice.

## Limits

- No MitID / personal dashboards (Mit Overblik, Digital Post, Min Side).
- borger and frederiksberg expose **suggestions only**, not full article bodies.
- kk.dk search is not scriptable without a browser.
