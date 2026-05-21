---
name: m-dk
description: m.dk (Metroen) — the official Copenhagen metro website. Covers site navigation, metro lines, stations, live operational status, and the internal Ankiro search API. Use when browsing metro info, checking status, or searching site content programmatically.
last-updated: 2026-05-09
---

# m.dk — Copenhagen Metro website

Official website for the Copenhagen Metro, operated by **Metroselskabet**. Built on **Next.js** with SSR. Bilingual: Danish (`/da/`) and English (`/en/`). All content is public (no login).

All URLs are relative to `https://m.dk/`.

## Top-level navigation

| Nav item | URL | Description |
|---|---|---|
| Rejs med Metroen | `/da/rejs-med-metroen/` | Tickets, customer service, app info |
| Linjer og køreplaner | `/da/linjer-og-koereplaner/` | Line routes and timetables |
| Drift og service | `/da/drift-og-service/` | Live status and planned disruptions |
| Udforsk København | `/da/rejs-med-metroen/udforsk-koebenhavn/` | City exploration guides |

Tickets are purchased through **rejsekort.dk**. Customer service info is at the main `/da/rejs-med-metroen/` URL. Journey planning redirects to **Rejseplanen.dk**.

## Metro lines

Four lines, each with a dedicated page:

| Line | Route | Slug |
|---|---|---|
| M1 | Vanløse ↔ Vestamager | `/da/linjer-og-koereplaner/vanloese-vestamager/` |
| M2 | Vanløse ↔ Københavns Lufthavn | `/da/linjer-og-koereplaner/vanloese-koebenhavns-lufthavn/` |
| M3 | Cityringen (ring line) | `/da/linjer-og-koereplaner/cityringen/` |
| M4 | Orientkaj ↔ København Syd (extends M3) | `/da/linjer-og-koereplaner/orientkaj-koebenhavn-syd/` |

Each line page lists all stations in order with interchange info. M3 and M4 share tracks between Nørreport and København Syd.

## Stations

~30 stations total. Key stations:

| Station | Lines | Slug |
|---|---|---|
| København H | M3/M4 + S-tog/regionsvogne | `/da/planlaeg-rejsen/koebenhavn-h/` |
| Nørreport | M1/M2/M3 | `/da/planlaeg-rejsen/noerreport/` |
| Kongens Nytorv | M1/M2/M3/M4 | `/da/planlaeg-rejsen/kongens-nytorv/` |
| Christianshavn | M1/M2 | `/da/planlaeg-rejsen/christianshavn/` |
| Nordhavn | M3 | `/da/planlaeg-rejsen/nordhavn/` |
| Københavns Lufthavn | M2 | `/da/planlaeg-rejsen/koebenhavns-lufthavn/` |
| København Syd | M4 | `/da/planlaeg-rejsen/koebenhavn-syd/` |
| Vestamager | M1 | `/da/planlaeg-rejsen/vestamager/` |
| Orientkaj | M4 | `/da/planlaeg-rejsen/orientkaj/` |

Station pages show line info, passenger counts, elevator availability, and type (underground/above-ground).

## Drift og service (Operations)

### Live status — `/da/drift-og-service/status-og-planlagte-driftsaendringer/`

Shows operational status for M1/M2 and M3/M4 groups. Status is embedded directly in the HTML (no separate API):

- `name`: Status text (e.g. "Vi kører efter planen" = running as scheduled)
- `lineGroup`: Affected lines (e.g. "M1/M2" or "M3/M4")
- `clearMessages`: Resolution text
- `createDate`: Timestamp

### Maintenance — `/da/drift-og-service/vedligehold-af-metroen/`

Planned maintenance schedules.

## Udforsk København

Guides about Copenhagen attractions reachable by metro:

| Section | Slug |
|---|---|
| Main hub | `/da/rejs-med-metroen/udforsk-koebenhavn/` |
| City highlights | `/da/rejs-med-metroen/udforsk-koebenhavn/byens-hoejdepunkter/` |

Articles feature local personalities, seasonal guides, food spots, art, beaches, festivals, etc. Each article has an associated nearby metro station and line.

Slug pattern: `/da/rejs-med-metroen/udforsk-koebenhavn/byens-hoejdepunkter/<slug>/`

## English mirror

All pages have an English equivalent at `/en/`:

| Danish | English |
|---|---|
| `/da/forside/` | `/en/frontpage/` |
| `/da/rejs-med-metroen/` | `/en/travel-with-the-metro/` |
| `/da/linjer-og-koereplaner/` | `/en/routes-and-timetables/` |
| `/da/drift-og-service/` | `/en/operations-and-service/` |
| `/da/rejs-med-metroen/udforsk-koebenhavn/` | `/en/explore-copenhagen/` |

