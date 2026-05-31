---
name: virk-dk
description: virk.dk — the Danish government portal for businesses. Covers the anonymous editorial surface (9 themes, ~2000 articles, agency tree, self-service launchers), Mit Virk dashboard, GraphQL gateway, and CVR data portals. Use when looking up Danish business-admin procedures, self-service forms, or querying virk.dk's GraphQL or Elasticsearch endpoints.
last-updated: 2026-05-31
---

# virk.dk — Danish business portal

Official entrypoint for businesses and advisors dealing with Danish authorities, run by **Erhvervsstyrelsen**. Two surfaces:

- **Editorial surface** (`virk.dk`) — anonymous themes/articles, agency tree, self-service launchers, plus the GraphQL gateway behind the SSR front-end.
- **CVR data** — the Central Business Register: company, P-unit, and participant data, served system-to-system from an Elasticsearch distribution API.

Personalised pages (Mit Virk dashboard) need **MitID Erhverv** and have no programmatic path. Site language is Danish, so **answer the user in Danish** unless they write in another language.

## CLI — use this first

Programmatic access goes through the `virk` CLI. It wraps both the GraphQL gateway and the CVR Elasticsearch API, so **prefer it over POSTing GraphQL by hand, hitting `distribution.virk.dk` directly, or navigating `datacvr.virk.dk`**. The raw endpoints are documented in the reference section at the end — consult them only for something the CLI does not expose (e.g. a custom GraphQL query via `virk web query`, or a custom ES query via `virk cvr raw`).

The CLI runs from anywhere; no need to point at the skill directory. Two subcommand groups:

```bash
virk web <command> [options]   # virk.dk editorial content + GraphQL gateway (anonymous)
virk cvr <command> [options]   # CVR distribution API (Elasticsearch; needs credentials)
```

### Install / prerequisites

```bash
which virk   # check if already installed
```

If missing, install editable with pipx:

```bash
which pipx || python3 -m pip install --user pipx
python3 -m pipx ensurepath
pipx install -e <path-to-virk-dk-skill>
which virk   # confirm on PATH (restart shell if ensurepath just ran)
```

Pure Python standard library — no extra dependencies. The `web` group is anonymous. The `cvr` group reads `DATACVR_USER` / `DATACVR_PASS` env vars (free, long-lived creds — email `cvrselvbetjening@erst.dk` with name, org, CVR, and use-case). Most commands accept `--raw` for unformatted JSON.

### `virk web` — editorial content + GraphQL gateway

| Command | Purpose | Example |
|---|---|---|
| `article <slug>` | Fetch one Artikel by slug | `virk web article start-virksomhed` |
| `search-articles <text> [--limit N]` | Substring match on `Artikel.overskrift` | `virk web search-articles moms --limit 20` |
| `ordninger [--limit N]` | List Ordninger (schemes) | `virk web ordninger` |
| `myndigheder [--type stat\|kommune\|region] [--limit N]` | List agencies | `virk web myndigheder --type stat` |
| `ministerier` | Ministry → agency tree (backs `/nye-regler/`) | `virk web ministerier` |
| `mv-services` | Mit Virk backend service status (anon) | `virk web mv-services` |
| `ressourceset <slug> [--locale da]` | Key/value strings of an i18n bundle | `virk web ressourceset <slug>` |
| `redirect <url> [--realm virk]` | Resolve a vanity URL via `redirectQuery` | `virk web redirect /start` |
| `sitemap [--limit N] [--prefix /emner/]` | URLs from `/sitemap.xml` | `virk web sitemap --prefix /emner/` |
| `query '<graphql>' [--variables JSON]` | Run an arbitrary GraphQL query string | `virk web query '{ ordningCollection { total } }'` |
| `raw <file> [--variables JSON]` | POST a GraphQL document from a file | `virk web raw query.graphql` |

All `virk web` commands take `--raw` to print the unformatted GraphQL JSON response.

### `virk cvr` — CVR distribution API

Needs `DATACVR_USER` / `DATACVR_PASS`. All commands print the matched `_source` (or `--raw` for the full ES response).

| Command | Purpose | Example |
|---|---|---|
| `virksomhed <cvr> [--field <dot-path>]` | Company by CVR number; `--field` extracts a path under `virksomhedMetadata` (then `Vrvirksomhed`) | `virk cvr virksomhed 10103940 --field nyesteNavn.navn` |
| `p-enhed <pnr>` | Production unit by P-number | `virk cvr p-enhed 1003393495` |
| `deltager <enhedsNummer>` | Participant by `enhedsNummer` | `virk cvr deltager 4000004072` |
| `search <name> [--limit N]` | Company name search (`match` on `nyesteNavn.navn`) | `virk cvr search carlsberg --limit 10` |
| `count <index> <type>` | Document count for an index/type (`match_all`) | `virk cvr count cvr-permanent virksomhed` |
| `raw <index> <type> <body-file>` | POST a raw ES query body to `<index>/<type>/_search` | `virk cvr raw cvr-permanent virksomhed query.json` |

## Site map (editorial surface)

For agents, reach the content below via the CLI; the URLs are for human navigation or `virk web redirect`.

