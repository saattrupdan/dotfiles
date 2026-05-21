---
name: boligsiden-dk
description: Denmark's largest property-listing aggregator. Covers the public HAL REST API, image CDN, URL conventions, and the Python CLI helper. Use when searching Danish properties, extracting listing details, or browsing by municipality/zip code.
last-updated: 2026-05-09
---

# boligsiden.dk — Danish property-listing aggregator

`https://www.boligsiden.dk/` aggregates listings from dozens of real estate agencies. The front-end is behind **Cloudflare Turnstile** — `WebFetch`-style scrapers receive a JS challenge page. **Always prefer the REST API over scraping.**

Default page language is Danish; respond in Danish unless the user signals otherwise.

## Homepage structure

- **Featured listings** — premium listings from realtors.
- **Popular cities** — quick links to major cities.
- **Search bar** — free-text search for addresses, cities, or keywords.
- **Property type filters** — villa, lejlighed, rækkehus, sommerhus, etc.

## URL conventions

- Listing: `https://www.boligsiden.dk/lejlighed/kobenhavn/...` or `https://home.dk/...`
- Realtor: `https://www.boligsiden.dk/ejendomsmægler/<slug>`
- Search: `https://www.boligsiden.dk/sog?query=<term>` (JS-driven)
- Municipality: `https://www.boligsiden.dk/kommune/<slug>`

## Internal REST API (HAL-style)

Base URL: `https://www.boligsiden.dk/api/`

### Authentication

None required. All endpoints are anonymous.

### Conventions

- **HAL format** — each resource has `_links.self.href`.
- **Pagination** — `_page` (1-indexed) and `_limit` query params.
- **Sorting** — `_sort` and `_order` (asc/desc).
- **Filtering** — query params matching resource fields.
- **Content-Type** — `application/json`.

### Resource endpoints

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

### `/api/cases` — Property listings

**Query parameters:**

| Param | Description |
|---|---|
| `_page` | Page number (1-indexed). Default: 1. |
| `_limit` | Items per page. Default: 20, max: 100. |
| `_sort` | Field to sort by (e.g. `priceCash`, `housingArea`, `daysOnMarket`). |
| `_order` | `asc` or `desc`. |
| `priceCash_min` / `priceCash_max` | Price range in DKK. |
| `housingArea_min` / `housingArea_max` | Living area in m². |
| `numberOfRooms_min` / `numberOfRooms_max` | Room count range. |
| `municipalityCode` | Municipality code (numeric). |
| `zipCode` | Postal code. |
| `addressType` | Property type: `villa`, `lejlighed`, `rækkehus`, `etagebolig`, `holiday house`, etc. |
| `isPublic` / `isOnMarket` | `true`/`false` visibility flags. |

**Response shape:** Each case contains `_links` (self, address, realtor, realtorBranch), pricing (`priceCash`, `perAreaPrice`), area metrics (`housingArea`, `lotArea`, `basementArea`), room counts, `yearBuilt`, `energyLabel`, boolean amenities (`hasBalcony`, `hasElevator`, `hasTerrace`), `daysOnMarket`, `descriptionTitle`/`descriptionBody`, `nextOpenHouse`, embedded `address` (with coordinates, municipality, province, building details), embedded `realtor` (name, rating, contact, branch), `images` and `floorPlanImages` arrays with `imageSources` objects containing CDN URLs and dimensions, and HAL pagination `_links`.

### `/api/addresses` — Address lookup

Search by street, city, or zip code (`q`, `_page`, `_limit`). Returns address UUID, type, road, house number, zip, municipality, province, and coordinates.

### Other endpoints

- **`/api/realtors`** — search by name or city (`q`, `_page`, `_limit`).
- **`/api/municipalities`** — list all municipalities with population and tax stats.
- **`/api/places`** — list cities, towns, districts.
- **`/api/zip_codes`** — list Danish postal codes.
- **`/api/floor_plans`** — floor plan images for properties.

## Image CDN

All images from `https://images.boligsiden.dk/`.

| Pattern | Description |
|---|---|
| `.../images/case/{case-uuid}/{W}x{H}/{img-uuid}.webp` | Listing photos. |
| `.../images/floor_plan_case/{case-uuid}/{W}x{H}/{img-uuid}.webp` | Floor plans. |
| `.../images/realtor_image/{realtor-uuid}/{W}x{H}/{img-uuid}.webp` | Realtor photos. |
| `.../images/realtor_branch/{branch-uuid}/{W}x{H}/{img-uuid}.gif` | Branch logos. |

Available sizes: `100x80`, `143x118`, `300x200`, `600x400`, `600x600`, `1440x960`.

## Common tasks

- **Search by criteria**: query `/api/cases` with filters.
- **Single listing**: fetch `/api/cases/{uuid}`.
- **Browse by city**: `/api/cases?zipCode=2100` or `?municipalityCode=101`.
- **Find realtor**: `/api/realtors?q=<name|city>`.
- **Lookup address**: `/api/addresses?q=<street>+<city>`.
- **Get images**: construct URLs from `images[*].imageSources[*].url`.
- **Get floor plans**: construct from `floorPlanImages[*].imageSources[*].url`.

## Helper script

`boligsiden_dk_api.py` (in this folder) wraps common API queries. Standard library only.

```bash
python3 boligsiden_dk_api.py cases --limit 5                    # latest 5 listings
python3 boligsiden_dk_api.py cases --min-price 2000000          # properties over 2M DKK
python3 boligsiden_dk_api.py cases --city "København" --limit 3
python3 boligsiden_dk_api.py cases --municipality-code 101      # København
python3 boligsiden_dk_api.py cases --type villa                 # only villas
python3 boligsiden_dk_api.py cases --min-rooms 4 --limit 10
python3 boligsiden_dk_api.py address "strandvejen 42 københavn"
python3 boligsiden_dk_api.py realtor "edc" --limit 5
python3 boligsiden_dk_api.py municipalities                     # all municipalities
python3 boligsiden_dk_api.py raw cases query.json               # POST raw query body
```

Each subcommand exits non-zero on HTTP error and writes the response body to stderr.
