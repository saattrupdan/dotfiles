# boligsiden.dk Skill

Agent skill for [boligsiden.dk](https://www.boligsiden.dk/) — Denmark's largest property-listing aggregator.

## Files

- **SKILL.md** — Full reference: homepage layout, URL conventions, the public HAL REST API (all endpoints, response shapes, filtering), image CDN patterns, and common task recipes.
- **boligsiden_dk_api.py** — Python CLI helper wrapping the most common API queries. Standard library only.

## Quick start

```bash
# List latest 5 property listings
python3 boligsiden_dk_api.py cases --limit 5

# Properties over 2 million DKK in Copenhagen
python3 boligsiden_dk_api.py cases --min-price 2000000 --city "København"

# Only villas with at least 4 rooms
python3 boligsiden_dk_api.py cases --type villa --min-rooms 4 --limit 10

# Look up a specific address
python3 boligsiden_dk_api.py address "strandvejen 42 københavn"

# Search real estate agencies
python3 boligsiden_dk_api.py realtor "edc" --limit 5

# List all Danish municipalities with population
python3 boligsiden_dk_api.py municipalities
```

## Key facts

- The website is behind Cloudflare — **always prefer the REST API** for programmatic access.
- The API is **fully anonymous** — no authentication, no API key needed.
- All responses are in **HAL format** with `_links.self.href` on each resource.
- Pagination uses `_page` and `_limit` query parameters.
