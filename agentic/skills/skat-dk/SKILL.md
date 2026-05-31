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

`--raw` is available on `search` and `engines` for the unformatted JSON response. For ad-hoc reading of body copy, `skat page` returns the page model, but the rendered HTML at the article URL is often easier than walking the block grid (see reference below).

### Common citizen tasks

- **Find an article on a tax topic** → `skat search <topic>` (add `--lang en`/`--site` as needed), or `skat page borger/<section> --field 'pageProps.content.page.childPages[].url'` to browse a section's children.
- **Read in English/German** → `skat search "..." --lang en`, or pull `pageLanguageVersions` from `skat page ... --field`.
- **List all citizen URLs** → `skat sitemap --prefix /borger/`.
- **Vehicle / customs / property / debt topic** → search the sister-site theme: `--site MOTORST | TOLDST | VURDST | GAELDST` (run `skat engines` for the full list).
- **Satser table or paper form** → link into `https://info.skat.dk/data.aspx?oid=<n>` (legal/satser) or `https://info.skat.dk/getfile.aspx?id=<n>` (PDF).

## Website navigation — TastSelv / MitID login launchers

The skat.dk public site is anonymous and the **CLI cannot log in** — personal tax data and self-service forms are only reachable by navigating the site interactively. The three login buttons in the topbar all redirect through `vent.skat.dk` (queue-bypass) into TastSelv:

| Button | URL |
|---|---|
| **Log på med MitID** | `https://vent.skat.dk/?c=skat&e=prod250303login&t=https%3A%2F%2Fwww.tastselv.skat.dk%2Fborger%2Floginsso` |
| **Log på med TastSelv-kode** | `https://vent.skat.dk/?c=skat&e=prod260306login&t=https%3A%2F%2Fwww.tastselv.skat.dk%2Fborger%2Floginpin` |
| **Log på med autorisation** (parent / advisor / guardian) | `https://vent.skat.dk/?c=skat&e=prod260306aut` |

The `e=prodNNNNNN…` campaign IDs rotate periodically — re-fetch the home page topbar `<a href>` if stale. Prefer linking `vent.skat.dk` (handles outage protection) rather than `tastselv.skat.dk` directly; never deep-link `tastselv.skat.dk` paths, which are session-bound.

> **Limit**: TastSelv is interactive, MitID-bound, and JavaScript-heavy. No public read API for personal tax data.

## What you cannot do

- **No personal tax data.** All citizen data is in TastSelv behind MitID; the CLI is read-only public content.
- **No Cludo admin access.** Only `publicsettings` (`skat settings`) is public.
- **No bulk body-text export.** Use `skat sitemap` + the rendered HTML. `skat page` is best for metadata/navigation/language siblings.
- **No documented contract.** Endpoints are inferred and may break on deploy.

---

## Reference: site structure & underlying APIs

The CLI wraps the surfaces below; consult this section only when you need a path the CLI doesn't expose, or when picking a `skat page` path / decoding a `--raw` response.

### Top-level citizen sections (handy for choosing a `skat page` path)

| Section | URL | Covers |
|---|---|---|
| Årsopgørelse | `/borger/aarsopgoerelse` | Annual tax return, refunds, residual tax (restskat). |
| Forskudsopgørelse | `/borger/forskudsopgoerelse` | Preliminary assessment, tax cards (hovedkort/bikort/frikort). |
| Fradrag | `/borger/fradrag` | Deductions: kørsel, service-/håndværker-, kost & logi, rejse, gaver, etc. |
| Bolig og ejendomme | `/borger/bolig-og-ejendomme` | Property tax, ejendomsskat/-vurdering, rental income. |
| Aktier og andre værdipapirer | `/borger/aktier-og-andre-vaerdipapirer` | Securities, crypto, gains/losses. |
| Pension og efterløn | `/borger/pension-og-efterloen` | Pensions, early retirement, ATP. |
| Udlandsforhold | `/borger/udlandsforhold` | Cross-border tax, double taxation, NT1/NT2/NT3. |
| B-indkomst | `/borger/b-indkomst` | Self-employment / freelance income reporting. |
| Deleøkonomi | `/borger/deleoekonomi` | Sharing economy (Airbnb, GoMore, etc.). |

### URL & slug conventions

- Tree root: `/borger`. Articles: `/borger/<section>/<topic>[/<subtopic>]`.
- Slugs spell out Danish letters (`æ`→`ae`, `ø`→`oe`, `å`→`aa`). For `skat page`, drop the locale prefix (e.g. `borger/fradrag`, or `individuals` for `en-us`).
- `<link rel="alternate" hreflang="...">` per available language; not every article has every translation.
- `/soeg` has no server-side query param — search resolves client-side via the URL hash; use `skat search` instead.
- Sister sites (info.skat.dk, motorst.dk, toldst.dk, vurderingsportalen.dk, skm.dk) share the same Next.js + Umbraco platform and Cludo search.

### Language mirrors (top-level roots)

| `hreflang` | Root | Notes |
|---|---|---|
| `da-dk` | `/borger` | Default, full content |
| `en-us` | `/en-us/individuals` | Most-translated mirror |
| `de-de` | `/de-de/buerger` | Sizable subset |
| `uk` | `/uk/osobi` | Ukrainian — narrow subset |
| `pl` | `/pl/osoby-fizyczne` | Polish — narrow subset |
| `ro` | `/ro/persoana-fizica` | Romanian — narrow subset |
| `lt` | `/lt/privatus-asmenys` | Lithuanian — narrow subset |
| `kl` | `/kl/innuttaasoq` | Greenlandic — narrow subset |

