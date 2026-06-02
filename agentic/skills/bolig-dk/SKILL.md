---
name: bolig-dk
description: Danish housing listings — rentals (boligportal.dk) and for-sale homes (boligsiden.dk). Provides the `bolig` CLI for searching listings by filters or by keywords in the description body (e.g. 'badekar'), plus addresses, realtors, municipalities, and documented internal/public APIs. Use when searching Danish rental or for-sale properties, browsing by city/municipality/zip, free-text/keyword searching listing descriptions, or querying the sites' APIs.
last-updated: 2026-06-02
---

# bolig-dk — Danish housing (rentals + for-sale)

Two complementary sources, one CLI:

- **boligportal.dk** — Denmark's largest **rental** housing marketplace (`bolig rent ...`).
- **boligsiden.dk** — the **for-sale** property-listing aggregator, pulling from dozens of agencies (`bolig buy ...`).

Default page language is Danish; respond in Danish unless the user signals otherwise.

## CLI

All interaction goes through the `bolig` CLI — it can be run from anywhere, with no need to point at the skill directory:

```bash
bolig <rent|buy> <command> [options]
```

### Prerequisites

Verify the CLI is installed:

```bash
which bolig
```

If missing, install it editable with pipx (from the skill directory). First make sure pipx itself is available, then install:

```bash
# Ensure pipx is installed
which pipx || python3 -m pip install --user pipx
python3 -m pipx ensurepath

# Install the bolig CLI
pipx install -e <path-to-bolig-dk-skill>
```

After installing, confirm `bolig` is on the PATH (you may need to restart the shell so `pipx ensurepath` takes effect):

```bash
which bolig
```

Pure Python standard library — no extra dependencies. Every command supports `--raw` for unformatted JSON.

---

## `bolig rent` — rentals (boligportal.dk)

```bash
# Search apartments in Aarhus
bolig rent search --city aarhus --type apartment --limit 5

# Filter by rooms and price
bolig rent search --city odense --min-rooms 2 --min-price 5000 --max-price 10000

# KEYWORD body search: listings whose description mentions 'badekar' (bath tub)
bolig rent search --city aarhus --type apartment -k badekar

# Multiple keywords — all must appear (default), or any with --match any
bolig rent search --city kobenhavn -k altan -k elevator
bolig rent search --city kobenhavn -k altan -k terrasse --match any

# Map-view listings with coordinates
bolig rent map --city aarhus --type student --limit 10

# Sponsored / promoted listings
bolig rent promoted --city kobenhavn

# Most-favorited listings across all users
bolig rent top-favorites --limit 5

# Raw POST to any endpoint
bolig rent raw listing/listings '{"page":0,"pageSize":5,"filter":{"cityCode":"kobenhavn"}}'
```

`--type` values: `apartment`, `room`, `house`, `townhouse`, `student` (default: all rentals). `--city` takes the URL slug or plain name (`aarhus`, `kobenhavn`, `København` — all accepted).

### Keyword / body search (`-k`)

The built-in filters don't cover everything (e.g. a bath tub, a specific appliance, a view). `-k`/`--keyword` searches the **full description body** of each listing, which the structured filters can't reach.

`search` enumerates listings from the public hub pages (anonymous — no login), then for each candidate fetches its detail page and keeps those whose description body or title contains the term(s). Because matching reads each detail page, the number inspected is capped by `--max-scan` (default 100); raise it for rarer terms. Pass `-k` multiple times; `--match all` (default) requires every term, `--match any` requires one. The output header reports how many listings were scanned.

### Filters: server-side vs client-side

boligportal's hub pages only honour `min_size_m2` (→ `--min-area`) and `max_monthly_rent` (→ `--max-price`) server-side, plus `newbuild=1` (→ `--new-build`). `--min-price`, `--max-area`, `--min-rooms`, and `--max-rooms` are applied **client-side** to the result rows (each row carries `rooms`, `size_m2`, `monthly_rent`). Category and city live in the URL path.

