# bolig-dk

Reference and CLI for Danish housing listings, covering two complementary sources:

- **boligportal.dk** — Denmark's largest **rental** housing marketplace (`bolig rent ...`).
- **boligsiden.dk** — the **for-sale** property-listing aggregator (`bolig buy ...`).

## Requirements

- Python 3.12+ for the CLI helper (standard library only).
- Internet access to `www.boligportal.dk` and `www.boligsiden.dk`.
- boligsiden's site and API are behind Cloudflare Turnstile; the CLI cannot bypass the challenge (it exits non-zero with a clear error).
- boligportal's `search` (incl. keyword body search) works **anonymously** via the public hub pages; `top-favorites` is session-bound; `promoted` works anonymously.

## CLI

Install it editable with pipx (`pipx install -e <path-to-bolig-dk-skill>`), then run it from anywhere:

```bash
# --- Rentals (boligportal.dk) ---
bolig rent search --city aarhus --type apartment --limit 5
bolig rent search --city odense --min-rooms 2 --min-price 5000 --max-price 10000
bolig rent search --city aarhus --type apartment -k badekar     # body keyword search
bolig rent search --city kobenhavn -k altan -k elevator         # all keywords required
bolig rent map --city aarhus --type student --limit 10
bolig rent promoted --city kobenhavn
bolig rent top-favorites --limit 5
bolig rent raw listing/listings '{"page":0,"pageSize":5}'

# --- For-sale (boligsiden.dk) ---
bolig buy cases --limit 5
bolig buy cases --min-price 2000000 --city "København"
bolig buy cases --type villa --min-rooms 4 --limit 10
bolig buy cases --city "København" -k badekar                   # body keyword search
bolig buy cases --municipality-code 101
bolig buy address "strandvejen 42 københavn"
bolig buy realtor "edc" --limit 5
bolig buy municipalities
bolig buy raw cases query.json
```

Every command supports `--raw` for unformatted JSON output. See `SKILL.md` for the full API reference, URL conventions, and image CDN patterns.

## Files

- **SKILL.md** — full reference for both sources: CLI usage, URL conventions, APIs, auth models, and image CDNs.
- **bolig_dk/** — the `bolig` CLI package (standard library only).
- **pyproject.toml** — package metadata and the `bolig` entry point.

## Troubleshooting

- **Keyword search (`-k`) finds nothing** — the term may genuinely be rare in the scanned set; raise `--max-scan` (rent default 100, buy default 200) or loosen filters. For rent, each scanned listing costs one detail-page fetch, so large scans take a while.
- **`bolig buy ...` returns a Cloudflare error** — the boligsiden API blocks non-browser clients; there is no anonymous bypass.
- **City not found for `bolig buy cases --city`** — the city isn't in the built-in zip map; pass `--zip-code` or `--municipality-code` instead.
