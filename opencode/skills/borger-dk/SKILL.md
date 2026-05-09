---
name: borger-dk
description: borger.dk — the official Danish citizen portal. Covers 17 life-domain sections, article pages, life-event guides, Mit Overblik dashboard, Digital Post, English mirror, sitemap enumeration, and the internal search-autocomplete API. Use for navigating borger.dk or calling its search API programmatically.
last-updated: 2026-05-07
---

# borger.dk — Danish citizen portal

Official entrypoint to Danish public-sector information and self-service. Run by the Danish Agency for Digital Government (Digitaliseringsstyrelsen) on Sitecore CMS. Anonymous browsing is fully open; personalised pages require **MitID** login. Language: Danish — respond in Danish unless the user has signalled otherwise.

Base URL: `https://www.borger.dk/`. URL slugs use Danish letters spelled out (`æ`→`ae`, `ø`→`oe`, `å`→`aa`).

## Top-level life-domain sections

The front page is a 17-tile grid. Children follow `/<section>/<topic>/<article>`.

| Section | URL |
|---|---|
| Familie og børn | `/familie-og-boern` |
| Skole og uddannelse | `/skole-og-uddannelse` |
| Sundhed og sygdom | `/sundhed-og-sygdom` |
| Internet og sikkerhed | `/internet-og-sikkerhed` |
| Pension og efterløn | `/pension-og-efterloen` |
| Handicap | `/handicap` |
| Arbejde, dagpenge, ferie | `/arbejde-dagpenge-ferie` |
| Økonomi, skat, SU | `/oekonomi-skat-su` |
| Ældre | `/aeldre` |
| Bolig og flytning | `/bolig-og-flytning` |
| Miljø og energi | `/miljoe-og-energi` |
| Transport, trafik, rejser | `/transport-trafik-rejser` |
| Danskere i udlandet | `/danskere-i-udlandet` |
| Udlændinge i Danmark | `/udlaendinge-i-danmark` |
| Samfund og rettigheder | `/samfund-og-rettigheder` |
| Politi, retsvæsen, forsvar | `/politi-retsvaesen-forsvar` |
| Kultur og fritid | `/kultur-og-fritid` |

## Article page anatomy

A typical article (`/<section>/<topic>/<article>`) has:

- **Body copy** — Danish prose, often split by *"Vælg din situation"* tabs that hide/show subsections in-page.
- **Genveje til selvbetjening** — primary CTAs routing through `/Handlingsside?selfserviceId=<GUID>`. Always link the Handlingsside URL, not the eventual backend.
- **Næste skridt / Spørg din kommune** — secondary actions, often kommune-specific.
- **Kommune chooser** (some pages) — `<select id="MunicipalityList">`. Standalone selector at `/vaelg-kommune` (excluded from `robots.txt`).
- **Læs op** — text-to-speech via ReadSpeaker; no extra URL.
- **Last-modified date** in the byline; matches sitemap `<lastmod>`.

## Life-event guides — "Livssituationer"

Curated multi-step guides for major transitions (parental leave, moving, retirement, bereavement). A filter-widget uses radio/dropdown questions; answers persist as URL query params (`?<question>=<answer>`) for deep-linking.

## Self-service entry points

| Pattern | Behaviour |
|---|---|
| `/Handlingsside?selfserviceId=<GUID>` | Universal launcher for a self-service flow. Resolves to the correct backend per user. |
| `/Soeg?k=<query>` | HTML search results (**disallowed** in `robots.txt`). Autocomplete is `POST /api/search` — see below. |
| `/vaelg-kommune` | Standalone kommune selector. |
| `/om-borger-dk/Find-en-myndighed` | Kommune / authority lookup with contact info. |

## Mit Overblik dashboard

Root: `/mitoverblik`. Login: `/mitoverblik?allowLogin=1` → MitID. Aggregates data from Udbetaling Danmark, Skat, kommunes, Statens Administration, etc. The whole `/Min-Side/` URL family is excluded from `robots.txt`.