### Auth model

| Surface (`bolig rent ...`) | Source | Auth |
|---|---|---|
| `search` (incl. `-k`) | Public hub pages (`SearchResultApp`/`AdDetailApp` JSON) | **Anonymous** |
| `promoted` | `POST /api/search/promoted-ads` | Anonymous |
| `map` | `POST /api/search/map` | Unavailable (HTTP 500, as of 2026-05) |
| `top-favorites` | `POST /api/listing/top-favorite-ads/` | Session-bound |

`search` no longer uses the session-bound `POST /api/listing/listings/` endpoint — it scrapes the anonymous hub pages instead, so it works without a login. (The JSON endpoint remains reachable via `bolig rent raw` for authenticated callers.)

## `bolig buy` — for-sale (boligsiden.dk)

```bash
# Latest 5 listings
bolig buy cases --limit 5

# Properties over 2M DKK in Copenhagen
bolig buy cases --min-price 2000000 --city "København"

# Only villas with at least 4 rooms
bolig buy cases --type villa --min-rooms 4 --limit 10

# KEYWORD body search: for-sale homes whose description mentions 'badekar'
bolig buy cases --city frederiksberg -k badekar

# DEEP keyword search: also reads each candidate's full agency-page text
# (the API body is capped at ~500 chars, so this catches buried terms)
bolig buy cases --city frederiksberg -k badekar --deep

# Multiple keywords (all by default; --match any for OR)
bolig buy cases -k brændeovn -k udsigt --match any

# Ground-floor (stueetage) flats — use the FLOOR filter, never `-k stue`
bolig buy cases --city frederiksberg --type lejlighed --min-floor 0 --max-floor 0

# Cap the monthly owner expense (ejerudgift)
bolig buy cases --city frederiksberg --max-monthly-fee 4000

# Whole big city → filter by municipality (repeatable)
bolig buy cases --municipality københavn --type villa

# Filter by postal code (repeatable)
bolig buy cases --zip-code 2000

# Look up addresses by road name (prefix match)
bolig buy address strandvejen

# List real estate agencies in a location
bolig buy realtor københavn --location-type municipality

# List all municipalities with population and slug
bolig buy municipalities

# GET a raw API path with a query string
bolig buy raw search/cases "page=1&cities=frederiksberg&numberOfRoomsMin=3"
```

`--type` values: Danish or English — `lejlighed`/`condo`, `villa`, `rækkehus`/`terraced house`, `andelsbolig`/`cooperative`, `villalejlighed`/`villa apartment`, `landejendom`/`farm`, `sommerhus`/`holiday house`, `husbåd`/`houseboat`, etc. (repeatable). Geography uses boligsiden **place slugs**: `--city` is a city/district slug (`frederiksberg`, `aarhus c`) while whole big cities are *municipalities* (`--municipality københavn`, `aarhus`, `odense`); `--zip-code` filters by postal code. All three are repeatable. Run `bolig buy municipalities` to see municipality slugs.

**Prefer built-in filters over `-k`.** Anything the API can filter structurally should use a dedicated option, not keyword search — it's faster, exact, and not subject to the description-body cap. In particular **ground floor / stueetage is `--min-floor 0 --max-floor 0`, never `-k stue`/`-k stueetage`**. The structural filters are: price (`--min-price`/`--max-price`), monthly owner expense (`--min-monthly-fee`/`--max-monthly-fee`), area (`--min-area`/`--max-area`), rooms (`--min-rooms`/`--max-rooms`), floor (`--min-floor`/`--max-floor`), property type (`--type`), and geography (`--city`/`--municipality`/`--zip-code`). Reserve `-k` for genuinely free-text features that have no structural filter (e.g. `badekar`, `brændeovn`, `udsigt`, `nyrenoveret`).

`-k`/`--keyword` filters on each case's embedded `descriptionTitle` + `descriptionBody` (no extra requests — the body ships with the listing); pages are scanned up to `--max-scan` (default 200) to collect `--limit` matches.

