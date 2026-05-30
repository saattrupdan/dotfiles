---
name: bolig-dk
description: Danish housing listings — rentals (boligportal.dk) and for-sale homes (boligsiden.dk). Provides the `bolig` CLI for searching listings, addresses, realtors, and municipalities, plus documented internal/public APIs and URL conventions. Use when searching Danish rental or for-sale properties, browsing by city/municipality/zip, or querying the sites' APIs.
last-updated: 2026-05-30
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
# Search apartments in Copenhagen
bolig rent search --city kobenhavn --type apartment --limit 5

# Filter by rooms and price
bolig rent search --city odense --min-rooms 2 --min-price 5000 --max-price 10000

# Map-view listings with coordinates
bolig rent map --city aarhus --type student --limit 10

# Sponsored / promoted listings
bolig rent promoted --city kobenhavn

# Most-favorited listings across all users
bolig rent top-favorites --limit 5

# Raw POST to any endpoint
bolig rent raw listing/listings '{"page":0,"pageSize":5,"filter":{"cityCode":"kobenhavn"}}'
```

`--type` values: `apartment`, `room`, `house`, `townhouse`, `student`. `--city` takes the URL slug (e.g. `kobenhavn`, `aarhus`, `odense`).

### Auth model

| Surface (`bolig rent ...`) | Endpoint | Auth |
|---|---|---|
| `search` | `POST /api/listing/listings/` | Session-bound (redirects to `/login` without a cookie, as of 2026-05) |
| `promoted` | `POST /api/search/promoted-ads` | Anonymous |
| `map` | `POST /api/search/map` | Unavailable (HTTP 500, as of 2026-05) |
| `top-favorites` | `POST /api/listing/top-favorite-ads/` | Session-bound |

The `search` command surfaces an authentication error and exits non-zero when no session cookie is present; `promoted` works anonymously.

## `bolig buy` — for-sale (boligsiden.dk)

```bash
# Latest 5 listings
bolig buy cases --limit 5

# Properties over 2M DKK in Copenhagen
bolig buy cases --min-price 2000000 --city "København"

# Only villas with at least 4 rooms
bolig buy cases --type villa --min-rooms 4 --limit 10

# Filter by municipality code (101 = København)
bolig buy cases --municipality-code 101

# Look up an address
bolig buy address "strandvejen 42 københavn"

# Search real estate agencies
bolig buy realtor "edc" --limit 5

# List all municipalities with population
bolig buy municipalities

# POST a raw query body (from a file) to an endpoint
bolig buy raw cases query.json
```

`--type` values: `villa`, `lejlighed`, `rækkehus`, `etagebolig`, `holiday house`, etc. `--city` accepts a name (mapped to a zip via a built-in table) or a numeric zip; use `--zip-code`/`--municipality-code` for precision.

**Note:** boligsiden's front-end and REST API are both behind **Cloudflare Turnstile**. Unauthenticated non-browser clients receive a JS challenge (403) or an HTML redirect. The CLI detects this and exits non-zero with a descriptive error — it cannot bypass the challenge.

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

### Internal JSON API

Base URL: `https://www.boligportal.dk/api/`. All endpoints are **POST-only** — `GET` returns an error. No API key for anonymous endpoints; session cookies for account-scoped ones.

Image URLs: `https://image-lambda.boligportal.dk/<hash>?auto=compress,enhance,format&w=<W>&h=<H>&fit=crop&crop=focalpoint`

#### `POST /api/listing/listings/` (session-bound)

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

- **No global text-search bar** — discovery is by category, city, and specialty filters.
- **No `/sitemap.xml`** (404) — enumerate via hub pages with `?offset=N` (18/page).
- **Listing detail pages are full HTML** — no `/api/article/<id>`-style resource.

---

## boligsiden.dk reference (for-sale)

`https://www.boligsiden.dk/` aggregates listings from dozens of real estate agencies. Both the front-end and REST API are behind **Cloudflare Turnstile** (see CLI note above).

### URL conventions

- Listing: `https://www.boligsiden.dk/lejlighed/kobenhavn/...` or `https://home.dk/...`
- Realtor: `https://www.boligsiden.dk/ejendomsmægler/<slug>`
- Search: `https://www.boligsiden.dk/sog?query=<term>` (JS-driven)
- Municipality: `https://www.boligsiden.dk/kommune/<slug>`

### Internal REST API (HAL-style)

Base URL: `https://www.boligsiden.dk/api`. No API key required. Conventions:

- **HAL format** — each resource has `_links.self.href`.
- **Pagination** — `_page` (1-indexed) and `_limit` (default 20, max 100).
- **Sorting** — `_sort` (e.g. `priceCash`, `housingArea`, `daysOnMarket`) and `_order` (`asc`/`desc`).
- **Filtering** — query params matching resource fields.

| Endpoint | Description |
|---|---|
| `/api/cases` | Property listings (primary resource). |
| `/api/addresses` | Address lookup by street, city, or zip. |
| `/api/realtors` | Real estate agency profiles. |
| `/api/realtor_branches` | Branch offices. |
| `/api/municipalities` | Danish municipalities with stats. |
| `/api/places` | Cities, towns, districts. |
| `/api/zip_codes` | Danish postal codes. |
| `/api/floor_plans` | Floor plan images. |

#### `/api/cases` query parameters

| Param | Description |
|---|---|
| `_page` / `_limit` | Pagination (1-indexed; default 20, max 100). |
| `_sort` / `_order` | Sort field and direction. |
| `priceCash_min` / `priceCash_max` | Price range in DKK. |
| `housingArea_min` / `housingArea_max` | Living area in m². |
| `numberOfRooms_min` / `numberOfRooms_max` | Room count range. |
| `municipalityCode` | Municipality code (numeric). |
| `zipCode` | Postal code. |
| `addressType` | Property type: `villa`, `lejlighed`, `rækkehus`, `etagebolig`, `holiday house`, etc. |
| `isPublic` / `isOnMarket` | `true`/`false` visibility flags. |

Each case contains `_links` (self, address, realtor, realtorBranch), pricing (`priceCash`, `perAreaPrice`), area metrics (`housingArea`, `lotArea`, `basementArea`), room counts, `yearBuilt`, `energyLabel`, boolean amenities (`hasBalcony`, `hasElevator`, `hasTerrace`), `daysOnMarket`, `descriptionTitle`/`descriptionBody`, `nextOpenHouse`, embedded `address` (coordinates, municipality, province, building details), embedded `realtor` (name, rating, contact, branch), and `images`/`floorPlanImages` arrays with `imageSources` (CDN URLs + dimensions).

#### Other endpoints

- `/api/addresses?q=<street>+<city>&_limit=N` — returns address UUID, type, road, house number, zip, municipality, province, coordinates.
- `/api/realtors?q=<name|city>` — agency search.
- `/api/municipalities?_limit=200` — all municipalities with population and tax stats.
- `/api/places`, `/api/zip_codes`, `/api/floor_plans`.

### Image CDN

All images from `https://images.boligsiden.dk/`:

| Pattern | Description |
|---|---|
| `.../images/case/{case-uuid}/{W}x{H}/{img-uuid}.webp` | Listing photos. |
| `.../images/floor_plan_case/{case-uuid}/{W}x{H}/{img-uuid}.webp` | Floor plans. |
| `.../images/realtor_image/{realtor-uuid}/{W}x{H}/{img-uuid}.webp` | Realtor photos. |
| `.../images/realtor_branch/{branch-uuid}/{W}x{H}/{img-uuid}.gif` | Branch logos. |

Available sizes: `100x80`, `143x118`, `300x200`, `600x400`, `600x600`, `1440x960`.