| URL | Content |
|---|---|
| `/mitoverblik` | Landing page — outstanding cases, deadlines, recent payments. |
| `/mitoverblik/sager` | Active cases with public authorities. |
| `/mitoverblik/oekonomiske-ydelser` | Benefit payments — SU, kontanthjælp, sygedagpenge. |
| `/mitoverblik/betalinger` | Outgoing payments and debt. |
| `/mitoverblik/indkomst-og-skat` | Salary, annual settlement, tax rate. |
| `/mitoverblik/serviceydelser-og-hjaelpemidler` | Service grants and aids. |
| `/mitoverblik/beviser` | Issued documents / digital credentials. |
| `/mitoverblik/aftaler-og-frister` | Upcoming agreements and deadlines. |
| `/mitoverblik/mine-data` | Master record — name, address, contact, civil status. |

No public API to read these data — they are session-bound to a live MitID login.

## Digital Post — `https://post.borger.dk`

Separate portal for receiving and sending statutory mail. Login = MitID. Replaces e-Boks for public communication.

## English mirror — `https://lifeindenmark.borger.dk`

`https://lifeindenmark.dk` 301-redirects here. Subset of borger.dk content for non-Danish speakers. Twelve top-level sections plus theme pages under `/theme/<slug>` (`before-moving`, `when-you-arrive`, `if-leaving`). Use when the user wants an English-language version of a borger.dk topic.

## About / legal / help

| URL | Content |
|---|---|
| `/Om-borger-dk` | About-the-site root. |
| `/Om-borger-dk/Jura-cookies-og-tilgaengelighed/beskyttelse-af-personoplysninger` | Privacy / GDPR. |
| `…/beskyttelse-af-personoplysninger/Cookies` | Cookie policy. |
| `…/Rettigheder` | User rights. |
| `…/webtilgaenkelighed-til-borger-dk` / `/was` | Accessibility statement. |
| `/hjaelp-og-vejledning` | Help root. |
| `/hjaelp-og-vejledning/kontakt` | Contact options. |

Legal slugs alternate between `Jura-cookies-og-tilgaengelighed` (correct) and `Jura-cookies-og-tilgaenkelighed` (typo) — both resolve.

## Sitemap & enumeration

- Sitemap index: `https://www.borger.dk/sitemap.xml` (~350 KB, thousands of URLs). Each entry has `<lastmod>` and `<changefreq>daily</changefreq>`.
- `robots.txt` blocks: `/Soeg`, `/Portalservicesiden`, `/Deviceinformation`, `/LoginFejl`, `/401`, `/404`, `/404-selvbetjening`, `/500`, `/logget-af`, `/usupporteret-selvbetjening`, `/vaelg-kommune`, `/Min-Side/` (and lower-case variants).

## Common citizen tasks

- **Find an article**: start at the relevant section, or search at `/Soeg?k=<query>` / `POST /api/search`.
- **Launch a self-service form**: follow the article's "Genveje til selvbetjening" → `/Handlingsside?selfserviceId=<GUID>`.
- **Switch to your kommune**: use the in-page `<select>` or `/vaelg-kommune`.
- **See your overview**: `/mitoverblik` after MitID login.
- **Read statutory mail**: `https://post.borger.dk` after MitID login.
- **Read in English**: replace `www.borger.dk/<da-section>` with `lifeindenmark.borger.dk/<en-section>`.
- **Find kommune contact info**: `/om-borger-dk/Find-en-myndighed`.

## Limits

- Personalised data on `/mitoverblik` is session-bound to a live MitID login — no public API, no service-account access.
- The English mirror is a curated subset, not a full translation.
- Site search (`/Soeg`) and `/Min-Side/` are blocked for crawlers.
- Self-service flows delegate to many backends (Udbetaling Danmark, Skat, kommune ESDH, etc.); same `selfserviceId` may behave differently per kommune or role.
- Missing Mit Overblik data is often a backend integration gap.