**The ~500-char cap and `--deep`:** the API caps `descriptionBody` at **~500 characters**, so by default `-k` only matches terms in the title or first ~500 chars. Common features (`altan`, `elevator`) appear early; rarer ones buried deep (often `badekar`) get missed. Pass **`--deep`** to also read each candidate's *full* description from the agency's own listing page (the case's `caseUrl`, which is not Cloudflare-gated). To stay robust as agencies come and go, `--deep` pulls only the standard description fields — JSON-LD `description`, then `og:`/`meta` description — falling back to the longest text blocks only when neither exists; both the download and kept text are capped. It costs one HTTP request per candidate whose truncated body *doesn't* already match (bounded by `--max-scan`). Those fetches run concurrently — `--deep-workers N` (default 8) — while matches stay in listing order, so e.g. ~60 fetches drop from ~95 s to ~20 s. Full texts are cached on disk (`~/.cache/bolig-dk/deep-text.json`, keyed by `caseUrl`, TTL `--cache-ttl-days`, default 7; disable with `--no-cache`), so a repeat run re-pings nothing — the same ~40-listing search drops from ~8 s to <1 s. It's still the slow path on a cold cache, so scope it with filters and a sensible `--max-scan`. A handful of JS-rendered agency pages expose no server-side text and are silently skipped.

---

## boligportal.dk reference (rentals)

All URLs relative to `https://www.boligportal.dk/`. Slugs use **URL-encoded Danish letters** (`æ`→`%C3%A6`, `ø`→`%C3%B8`, `å`→`%C3%A5`).

### Property categories

Main hubs (each supports `?offset=<N>` pagination, 18/page, and `?newbuild=1`):

| Category | Danish URL | English URL |
|---|---|---|
| All rentals | `/lejeboliger/` | `/en/rental-properties/` |
| Apartments | `/lejligheder/` | `/en/rental-apartments/` |
| Rooms | `/værelser/` | `/en/rental-rooms/` |
| Student housing | `/studieboliger-<city>/c/` | `/en/student-housing-<city>/c/` |
| Townhouses | `/rækkehuse/` | `/en/rental-townhouse/` |
| Houses | `/huse/` | `/en/rental-houses/` |

Specialty filters (Danish only): `/ældreboliger/c/`, `/almene-boliger/c/`, `/delelejligheder/c/`, `/delevenlige-lejligheder/c/`, `/lejligheder-med-altan/c/`, `/lejeboliger-med-husdyr-tilladt/c/`.

### Listing URL pattern

`/<category>/<city>/<size>m2-<rooms>vaer-id-<id>`

Example: `/lejligheder/k%C3%B8benhavn/58m2-2-vaer-id-5621440` — apartment, Copenhagen, 58 m², 2 rooms.

### English mirror

Mirror at `/en/` mirrors the Danish structure (see table above). Favorites: `/favoritter/` → `/en/favourites/`, Inbox: `/indbakke/` → `/en/inbox/`. Listing slugs follow the same pattern in both languages.

### Anonymous hub pages (powers `bolig rent search`)

Each hub / search-results page (e.g. `/lejligheder/aarhus/`) and each listing detail page embed their full state in a single `<script type="application/json">` tag — no login required:

- **Hub page** → `props.page_props` of a `SearchResultApp` blob: `results` (18 listing objects with `id`, `url`, `title`, `rooms`, `size_m2`, `monthly_rent`, `city`, `street_name`, …), plus `result_count`, `offset`, `limit`, and `next_page_url` for pagination (`?offset=N`, 18/page). The list `description` field is **empty** here.
- **Detail page** → `props.page_props.ad` of an `AdDetailApp` blob: the full `description` body, `title`, structured `features`, etc.

Honoured hub query params: `min_size_m2`, `max_monthly_rent`, `newbuild=1`. Rooms are a path segment (`/<city>/N-værelser/`); other ranges are filtered client-side. Fetch hub pages with a browser `User-Agent` (non-browser UAs are gated). This is the anonymous path `search` (and its `-k` body search) uses.

### Internal JSON API

Base URL: `https://www.boligportal.dk/api/`. All endpoints are **POST-only** — `GET` returns an error. No API key for anonymous endpoints; session cookies for account-scoped ones.

Image URLs: `https://image-lambda.boligportal.dk/<hash>?auto=compress,enhance,format&w=<W>&h=<H>&fit=crop&crop=focalpoint`

#### `POST /api/listing/listings/` (session-bound — superseded by hub-page scraping)

Backs the main listing hub pages. Request:
```json
{
  "page": 0,
  "pageSize": 18,
  "filter": {
    "cityCode": "kobenhavn",
    "propertyType": "apartment",
    "minArea": 40, "maxArea": 100,
    "minRooms": 2,
    "minPrice": 5000, "maxPrice": 12000,
    "newBuild": false,
    "studentHousing": false
  }
}
```
Omitted filter fields are unconstrained. `propertyType` values: `apartment`, `room`, `house`, `townhouse`, `student`. Response: `{"total": <int>, "items": [{"id", "title", "price", "area", "rooms", "city", "imageUrl", "url", "isNew", "isFavorite"}]}`.

#### `POST /api/search/promoted-ads` (anonymous)

Request: `{"filter": {"cityCode": "<optional>"}}`. Response uses an `ads` array with snake_case fields (`monthly_rent`, `city`, `url`) and `more_promoted_ads`.

#### `POST /api/search/map` (unavailable — HTTP 500 as of 2026-05)

Same filter shape as `/listing/listings/`; returns listings with `lat`/`lng`.

#### `POST /api/listing/top-favorite-ads/` (session-bound)

Request: `{"limit": 10}`.

#### Other endpoints

- `POST /api/listing/favorites/` — favorites CRUD (session-bound). Add/remove: `POST /api/listing/favorites/<id>` with `{"favorite": true/false}`.
- `POST /api/login` — `{"email": "...", "password": "..."}`; sets session cookies.

### Limits worth flagging

- **No native full-text search** — the site has no keyword field; `bolig rent search -k` fills this by scanning description bodies client-side (capped by `--max-scan`).
- **No `/sitemap.xml`** (404) — enumerate via hub pages with `?offset=N` (18/page).
- **Listing detail pages are full HTML** — body text comes from the embedded `AdDetailApp` JSON (`ad.description`), not a JSON resource endpoint.

---

## boligsiden.dk reference (for-sale)

boligsiden aggregates listings from dozens of real estate agencies. The public site `https://www.boligsiden.dk/` **and its `/api/` HAL endpoints sit behind a Cloudflare managed challenge** (`cf-mitigated: challenge`) that a non-browser client cannot solve — requests get a 403 JS-challenge HTML page. The data-only host **`https://api.boligsiden.dk`** is **not gated**, so the CLI talks to it directly with a plain `GET`. (This is the same host `bolig-ping` uses.)

### URL conventions (the gated www site, for humans)

- Listing redirect: `https://boligsiden.dk/viderestilling/<caseID>` (redirects to the agency's own listing page; printed by `bolig buy cases`).
- Realtor: `https://www.boligsiden.dk/ejendomsmægler/<slug>`
- Municipality: `https://www.boligsiden.dk/kommune/<slug>`

### Data API — `api.boligsiden.dk` (GET, HAL-style)

Base URL: `https://api.boligsiden.dk`. No API key, no Cloudflare. Each resource carries `_links.self.href`. Responses are plain objects (no `_embedded` wrapper): list endpoints return a named array plus `totalHits`.

| Endpoint | Returns |
|---|---|
| `/search/cases` | `{cases: [...], totalHits}` — property listings (primary). |
| `/cases/<uuid>` | A single case. |
| `/search/addresses` | `{addresses: [...], totalHits}` — address lookup. |
| `/search/realtors` | `{realtors: [...]}` — agencies in a location. |
| `/municipalities` | `{municipalities: [...]}` — all 98, with `slug` + tax/population stats. |

#### `/search/cases` query parameters

| Param | Description |
|---|---|
| `page` | Page number (**1-indexed**). |
| `per_page` | Page size (default 50). |
| `sort` / `sortAscending` | Sort field (`priceCash`, `housingArea`, `daysOnMarket`, `timeOnMarket`, …) and `true`/`false`. |
| `priceMin` / `priceMax` | Price range in DKK. |
| `monthlyExpenseMin` / `monthlyExpenseMax` | Monthly owner expense (ejerudgift) in DKK. |
| `areaMin` / `areaMax` | Living area in m². |
| `numberOfRoomsMin` / `numberOfRoomsMax` | Room count range. |
| `floorMin` / `floorMax` | Floor range; **ground floor (stueetage) = `0`**. `floorMax=0` alone 400s — send `floorMin=0&floorMax=0` for ground floor only. |
| `cities` | City/district place slug (repeatable), e.g. `frederiksberg`, `aarhus c`. |
| `municipalities` | Municipality place slug (repeatable), e.g. `københavn`, `aarhus`. |
| `zipCodes` | Postal code (repeatable). |
| `addressTypes` | Property type (repeatable, **English**): `condo`, `villa`, `terraced house`, `cooperative`, `villa apartment`, `farm`, `hobby farm`, `holiday house`, `holiday plot`, `full year plot`, `houseboat`. |

**Geography gotcha:** `cities` matches boligsiden place slugs, so whole big cities return nothing as a *city* — `cities=københavn` → 0 hits, but `municipalities=københavn` → ~1600. Use `municipalities` for a whole city/kommune, `cities` for a named district. `municipalityCodes` is **not** honoured (silently ignored — returns everything); filter by slug instead.

Each case contains `_links`, `caseID`, `caseUrl` (agency redirect), pricing (`priceCash`, `perAreaPrice`, `monthlyExpense`), area metrics (`housingArea`, `lotArea`, `weightedArea`), `numberOfRooms`/`numberOfBathrooms`/`numberOfToilets`/`numberOfFloors`, `yearBuilt`, `energyLabel`, boolean amenities (`hasBalcony`, `hasElevator`, `hasTerrace`), `daysOnMarket`/`daysListed`/`timeOnMarket`, `descriptionTitle`, `descriptionBody` (**truncated to ~500 chars**, even on `/cases/<uuid>`), embedded `address` (coordinates, municipality, province, building details), embedded `realtor`, and `images`/`floorPlanImages` arrays.

#### Other endpoints

- `/search/addresses?text=<road-name>&per_page=N` — `text` is a **road-name prefix** match (single token; multi-word queries like `strandvejen 1 aarhus` return `addresses: null`). Each hit has address UUID, type, road, house number, zip, municipality, coordinates.
- `/search/realtors?locationType=<municipality|city>&locationName=<slug>` — agencies in that location (location-based, **not** a name search). Each realtor has `name`, `url`, `slug`, `contactInformation`, `rating` (`seller`/`buyer` scores), `caseCounts`.
- `/municipalities` — all municipalities with `municipalityCode`, `slug`, `name`, `population`, tax stats.

### Image CDN

All images from `https://images.boligsiden.dk/`:

| Pattern | Description |
|---|---|
| `.../images/case/{case-uuid}/{W}x{H}/{img-uuid}.webp` | Listing photos. |
| `.../images/floor_plan_case/{case-uuid}/{W}x{H}/{img-uuid}.webp` | Floor plans. |
| `.../images/realtor_image/{realtor-uuid}/{W}x{H}/{img-uuid}.webp` | Realtor photos. |
| `.../images/realtor_branch/{branch-uuid}/{W}x{H}/{img-uuid}.gif` | Branch logos. |

Available sizes: `100x80`, `143x118`, `300x200`, `600x400`, `600x600`, `1440x960`.
