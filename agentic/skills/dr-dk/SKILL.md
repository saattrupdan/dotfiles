---
name: dr-dk
description: dr.dk — Denmark's public broadcaster (DR). Covers NYHEDER news, DRTV streaming, and DR LYD radio. Uses Next.js "Hydra" framework with embedded __NEXT_DATA__ JSON as primary data source. Use for accessing Danish news, DRTV episodes, radio content, and DR's internal APIs.
last-updated: 2026-05-09
---

# dr.dk — Danmarks Radio

Denmark's public-service broadcaster. Content is free, no login needed for browsing (geo-restricted to Denmark/Greenland/Faroe Islands). Site language: Danish — respond in Danish unless the user has signalled otherwise.

## Three main sections

| Section | Root URL | Purpose |
|---|---|---|
| **NYHEDER** | `https://www.dr.dk/nyheder/` | News articles, liveblogs, embedded videos |
| **DRTV** | `https://www.dr.dk/drtv/` | Live channels, on-demand episodes, films, series |
| **DR LYD** | `https://www.dr.dk/lyd` | Radio streams, podcasts, audio programmes |

## NYHEDER — News

### URL patterns

| Pattern | Description |
|---|---|
| `/nyheder` | Front page |
| `/nyheder/seneste` | Latest news |
| `/nyheder/indland` | Domestic · `/nyheder/udland` International |
| `/nyheder/politik` | Politics · `/nyheder/penge` Economics |
| `/nyheder/regionale` | Regional · `/nyheder/vejret` Weather |
| `/trafik` | Traffic · `/nyheder/<slug>` Article |
| `/soeg?query=<term>` | Search (HTML only) |

### Article anatomy

Each article page embeds JSON in `<script id="__NEXT_DATA__">`. Key fields under `viewProps.article`:

- **Title** — `article.title` (also `<h1>` headline)
- **Summary** — `article.summary`
- **Body** — `article.body[]` components (`ParagraphComponent`, `HeadingComponent`, `ImageComponent`, `Link`). Prose: `body[].body[].text` where `type == "Text"`.
- **Authors** — `article.contributions[].agent.name` + `.email`
- **Date** — `article.startDate` (ISO 8601)
- **Section** — `article.site.title` + `.url`
- **URN** — `article.urn` (stable identifier)
- **Media** — `article.head[]` where `type == "MediaComponent"`; `resource.urn` + `resource.hlsStream.streamEncrypted` for video
- **Glossary** — `article.glossary[]`

### Liveblogs

`format: "LiveArticleFormat"` articles contain `liveBlog.id` (e.g. `"nyhederne/77300"`) and `liveBlog.items[]` with `id`, `title`, `startDate`.

### Key section URLs

`/nyheder/indland` · `/nyheder/udland` · `/nyheder/politik` · `/nyheder/penge` · `/nyheder/regionale` · `/nyheder/vejret` · `/sporten/` · `/ultra/ultra-nyt-nyheder-til-boern`

## DRTV — Streaming TV

### URL patterns

| Pattern | Description |
|---|---|
| `/drtv/kanal/<id>` | Live channel (e.g. `dr1_20875`) |
| `/drtv/episode/<slug>_<id>` | On-demand episode |
| `/drtv/serie/<slug>_<id>` | Series · `/drtv/film/<slug>_<id>` Film |
| `/drtv/kategorier` | Categories · `/drtv/tv-guide` EPG |
| `/drtv/gensyn` | Catch-up |
| `/drtv/ultra` | Kids 9-14 · `/drtv/ramasjang` 3-8 · `/drtv/minisjang` 0-3 |

### Video playback

HLS streaming. Stream URL in `__NEXT_DATA__` as `hlsStream.streamEncrypted` (base64-encoded HLS playlist). From article `head[]` or DRTV episode pages.

### Geo-restrictions

Available only in Denmark, Greenland, Faroe Islands. EU travelers can authenticate with MitID/NemID.

## DR LYD — Radio/Audio

Root: `https://www.dr.dk/lyd`. Programs: `/lyd/programmer/<slug>`. Categories include "Populære" (`/lyd/tema/populaere`).

## Hydra framework — `__NEXT_DATA__`

News section pages (`/nyheder`, `/nyheder/indland`, article pages, etc.) embed structured JSON in `<script id="__NEXT_DATA__" type="application/json">`. This is the primary data source.

`__NEXT_DATA__.props.pageProps.viewProps` contains:

**On `/nyheder` (news front page)**:
- `site.publications[]` — latest articles; each has a `content` object with `title`, `urlPathId`, `urn`, `format`, `startDate`, `contributions[]`
- `emergencyMessages[]` — emergency alerts (rare)
- `env` — environment variables (API base paths, widget IDs)