- **9 themes ("emner")** on the front page, each with 4–12 sub-themes: Byggeri, Handel - og servicefag, Miljø, Personale, Sikkerhed, Statistik, Transport, Virksomhed, Økonomi. Drill: `/emner/<theme>/<sub-theme>/` → introside listing articles, ordninger, and self-service shortcuts.
- **Articles** live under sub-themes: Contentful Rich Text body + "Genveje til selvbetjening" CTAs + related mikroartikler. Find them with `virk web article` / `virk web search-articles`.
- **Self-service launchers**: `/myndigheder/<type>/<agency>/selvbetjening/<slug>/` per-agency launcher pages that hand off to the agency's own application (launchers are stubs — actual filing happens in the agency app). Named launchers on the home page: Start virksomhed, Ændre virksomhed, Luk virksomhed, Indberet moms, Refusion af sygedagpenge, Overførsel af ferie, Anmeld arbejdsulykke.
- **Agency tree**: `/myndigheder/` (169 myndigheder); query with `virk web myndigheder` / `virk web ministerier`.
- **Upcoming legislation**: `/nye-regler/` by ministry.
- **Help & about**: `/vejledning/virk-hjaelp/` and `/vejledning/`. Accessibility: `https://www.was.digst.dk/virk-dk`.
- **Sister sites**: `businessindenmark.virk.dk` (English mirror, curated subset — many articles only exist in Danish) and `datacvr.virk.dk` (CVR search, website-only — see below).

## Website-only surfaces

These have no API and must be used through a browser:

- **`datacvr.virk.dk`** — human-facing CVR search SPA behind Cloudflare Turnstile (returns 403 to headless scrapers). Free-text search (`?soeg=`), company detail (`/enhed/virksomhed/<cvr>`), P-unit detail (`/enhed/produktionsenhed/<pnr>`), downloadable CSV/Excel at `/datakatalog/`. For programmatic CVR lookups use `virk cvr` instead. Legacy `cvr.virk.dk` 308→`datacvr.virk.dk`.
- **Mit Virk dashboard** (`/mit-virk/`) — aggregated state (cases `MVSag`, deadlines `MVFrist`, messages `MVBesked`, permits `MVTilladelse`) after MitID Erhverv login. Session-bound only — no public API or service account. `/mit-virk/` and `/digitalpost/` are in `robots.txt`.
- **Datafordeler successor** — `https://datafordeler.dk/dataoversigt/det-centrale-virksomhedsregister-cvr/` is the REST/JSON-over-OAuth2 replacement for CVR distribution. The `distribution.virk.dk` Elasticsearch endpoint retires **end of 2026**; new integrations should target Datafordeler.

---

## Reference: GraphQL gateway, CVR Elasticsearch & site structure

What the CLI wraps. Consult only when you need something the CLI does not expose — feed custom GraphQL through `virk web query`/`virk web raw`, and custom ES queries through `virk cvr raw`.

### GraphQL gateway

`https://virk.dk/graphql` — single anonymous endpoint backing the Nuxt 2 / Vue SSR front-end (Contentful CMS). **No REST `/api/*` routes** (all 404). `robots.txt` does not block `/graphql`.

- `POST /graphql` with `Content-Type: application/json`: `{"query": "...", "variables": {...}}`. GET also works.
- Federates **two** backends: the **Contentful Delivery API** (every type `Foo` has `fooCollection(limit, skip, where, locale, preview, order)`) and the private **Mit Virk aggregator**.
- **Introspection disabled**: `__schema` returns errors; discover types from the SPA bundle or trial-and-error.
- Error envelope `{"errors":[...], "data": ...}`; per-resolver errors don't fail the whole query. Codes include `SERVICE_REFERENCE_INVALID`. CORS wide open.

Auth: Contentful collections, `redirectQuery`, and `mvServices` are anonymous (the entire editorial surface). `mvSag`/`mvFrist`/`mvBesked`/`mvTilladelse`/`mvInformationCollection` and mutations (`mvSkjulInformation`, `updateMinisterier`) are session-bound to MitID Erhverv and unreachable anonymously.

**Schema cribsheet** (verified via `<type>Collection { items { __typename } }`):

| Collection | total | Key fields |
|---|---|---|
| `artikelCollection` | 908 | `sys.id, slug, overskrift, tags` |
| `mikroartikelCollection` | 1908 | `sys.id, overskrift` |
| `masterCollection` | 1773 | `sys.id, slug, titel, myndighedstype` |
| `introsideCollection` | 1931 | `sys.id, slug, titel` |
| `udstillerCollection` | 8316 | Links self-service entry to issuing agency (use to enumerate launchers, which `sitemap.xml` omits) |
| `myndighedCollection` | 169 | `forkortelse, type, cvr, beskrivelse` — **no `navn`/`slug`** (on linked `Ministerium`) |
| `ordningCollection` | 64 | `slug, overordnetTitel` |
| `emneCollection` | 465 | Topic taxonomy |
| `cardCollection` | 13 | `overskrift, cardtype, billede` |
| `modalCollection` | 6 | Inline modals in rich text |
| `mitVirkSektionCollection` | 16 | Sections composing `/mit-virk/` |
| `mitVirkSideCollection` | small | Page tree under `/mit-virk/` |
| `ressourceSetCollection` | small | i18n string bundles |
| `ministeriumCollection` | small | Ministry → agency tree |

