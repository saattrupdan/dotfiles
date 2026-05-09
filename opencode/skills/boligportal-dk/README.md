# boligportal-dk

Reference for navigating boligportal.dk — Denmark's largest rental housing marketplace (~14,700 listings). Anonymous browsing is fully open; favorites, messaging, and ad creation require login.

## Requirements

- `boligportal_dk_api.py` CLI helper — standard library only
- Internet access to `www.boligportal.dk`
- English mirror at `/en/` for most pages

## Quick Start

```bash
# Browse rental apartments in Copenhagen
open https://www.boligportal.dk/lejligheder/k%C3%B8benhavn/

# Browse student housing
open https://www.boligportal.dk/studieboliger-k%C3%B8benhavn/c/

# View a specific listing
open https://www.boligportal.dk/lejligheder/k%C3%B8benhavn/58m2-2-vaer-id-5621440

# English mirror
open https://www.boligportal.dk/en/rental-apartments/k%C3%B8benhavn/

# Favorites (login required)
open https://www.boligportal.dk/favoritter/

# CLI: search apartments in Copenhagen
python3 boligportal_dk_api.py search --city k%C3%B8benhavn --type apartment --limit 5

# CLI: search with price and area filters
python3 boligportal_dk_api.py search --city odense --min-rooms 2 --min-price 5000 --max-price 10000

# CLI: view map data for Aarhus listings
python3 boligportal_dk_api.py map --city aarhus --type student --limit 10

# CLI: top favorite listings
python3 boligportal_dk_api.py top-favorites --limit 5

# CLI: sponsored/promoted listings
python3 boligportal_dk_api.py promoted --city k%C3%B8benhavn

# CLI: raw POST to any endpoint
python3 boligportal_dk_api.py raw listing/listings '{"page":0,"pageSize":5,"filter":{"cityCode":"k%C3%B8benhavn"}}'
```

## Navigation Reference

### Categories

| Category | Danish URL | English URL |
|---|---|---|
| All rentals | `/lejeboliger/` | `/en/rental-properties/` |
| Apartments | `/lejligheder/` | `/en/rental-apartments/` |
| Rooms | `/v%C3%A6relser/` | `/en/rental-rooms/` |
| Student housing | `/studieboliger-<city>/c/` | `/en/student-housing-<city>/c/` |
| Townhouses | `/r%C3%A6kkehuse/` | `/en/rental-townhouse/` |
| Houses | `/huse/` | `/en/rental-houses/` |

### Listing URL pattern

`/<category>/<city>/<size>m2-<rooms>vaer-id-<id>`

Examples: `/lejligheder/k%C3%B8benhavn/58m2-2-vaer-id-5621440`, `/huse/gr%C3%A6sted/158m2-6-vaer-id-4089074`

### Pagination

Hub pages paginate with `?offset=<N>` (18 items per page). No page numbers.

### Specialty filters

| Filter | URL |
|---|---|
| Elderly housing | `/ældreboliger/c/` |
| Social housing | `/almene-boliger/c/` |
| Shared apartments | `/delelejligheder/c/` |
| Pet-friendly | `/lejeboliger-med-husdyr-tilladt/c/` |
| New listings | Add `?newbuild=1` to any hub |

### Internal JSON API

All endpoints are **POST-only** at `https://www.boligportal.dk/api/`. No auth for search:

| Endpoint | Purpose |
|---|---|
| `POST /api/listing/listings/` | Search listings (filter by city, type, price, area) |
| `POST /api/search/map` | Map-view listings with lat/lng |
| `POST /api/search/promoted-ads` | Sponsored listings |
| `POST /api/listing/favorites/` | Favorites (requires login) |
| `POST /api/listing/top-favorite-ads/` | Most-favorited listings (anonymous) |
| `POST /api/login` | Authenticate |

## CLI Reference

```bash
# Search listings with filters
python3 boligportal_dk_api.py search --city k%C3%B8benhavn --type apartment --min-rooms 2 --min-price 5000

# Map-view listings with coordinates
python3 boligportal_dk_api.py map --city aarhus --type student

# Sponsored/promoted listings
python3 boligportal_dk_api.py promoted --city odense

# Top favorited listings
python3 boligportal_dk_api.py top-favorites --limit 10

# Raw POST to any API endpoint
python3 boligportal_dk_api.py raw listing/listings '{"page":0,"pageSize":5}'
```

All commands support `--raw` for unformatted JSON output.

## Troubleshooting

- **No global text search** — discovery is by category, city, and specialty filters only.
- **No sitemap.xml** — enumerate listings by paginating hub pages (`?offset=0`, `?offset=18`, …).