**On article pages**:
- `article` — full article data (`title`, `urn`, `urlPathId`, `format`, `startDate`, `site`, `body[]`, `head[]`, `contributions[]`, `glossary[]`)

Note: the home page (`https://www.dr.dk/`) has migrated to Next.js App Router and no longer contains `__NEXT_DATA__`. Use `/nyheder` as the news entry point.

**Article formats**: `StandardArticleFormat` (regular), `LiveArticleFormat` (liveblog), `OverviewArticleFormat` (multi-part), `ReelsFormat` (short vertical video).

## Common tasks — recipes

- **Read article**: Fetch `/nyheder/<section>/<slug>`. Parse `__NEXT_DATA__`. Extract prose from `article.body[].body[].text` where `type == "Text"`.
- **Browse news front page**: Fetch `/nyheder`. Parse `site.publications[].content` for article list.
- **Watch DRTV episode**: `/drtv/episode/<slug>_<id>`. HLS URL in `hlsStream.streamEncrypted`.
- **Watch live TV**: `/drtv/kanal/<channel-id>` (e.g. `dr1_20875`).
- **Weather**: `/nyheder/vejret` · **Traffic**: `/trafik` · **TV guide**: `/drtv/tv-guide`
- **Kids**: `/drtv/minisjang` (0-3) · `/drtv/ramasjang` (3-8) · `/drtv/ultra` (9-14)
- **Radio**: `/lyd`

## Internal APIs

Not public APIs — no auth, no SLA, no documentation. Discovered from page source; may change without notice.

### 1. Embedded `__NEXT_DATA__` — PRIMARY DATA SOURCE

Parse `<script id="__NEXT_DATA__">` from any page. Navigate to `props.pageProps.viewProps` for content (frontpage, articles, DRTV streams, channels).

### 2. Image API — `api.dr.dk/odacache`

```
GET https://api.dr.dk/odacache/api/Publication/Image/<URN>?imageId=<UUID>
```

Returns JPEG/PNG directly. URN from `article.head[].resource.urn`; UUID from `article.head[].resource.imageUri`.

**Resized variant** (CDN proxy at `asset.dr.dk/imagemanager/magic`): supports `im=` parameter for cropping/resizing (e.g. `AspectCrop=(W,H);Resize=(W,H)`).

### 3. Widget proxy — `api.dr.dk/automat`

```
GET https://api.dr.dk/automat/referral/<WIDGET_ID>?priority=<P>
```

Returns HTML snippets for embedded widgets (TV player, banners).

### 4. oEmbed — `www.dr.dk/tjenester/oembed/v2`

```
GET https://www.dr.dk/tjenester/oembed/v2?url=<PAGE_URL>
```

Returns title, author, thumbnail for a DR page URL.

## Sitemap

- `https://www.dr.dk/sitemapindex.xml` — index pointing to:
  - `https://www.dr.dk/drtv/sitemap.xml` — DRTV episode/film/series URLs
  - `https://www.dr.dk/sitemap.tvguide.xml` — TV guide URLs

## Login

`https://www.dr.dk/auth/drlogin/login` — DR account (email/password). Required for watch history, bookmarks, age filtering, and watching from outside Denmark. Uses Auth0 (`login.dr.dk`).

## Legal / ethics

- Pressenævnet: `https://www.pressenaevnet.dk/`
- Ethics & corrections: `https://www.dr.dk/etik-og-rettelser`
- Privacy: `https://www.dr.dk/om-dr/dr-og-dine-data`
- Contact: `info@dr.dk`, `35 20 30 40`, DR, Emil Holms Kanal 20, 0999 København C

## Limits

- Geo-blocking: content restricted to DK/GL/FO
- No public API key — anonymous, undocumented endpoints; expect breaks
- `robots.txt` blocks `/soeg/*`, `/drtv/soeg*`, `/login/`, `/auth/`, and AI crawlers
- Crawl gently — limited bandwidth
- `__NEXT_DATA__` is the golden source — prefer it over HTML parsing

## Helper script

`dr_dk_api.py` (in this folder) wraps verified endpoints. Standard library only.

```bash
python3 dr_dk_api.py frontpage                   # Latest news articles from /nyheder
python3 dr_dk_api.py frontpage --limit 10        # More articles
python3 dr_dk_api.py frontpage --urn             # Include article URNs
python3 dr_dk_api.py frontpage --raw             # Raw JSON output
python3 dr_dk_api.py article nyheder/indland/example     # Extract article data
python3 dr_dk_api.py image "urn:dr:od3:clippublication:..." <uuid>  # Download thumbnail
python3 dr_dk_api.py sitemap                     # List sitemap files
python3 dr_dk_api.py tvguide --limit 20          # First 20 TV guide URLs
```

Errors (HTTP 4xx/5xx, JSON parse failure) go to stderr and exit non-zero.