`Asset`: `{ url, fileName, contentType, width, height, sys{id,publishedAt} }`. `SimpeltLink`: `{url, linkText}`. `MVLink`: `{url, titel, ariaLabel}`. Mit Virk types share `id, titel, beskrivelse, system{...}, gyldighedsperiode{from,to}, myndighed{cvr,navn}, primaerPart{partType,identifikator}, handlingsLink{...}`. Enums: `MVAubElevType`, `MVIdentitetType`. Input: `MVInformationFilter`. The `redirectQuery(query, realm)` resolver returns `redirectUrl=""` / `httpStatus=-1` when no match (realm `"virk"`).

Example raw queries (each via `virk web query '<below>'` or POST `https://virk.dk/graphql`):

```graphql
# Article by slug
query ArticleBySlug($slug: String!) {
  artikelCollection(limit: 1, where: { slug: $slug }) {
    items { sys { id } overskrift alternativTitel alternativBeskrivelse tags }
  }
}
```

```graphql
# Mit Virk page tree
query mvSideStruktur($slug: String) {
  mitVirkSideCollection(where: { slug: $slug }, limit: 1) {
    items { overskrift slug mitVirkSiderCollection { items { overskrift slug } } }
  }
}
```

```graphql
# i18n bundle (wrapped by `virk web ressourceset`)
query RessourceSet($slug: String!, $locale: String = "da") {
  ressourceSetCollection(where: { slug: $slug }, locale: $locale, limit: 1) {
    items { ressourcerCollection(limit: 1000) { items { key value } } }
  }
}
```

### CVR Elasticsearch distribution API

`http://distribution.virk.dk` — plain HTTP, Elasticsearch v6. HTTP Basic on every request (returns 401 without creds); `GET` and `POST /_search` both work. Replies are vanilla ES6 JSON. `virk cvr` wraps all of this.

Indices:

```
cvr-permanent/virksomhed/_search                   # companies
cvr-permanent/produktionsenhed/_search             # P-units
cvr-permanent/deltager/_search                     # participants
registreringstekster/registreringstekst/_search    # registration texts
```

Alias `cvr-update` exists for incremental syncs. Equivalent raw lookup behind `virk cvr virksomhed`:

```bash
curl -s -u "$DATACVR_USER:$DATACVR_PASS" -H 'Content-Type: application/json' \
  -X POST 'http://distribution.virk.dk/cvr-permanent/virksomhed/_search' \
  -d '{"query": {"term": {"Vrvirksomhed.cvrNummer": 10103940}}}'
```

Field shortcuts (useful for interpreting `virk cvr` output and building `virk cvr raw` bodies):

| Lookup | Field |
|---|---|
| CVR number | `Vrvirksomhed.cvrNummer` |
| P-number | `VrproduktionsEnhed.pNummer` |
| Participant | `Vrdeltagerperson.enhedsNummer` / `Vrvirksomhed.enhedsNummer` |
| Name (full text) | `Vrvirksomhed.virksomhedMetadata.nyesteNavn.navn` |
| Postal code | `Vrvirksomhed.virksomhedMetadata.nyesteBeliggenhedsadresse.postnummer` |
| Industry (DB07) | `Vrvirksomhed.virksomhedMetadata.nyesteHovedbranche.branchekode` |
| Company form | `Vrvirksomhed.virksomhedMetadata.nyesteVirksomhedsform.virksomhedsformkode` |

Top-level `_source` shape: `Vrvirksomhed` with `cvrNummer`, `enhedsNummer`, `navne[]`, `beliggenhedsadresse[]`, `deltagerRelation[]`, and `virksomhedMetadata.nyeste*` mirrors. P-units and participants follow analogous shapes with historical arrays.

Pagination: `from + size <= 3000`; beyond that use `?scroll=1m`, or prefer the daily ndjson dumps at `/datakatalog/` for large exports. "Reklamebeskyttede" units have email/phone redacted even with credentials, and protected sole-traders' addresses are suppressed. Update lag: minutes for live, end-of-day for dumps. No tax/accounting figures beyond published annual reports. Endpoint retires end of 2026 — migrate to Datafordeler.

### URL conventions

All editorial URLs are relative to `https://virk.dk/`. Slugs use URL-encoded Danish letters (`æ`→`%C3%A6`, `ø`→`%C3%B8`, `å`→`%C3%A5`). Trailing `/` is significant (`/emner/Byggeri` 301→`/emner/Byggeri/`). Launcher slugs use `_` and spelled-out Danish letters (e.g. `Aendre`, `Foersel`). Site search (`/search/?term=<query>`) is SSR HTML only — no JSON autocomplete. `robots.txt` blocks `/admin`, `/assistent`, `/design`, `/digitalpost`, `/mit-virk`, `/preview`, `/redigering`, `/search`. `sitemap.xml` has ~7,800 `<loc>` entries (no `<lastmod>`) and omits selvbetjening launchers.