English mirror has fewer articles.

## Sitemap & robots

Full sitemap: `https://m.dk/sitemap.xml` (~387 URLs). All pages have `<lastmod>` and `<changefreq>monthly</changefreq>`.

`robots.txt` disallows: `/_next/`, `/api/`, `/_error/`, `/private/`. The Ankiro API at `m.ankiro.dk` is not covered by m.dk's `robots.txt`.

## Common tasks

- **Find a station**: `/da/planlaeg-rejsen/<slug>/` or search via Ankiro API.
- **Check line routes**: `/da/linjer-og-koereplaner/` or API with `pageType:metroLine`.
- **Check live status**: `/da/drift-og-service/status-og-planlagte-driftsaendringer/` — status is embedded in HTML.
- **Buy tickets**: Redirect to `rejsekort.dk`.
- **Plan a journey**: Redirect to `rejseplanen.dk`.
- **Search content**: Use the Ankiro API or `agent-browser`.
- **Read an article**: `/da/rejs-med-metroen/udforsk-koebenhavn/byens-hoejdepunkter/<slug>/`

---

## Internal API: Ankiro Search

`https://m.ankiro.dk/Rest/Metro-Live/Search` — primary internal API used by m.dk for site-wide search. Powered by the Ankiro Suite search engine.

### Conventions

- **Method**: GET only. Query parameters in URL.
- **Auth**: None. Open to any caller.
- **Response**: `application/json`.
- **Rate limits**: Unknown — best-effort.
- **User-Agent**: Normal browser UA recommended.
- **robots.txt**: `m.ankiro.dk` is a separate host, not covered by m.dk's `robots.txt`.

### Query parameters

| Param | Type | Required | Description |
|---|---|---|---|
| `q` | string | Yes | Search query |
| `culture` | string | No | Language filter (values: `da`). Default: no filter |
| `startIndex` | int | No | Pagination offset (0-based). Default: 0 |
| `maxResults` | int | No | Max results per page. Default: 10 |

### Response shape

```json
{
  "SearchId": "uuid",
  "Timestamp": "2026-05-09T02:37:25.348778+02:00",
  "Offset": 0,
  "TotalResults": 751,
  "SearchTime": "00:00:00.2289918",
  "Documents": [...],
  "Facets": [...],
  "Decorations": { "Properties": [...], "Indexes": [...] },
  "Pagination": { "PageSize": 10, "CurrentPage": 0, "TotalPages": 76, "Pages": [...] }
}
```

### Document properties

Each `Document` has a `Properties` array. Key searchable properties on the "Metro live" index:

| Property | Type | Description |
|---|---|---|
| `Title` | string | Page title |
| `Uri` | string | Full URL to the page |
| `Content` | string | Body text (truncated with `<b>...</b>` highlights) |
| `pageType` | string | Content type (e.g. `metroStation`, `metroLine`, `metroNewsItem`) |
| `metroLine` | string | Line code (`M1`–`M4`) — only on line pages |
| `Culture` | string | Language: `da` |
| `Domain` | string | Always `m.dk` |
| `LastUpdated` | string | ISO date of last update |

Filter by `pageType` is done client-side. Pagination uses `startIndex`; total pages = `TotalResults / maxResults`.

### Example queries

```bash
# Search for "nørrebro"
curl 'https://m.ankiro.dk/Rest/Metro-Live/Search?q=n%C3%B8rrebro&culture=da'

# Paginate: page 2 (results 11-20)
curl 'https://m.ankiro.dk/Rest/Metro-Live/Search?q=metroen&startIndex=10&maxResults=10'
```

### CLI helper

`m_dk_api.py` (in this folder) wraps the search endpoint:

```bash
python3 m_dk_api.py search koebenhavn              # search
python3 m_dk_api.py search nørrebro                 # special chars
python3 m_dk_api.py search koebenhavn --raw         # raw JSON
python3 m_dk_api.py search metroen --start 10 --max 5  # paginate
python3 m_dk_api.py facets koebenhavn               # facet definitions
```

### What you cannot do

- No journey planning API — use Rejseplanen.dk.
- No ticket purchase API — use rejsekort.dk.
- No live departure times API — m.dk doesn't expose real-time departures.
- No authentication — API is fully public.
- No indexing control — cannot add/remove content from index.
- No full-text excerpt extraction — `Content` is truncated.

### Related hosts

- `https://m.dk/` — main website (Next.js, SSR)
- `https://m.ankiro.dk/` — search index backend (Ankiro Suite)
- `https://metroselskabet.dk/` — corporate site
- `https://metroselskabet.euwest01.umbraco.io/` — media/asset CDN
- `https://rejseplanen.dk/` — journey planner
- `https://www.rejsekort.dk/` — ticketing platform