## borger.dk internal JSON API

`https://www.borger.dk/api/`. No public/documented API, no API key, no OAuth, no service account. All endpoints are **POST-only** — `GET` returns `405`. Treat as undocumented; expect breaking changes. Etiquette: polite, low-rate usage.

### Conventions

- Send `Content-Type: application/json`; bodyless POSTs work but wrong schema returns `500`.
- Responses come from `IIS / .NET Web API` with `Set-Cookie: ASP.NET_SessionId`, `.ASPXAUTH`, `Content-Security-Policy`, `Strict-Transport-Security`. Discard cookies unless you need session continuity.
- Error envelope: `{"Message":"<text>"}`. `500` is the universal "bad input" signal — do not retry.
- Auth model: `/api/search` works anonymously. `/api/tokenvalues/single` requires a `TokenId` emitted into the topbar HTML for logged-in MitID users only.

### `POST /api/search` — site search autocomplete

The only useful anonymous endpoint. Backs the typeahead in the site header.

Request: JSON with the `data-portal-id` GUID (currently `ecfef56c-98e7-42f9-9e22-37d9268009ad`) and `snippet`:

```json
{"portalId": "ecfef56c-98e7-42f9-9e22-37d9268009ad", "snippet": "pas"}
```

Response: array of `{Text, DisplayText}`. `DisplayText` wraps the matched substring in `<strong>…</strong>`:

```json
[
  {"Text": "pasningsorlov",           "DisplayText": "<strong>pas</strong>ningsorlov"},
  {"Text": "pasningsvederlag",        "DisplayText": "<strong>pas</strong>ningsvederlag"},
  {"Text": "pasning af familiemedlem","DisplayText": "<strong>pas</strong>ning af familiemedlem"},
  {"Text": "pas",                     "DisplayText": "<strong>pas</strong>"},
  {"Text": "pasansøgning",            "DisplayText": "<strong>pas</strong>ansøgning"}
]
```

- Empty `snippet` → popular-terms list.
- Wrong `portalId` → `500`. Refresh the GUID by re-fetching `https://www.borger.dk/`.
- Server returns top ~10 suggestions; no `limit` param.
- Full results page: `/Soeg?k=<term>` (HTML, disallowed for crawlers).

### `POST /api/tokenvalues/single` — topbar badge value (auth required)

Backs unread-count badges on Digital Post and Mit Overblik topbar buttons.

Request: `{"TokenId": "<token from data-tokenid>"}`. Response: bare string (e.g. `"3"`, `""`, or `"-1"`). Token is per-user, per-feature, rotates on logout. Not useful for unauthenticated automation.

## Helper script

`borger_dk_api.py` (in this skill folder) wraps the search autocomplete endpoint plus a small home-page probe. Standard library only.

```bash
python3 borger_dk_api.py search pas                  # autocomplete suggestions for "pas"
python3 borger_dk_api.py search pas --raw            # raw JSON
python3 borger_dk_api.py popular                     # popular terms (empty snippet)
python3 borger_dk_api.py portalid                    # current data-portal-id from the home page
python3 borger_dk_api.py endpoints                   # all /api/* paths the home page references
python3 borger_dk_api.py sitemap [--limit N]         # URLs from /sitemap.xml
```

Each subcommand exits non-zero on HTTP error and writes the response body to stderr.

## What you cannot do via these APIs

- No public read access to citizen-personal pages (`/mitoverblik`, `/Min-Side/`, `https://post.borger.dk`). All data is session-bound to a live MitID login.
- No structured article fetch — articles are server-rendered HTML at their slug URL.
- No bulk export — enumerate URLs from `/sitemap.xml`, then fetch each HTML page.
- No documented contract: any endpoint can change without notice.
