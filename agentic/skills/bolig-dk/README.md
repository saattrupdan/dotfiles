# bolig-dk

Reference and CLI for Danish housing listings, covering two complementary sources:

- **boligportal.dk** — Denmark's largest **rental** housing marketplace (`bolig rent ...`).
- **boligsiden.dk** — the **for-sale** property-listing aggregator (`bolig buy ...`).

## Requirements

- Python 3.12+ for the CLI helper (standard library only).
- Internet access to `www.boligportal.dk` and `api.boligsiden.dk`.
- boligsiden's www site and `/api/` are behind a Cloudflare managed challenge; the CLI sidesteps it by using the ungated data host `api.boligsiden.dk` (the same one `bolig-ping` uses).
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

# --- For-sale (boligsiden.dk, via api.boligsiden.dk) ---
bolig buy cases --limit 5
bolig buy cases --min-price 2000000 --municipality københavn    # whole city = municipality
bolig buy cases --type villa --min-rooms 4 --limit 10
bolig buy cases --type lejlighed --min-floor 0 --max-floor 0     # ground floor (stueetage) — use the filter, not -k stue
bolig buy cases --city frederiksberg -k badekar                 # body keyword search (first ~500 chars)
bolig buy cases --city frederiksberg -k badekar --deep          # full-text search via agency pages
bolig buy cases --zip-code 2000
bolig buy address strandvejen                                   # road-name prefix
bolig buy realtor københavn --location-type municipality
bolig buy municipalities
bolig buy raw search/cases "page=1&cities=frederiksberg"
```

Every command supports `--raw` for unformatted JSON output. See `SKILL.md` for the full API reference, URL conventions, and image CDN patterns.

## Files

- **SKILL.md** — full reference for both sources: CLI usage, URL conventions, APIs, auth models, and image CDNs.
- **bolig_dk/** — the `bolig` CLI package (standard library only).
- **pyproject.toml** — package metadata and the `bolig` entry point.

## Troubleshooting

- **Keyword search (`-k`) finds nothing** — for `buy`, boligsiden caps `descriptionBody` at ~500 chars, so terms buried deep in a description (often `badekar`) are missed; common features like `altan` appear early and match. Add `--deep` to also read each candidate's full description from the agency page (one fetch per non-matching candidate, bounded by `--max-scan`); fetches run concurrently — tune with `--deep-workers N` (default 8). For `rent`, the term may be rare in the scanned set; raise `--max-scan` (rent default 100, buy default 200). Each scanned `rent` listing costs one detail-page fetch, so large scans take a while.
- **`bolig buy cases --city københavn` returns 0** — whole big cities are *municipalities*, not city slugs. Use `--municipality københavn` (or `--zip-code`); `--city` is for districts like `frederiksberg` or `aarhus c`.