Language siblings are most reliably read from `pageLanguageVersions` in the page model (`skat page ... --field 'pageProps.content.page.pageLanguageVersions[].pageUrl'`).

### Stack overview

Next.js front-end at `skat.dk` (build ID rotates on every deploy), Umbraco Headless CMS (server-side only, not publicly reachable), Cludo search (third-party), NextAuth.js (narrow internal flows only), TastSelv portal (separate ASPX-style app, out of scope). No documented OpenAPI; treat everything as undocumented and subject to change.

### Next.js data feed — `/_next/data/<buildId>/<locale>/<path>.json` (wrapped by `skat page`)

Every page has a sibling JSON URL returning the full page model used for client-side hydration. Response shape:

```json
{
  "pageProps": {
    "content": { "page": { /* page model */ } },
    "dictionary": { /* site-wide translations */ },
    "site": { "settings": "...", "siteNavigationItems": "...", "theme": "SKAT" },
    "host": "skat.dk"
  },
  "__N_SSG": true
}
```

`pageProps.content.page` highlights:
- `documentType` — Umbraco doctype (`transportPage`, `campaignPage`, `articlePage`, `searchPage`, …).
- `pageLanguageVersions` — `{cultureName, pageUrl}` array. Best source for language siblings.
- `properties` — `heading`, `description`, `pageSection.items` (block grid of components), `transportLinkItems`, `subject`, `author`, …
- `childPages` — direct children with `name` and `url` (great for tree-walking navigation).

Editorial body copy lives inside the block grid (`properties.pageSection.items[*].content.properties…`); for ad-hoc reading, the rendered HTML is easier than walking the block tree. `buildId` rotates on deploy and older IDs 404 — `skat` auto-detects it, or override with `--build-id`.

### Cludo search — `https://api.cludo.com/api/v3/<customerId>/<engineId>/...` (wrapped by `skat search` / `settings` / `engines`)

On-site search is fully delegated to Cludo. customerId `2073` for all sites. `skat engines` prints the full engineId map; the main themes:

| Site / theme | da | en | de | other |
|---|---|---|---|---|
| SKAT (skat.dk) | `13369` | `13460` | `13213` | default `13514` |
| TOLDST (toldst.dk) | `13130` | `13212` | `13213` | default `13130` |
| MOTORST (motorst.dk) | `13214` | `13215` | `13502` | default `13214` |
| VURDST | `13217` | `13218` | `13219` | default `13217` |
| GAELDST | `13220` | `13221` | `13222` | default `13220` |

(da-only themes also exist: SANST, SKM, SKTST, SKTFV, ADST, UFST, WEBGUIDE, ITTI, ZISE, LOTTERIREGLER.) If mappings rotate, re-extract from chunk files (search for `case"SKAT":if("da"===t)return"13369"`).

- **`POST /api/v3/{customerId}/{engineId}/search`** — auth `Authorization: SiteKey <base64>` where `<base64>` = `base64("<customerId>:<engineId>:SearchKey")` (SKAT/da: `MjA3MzoxMzM2OTpTZWFyY2hLZXk=`). Body `{"query": "...", "page": 1, "pageSize": 10, "facets": ["Category"], "filters": []}`. Response top-level keys: `TypedDocuments`, `TopHits`, `TotalDocument` (singular — Cludo quirk), `Suggestions`, `Facets`, `Banners`, `FixedQuery`, `ResponseTime`, `QueryId`, `GenerativeAnswerAvailable`. Each `TypedDocuments` entry has `Fields.Title.Value`, `Fields.Description.Value`, `Fields.Url.Value`. `query` supports Cludo operators (`+term`, `"exact phrase"`, `-exclude`).
- **`GET /websites/publicsettings`** (no auth) — engine list, quicklinks (curated query→URL pairs), assistant config, instant-suggestions.
- Other: `POST /search/pushstat` (analytics, write-only), `GET /search/autocomplete` (typeahead, same SiteKey auth).

### Sitemap — `https://skat.dk/sitemap.xml` (wrapped by `skat sitemap`)

Single XML file. Each `<url>` has `<loc>`, `<lastmod>`, and `<xhtml:link rel="alternate" hreflang>` siblings; covers all languages on the same host. `robots.txt` is `User-agent: *` with `Disallow: /js/` only.

### Dead ends (not usable externally)

- `/umbraco/delivery/api/v2/content` — CMS only callable server-side with `CDA_KEY`; 404 publicly.
- `/api/search`, `/api/sok`, `/api/articles` — none exist on production.
- `/soeg`, `/soeg?q=…` — same HTML regardless of query string; query resolved client-side via URL fragment (use `skat search`).
- `tastselv.skat.dk/...` — MitID-bound interactive app, no API.
- `vent.skat.dk/?c=skat&e=prod…&t=…` — login-queue redirector, useful as link target only.
- NextAuth.js `/api/auth/*` — narrow internal flows (eKontakt chat, restskat agreements); not a generic citizen-auth path.
