# dr-dk

Reference for navigating dr.dk — Denmark's public broadcaster (Danmarks Radio). Covers three pillars: **NYHEDER** (news), **DRTV** (streaming TV), and **DR LYD** (radio/audio). No login required for browsing.

## Requirements

- `dr_dk_api.py` CLI helper — standard library only
- Internet access to `www.dr.dk` and `api.dr.dk`

## Quick Start

```bash
# Read a news article
open https://www.dr.dk/nyheder/indland/some-article

# Watch a DRTV episode
open https://www.dr.dk/drtv/episode/episode-name_594820

# Watch live DR1
open https://www.dr.dk/drtv/kanal/dr1_20875

# Browse radio/podcasts
open https://www.dr.dk/lyd

# Search
open https://www.dr.dk/soeg?query=topic

# CLI: latest news from /nyheder
python3 dr_dk_api.py frontpage --limit 10

# CLI: article data
python3 dr_dk_api.py article nyheder/indland/example

# CLI: list sitemap files
python3 dr_dk_api.py sitemap

# CLI: TV guide URLs
python3 dr_dk_api.py tvguide --limit 20
```

## Navigation Reference

### NYHEDER (News)

| Section | URL |
|---|---|
| Latest | `/nyheder/seneste` |
| Domestic | `/nyheder/indland` |
| International | `/nyheder/udland` |
| Politics | `/nyheder/politik` |
| Economy | `/nyheder/penge` |
| Regional | `/nyheder/regionale` |
| Weather | `/nyheder/vejret` |
| Traffic | `/trafik` |
| Sport | `/sporten/` |
| Kids | `/ultra/ultra-nyt-nyheder-til-boern` |

### DRTV (Streaming TV)

| Section | URL |
|---|---|
| Front page | `/drtv/` |
| Live channels | `/drtv/kanal/<channel-id>` |
| Episodes | `/drtv/episode/<slug>_<id>` |
| Films | `/drtv/film/<slug>_<id>` |
| TV guide | `/drtv/tv-guide` |
| Kids (9-14) | `/drtv/ultra` |
| Young kids (3-8) | `/drtv/ramasjang` |
| Toddlers (0-3) | `/drtv/minisjang` |

### DR LYD (Radio)

| Section | URL |
|---|---|
| Radio home | `/lyd` |
| Programs | `/lyd/programmer/<slug>` |
| Popular | `/lyd/tema/populaere` |

### Key data source: `__NEXT_DATA__`

News section pages (`/nyheder`, `/nyheder/indland`, article pages, etc.) embed structured JSON in `<script id="__NEXT_DATA__">`. Parse this for reliable data: article body, author, publication date, URN, HLS stream URLs, and news article lists (`site.publications[]`). The home page (`/`) uses Next.js App Router and does not contain `__NEXT_DATA__` — use `/nyheder` instead.

### Internal APIs

| Endpoint | Purpose |
|---|---|
| Embedded `__NEXT_DATA__` | Primary data source for all content |
| `GET https://api.dr.dk/odacache/api/Publication/Image/<URN>?imageId=<UUID>` | Clip thumbnails |
| `GET https://www.dr.dk/tjenester/oembed/v2?url=<URL>` | oEmbed for embedding |
| `GET https://www.dr.dk/sitemapindex.xml` | Sitemap index |

## Troubleshooting

- **Geo-blocking**: Content is restricted to Denmark, Greenland, and the Faroe Islands.
- **No public API key**: All endpoints are anonymous and undocumented. Expect breaks.
- **robots.txt** blocks `/soeg/*`, `/drtv/soeg*`, and all AI/LLM crawlers.
- **Preferred data source**: Always prefer `__NEXT_DATA__` over HTML parsing.
