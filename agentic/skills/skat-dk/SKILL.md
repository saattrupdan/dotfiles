---
name: skat-dk
description: skat.dk — the Danish Tax Agency's public citizen portal. Covers the nine top-level borger sections, URL & language conventions, TastSelv login launchers, on-site Cludo search, and internal APIs (Next.js JSON data feed, Cludo search API, sitemap). Use when looking up Danish tax topics, finding self-service launchers, navigating skat.dk's URL space, fetching content programmatically, or translating articles across languages.
last-updated: 2026-05-31
---

# skat.dk — Danish tax agency citizen portal

`https://skat.dk/` is the Danish Tax Agency's public website. The `/borger` subtree is the citizen-facing information layer (vs. `/erhverv` for businesses); both are anonymous and built on a Next.js front-end backed by an internal Umbraco Headless CMS. **Personal data and self-service forms live on `https://www.tastselv.skat.dk/`** (TastSelv) and require **MitID** or a legacy **TastSelv-kode**. There is no public read API for personal tax data.

Default page language is Danish; respond in Danish unless the user signals otherwise. Each Danish article has matching slugs in up to seven languages.

## The `skat` CLI — use this first

For everything programmatic — searching, reading page content/metadata, walking the navigation tree, finding language siblings, enumerating URLs — **use the `skat` CLI**. It wraps the three useful read surfaces (Next.js data feed, Cludo search, sitemap) so you should **not** fetch pages or call those APIs by hand. The CLI can be run from anywhere, no need to point at the skill directory:

```bash
skat <subcommand> [options]
```

### Prerequisites

Verify the CLI is installed:

```bash
which skat
```

If missing, install it editable with pipx (from the skill directory). First make sure pipx itself is available, then install:

```bash
# Ensure pipx is installed
which pipx || python3 -m pip install --user pipx
python3 -m pipx ensurepath

# Install the skat CLI
pipx install -e <path-to-skat-dk-skill>
```

After installing, confirm `skat` is on the PATH (you may need to restart the shell so `pipx ensurepath` takes effect):

```bash
which skat
```

Pure Python standard library — no extra dependencies. Each subcommand exits non-zero on HTTP error.

### Command reference

```bash
# Current Next.js buildId (rotates on every deploy; the other commands auto-detect it)
skat buildid

# Fetch a page's full JSON model from /_next/data/ (Danish default).
# Use this instead of curling /_next/data/...json by hand.
skat page borger/fradrag                          # Danish article
skat page individuals --locale en-us              # English mirror (locale: da-dk|en-us|de-de|uk|pl|ro|lt|kl)
skat page borger --field 'pageProps.content.page.childPages[].url'   # dotted extract — walk the tree
skat page borger/fradrag --field 'pageProps.content.page.pageLanguageVersions[].pageUrl'  # language siblings
skat page borger/fradrag --build-id <id>          # pin an explicit buildId

# Cludo on-site search across a skat.dk-family site.
# Use this instead of POSTing to the Cludo API by hand; /soeg HTML is NOT server-queryable.
skat search fradrag                               # SKAT / da (default)
skat search "tax deduction" --lang en             # English engine (--lang da|en|de)
skat search vurdering --site VURDST               # sister-site theme (see `skat engines`)
skat search fradrag -v                            # also print result descriptions
skat search fradrag --size 50 --page 2            # paginate (pageSize / page number)
skat search fradrag --facets Category             # request facets
skat search fradrag --engine 13369                # explicit engineId, overrides --site/--lang
skat search fradrag --raw                         # raw Cludo JSON response

# Cludo public engine settings (quicklinks, assistant config; no auth)
skat settings 13369                               # SKAT/da engine

# Print the Cludo customerId / engineId map (which --site/--lang -> engine)
skat engines
skat engines --raw                                # raw JSON

# Enumerate URLs from /sitemap.xml (all languages, single file)
skat sitemap --prefix /borger/ --limit 50         # filter by path prefix, cap results
```

`--raw` is available on `search` and `engines` for the unformatted JSON response. For ad-hoc reading of body copy, `skat page` returns the page model.

### Citizen section paths (values for `skat page <path>` and `skat sitemap --prefix`)

The nine top-level `/borger` sections. Use the path (without leading slash) as the `skat page` argument, or with a leading slash as `skat sitemap --prefix`:

| `skat page` path | `--prefix` value | Covers |
|---|---|---|
| `borger/aarsopgoerelse` | `/borger/aarsopgoerelse` | Annual tax return, refunds, residual tax (restskat). |
| `borger/forskudsopgoerelse` | `/borger/forskudsopgoerelse` | Preliminary assessment, tax cards (hovedkort/bikort/frikort). |
| `borger/fradrag` | `/borger/fradrag` | Deductions: kørsel, service-/håndværker-, kost & logi, rejse, gaver, etc. |
| `borger/bolig-og-ejendomme` | `/borger/bolig-og-ejendomme` | Property tax, ejendomsskat/-vurdering, rental income. |
| `borger/aktier-og-andre-vaerdipapirer` | `/borger/aktier-og-andre-vaerdipapirer` | Securities, crypto, gains/losses. |
| `borger/pension-og-efterloen` | `/borger/pension-og-efterloen` | Pensions, early retirement, ATP. |
| `borger/udlandsforhold` | `/borger/udlandsforhold` | Cross-border tax, double taxation, NT1/NT2/NT3. |
| `borger/b-indkomst` | `/borger/b-indkomst` | Self-employment / freelance income reporting. |
| `borger/deleoekonomi` | `/borger/deleoekonomi` | Sharing economy (Airbnb, GoMore, etc.). |

### Search site / engine values (for `skat search --site`/`--engine`, `skat settings <engine>`, `skat engines`)

`skat search --site <SITE>` selects a theme; `--lang da|en|de` picks the language variant. Run `skat engines` for the authoritative live map. The main themes and their engine IDs (used by `--engine` and `skat settings <engine>`):

| `--site` value | da | en | de | default |
|---|---|---|---|---|
| `SKAT` (default) | `13369` | `13460` | `13213` | `13514` |
| `TOLDST` | `13130` | `13212` | `13213` | `13130` |
| `MOTORST` | `13214` | `13215` | `13502` | `13214` |
| `VURDST` | `13217` | `13218` | `13219` | `13217` |
| `GAELDST` | `13220` | `13221` | `13222` | `13220` |

Additional da-only `--site` values: `SANST`, `SKM`, `SKTST`, `SKTFV`, `ADST`, `UFST`, `WEBGUIDE`, `ITTI`, `ZISE`, `LOTTERIREGLER`.

### Common citizen tasks

- **Find an article on a tax topic** → `skat search <topic>` (add `--lang en`/`--site` as needed), or `skat page borger/<section> --field 'pageProps.content.page.childPages[].url'` to browse a section's children.
- **Read in English/German** → `skat search "..." --lang en`, or pull language siblings: `skat page borger/<section> --field 'pageProps.content.page.pageLanguageVersions[].pageUrl'`.
- **List all citizen URLs** → `skat sitemap --prefix /borger/`.
- **Vehicle / customs / property / debt topic** → search the sister-site theme: `--site MOTORST | TOLDST | VURDST | GAELDST` (run `skat engines` for the full list).

## Out of scope

Personal tax data and self-service forms require MitID/TastSelv login at the website and are not covered by this skill.
