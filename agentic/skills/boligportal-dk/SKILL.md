---
name: boligportal-dk
description: boligportal.dk — Denmark's largest rental housing marketplace. Covers property search (listings, map, promoted ads, top favorites), URL patterns, and English mirror. Use when searching Danish rental properties, browsing listings by city/type, or querying the site's anonymous search APIs.
last-updated: 2026-05-29
---

# boligportal.dk — Danish rental housing marketplace

Denmark's largest rental housing marketplace. Anonymous browsing is open; favorites, messaging, and ads require **login** (email-based). Respond in Danish unless the user has signalled otherwise.

All URLs relative to `https://www.boligportal.dk/`. Slugs use **URL-encoded Danish letters** (`æ` → `%C3%A6`, `ø` → `%C3%B8`, `å` → `%C3%A5`).

## English mirror

Mirror at `/en/` mirrors Danish structure. Main hubs: `/lejeboliger/` → `/en/rental-properties/`, `/lejligheder/` → `/en/rental-apartments/`, `/v%C3%A6relser/` → `/en/rental-rooms/`, `/studieboliger-<city>/c/` → `/en/student-housing-<city>/c/`, `/r%C3%A6kkehuse/` → `/en/rental-townhouse/`, `/huse/` → `/en/rental-houses/`. Favorites: `/favoritter/` → `/en/favourites/`, Inbox: `/indbakke/` → `/en/inbox/`. Listing slugs follow the same pattern in both languages.

## Property categories

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

### City drill-downs

Hub pages list cities alphabetically. Key: `aabenraa`, `aalborg`, `aarhus`, `esbjerg`, `fredericia`, `haderslev`, `herning`, `holstebro`, `horsens`, `k%C3%B8benhavn`, `kolding`, `kalundborg`, `n%C3%A6stved`, `nyborg`, `odense`, `randers`, `ringk%C3%B8bing`, `roskilde`, `silkeborg`, `skive`, `slagelse`, `svendborg`, `vejle`, `viborg`. Copenhagen neighborhoods: `k%C3%B8benhavn-%C3%B8/`, `k%C3%B8benhavn-n/`, `k%C3%B8benhavn-s/`, `k%C3%B8benhavn-sv/`, `hedehusene`.

## Listing URL pattern

`/<category>/<city>/<size>m2-<rooms>vaer-id-<id>`

Example: `/lejligheder/k%C3%B8benhavn/58m2-2-vaer-id-5621440` — apartment, Copenhagen, 58m², 2 rooms.

## Logged-in features

Favorites: `/favoritter/`, Inbox: `/indbakke/`, Create ad: `/property-owner/rent/create`, Manage listings: `/udlejer/mine-boliger/`.

## Footer / legal

About: `/om-os` → `/en/about-us`, Terms: `/vilk%C3%A5r` → `/en/terms`, Privacy: `/privatlivspolitik` → `/en/privacy`, Cookies: `/cookiepolitik` → `/en/cookie-policy`, Imprint: `/en/imprint`, Sublease: `/fremlej-lejebolig` → `/en/sublet-your-rental-property`, Support: `support.boligportal.dk/hc/{da,en-us}`.

## Limits worth flagging

- **No global text-search bar**. Discovery is by category, city, and specialty filters.
- **No public API documentation**. Internal APIs are undocumented and subject to change.
- **Listing detail pages are full HTML** — no `/api/article/<id>`-style resource.
- **Favorites and messaging are session-bound**. No public API to read another user's data.
- **Offset-based pagination** (`?offset=N`), 18 items per page.

## Auth model

| Surface | Auth |
|---|---|
| Search / listings (`/api/listing/listings/`) | Session-bound (as of 2026-05) |
| Promoted ads (`/api/search/promoted-ads`) | Anonymous |
| Map (`/api/search/map`) | Unavailable (HTTP 500, as of 2026-05) |
| Top favorites (`/api/listing/top-favorite-ads/`) | Session-bound (as of 2026-05) |
| Favorites | Session-bound |
| Messaging | Session-bound |
| Account / profile | Session-bound |
| Payments | Session-bound |

## Internal JSON API

Base URL: `https://www.boligportal.dk/api/`. All endpoints are **POST-only** — `GET` returns an error. No API key required for anonymous endpoints; session cookies for account-scoped ones.

Image URLs: `https://image-lambda.boligportal.dk/<hash>?auto=compress,enhance,format&w=<W>&h=<H>&fit=crop&crop=focalpoint`
Static assets: `https://dnejt4xibfee2.cloudfront.net/static/dist/`

### Search listings `POST /api/listing/listings/` (session-bound)

Backs the main listing hub pages. Returns paginated listing data. **Note:** as of 2026-05 this endpoint redirects to `/login` without a valid session cookie.

**Request**:
```json
{
  "page": 0,
  "pageSize": 18,
  "filter": {
    "cityCode": "k%C3%B8benhavn",
    "propertyType": "apartment",
    "minArea": 40,
    "maxArea": 100,
    "minRooms": 2,
    "minPrice": 5000,
    "maxPrice": 12000,
    "newBuild": false,
    "studentHousing": false
  }
}
```
Omitted filter fields are unconstrained. `cityCode` maps to the URL slug. `propertyType` values: `"apartment"`, `"room"`, `"house"`, `"townhouse"`, `"student"`.

**Response**:
```json
{
  "total": 342,
  "items": [
    {
      "id": 5621440,
      "title": "Hybo lejlighed på 58 m2",
      "price": 8500,
      "area": 58,
      "rooms": 2,
      "city": "København",
      "imageUrl": "https://image-lambda.boligportal.dk/...",
      "url": "/lejligheder/k%C3%B8benhavn/58m2-2-vaer-id-5621440",
      "isNew": true,
      "isFavorite": false
    }
  ]
}
```

### Map listings `POST /api/search/map` (unavailable)

Same filter shape as `/api/listing/listings/`. Returns listings with `lat`/`lng` coordinates for map pins. **Note:** as of 2026-05 this endpoint returns HTTP 500.

### Promoted ads `POST /api/search/promoted-ads` (anonymous)

Featured listings at top of search results. Request: `{"filter": {"cityCode": "<optional>"}}`.

**Response** (uses `ads` array and snake_case field names):
```json
{
  "ads": [
    {
      "id": 5621440,
      "title": "Hybo lejlighed på 58 m2",
      "monthly_rent": 8500.0,
      "city": "København",
      "url": "/lejligheder/k%C3%B8benhavn/58m2-2-vaer-id-5621440"
    }
  ],
  "more_promoted_ads": false
}
```

### Top favorites `POST /api/listing/top-favorite-ads/` (session-bound)

Most-favorited listings across all users. Request: `{"limit": 10}`. **Note:** as of 2026-05 this endpoint redirects to `/login` without a valid session cookie.

### Favorites `POST /api/listing/favorites/` (session-bound)

CRUD for user's favorites. List: POST with empty body. Add/remove: `POST /api/listing/favorites/<id>` with `{"favorite": true/false}`.

### Auth `POST /api/login`

Body: `{"email": "...", "password": "..."}`. Sets session cookies, returns user profile.

### Sitemap & enumeration

No `/sitemap.xml` (returns 404). Enumerate via hub pages with `?offset=N` or use `/api/listing/listings/` with pagination. City pages are discoverable from hub pages.
