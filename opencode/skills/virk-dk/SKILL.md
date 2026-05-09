---
name: virk-dk
description: virk.dk — the Danish government portal for businesses. Covers the anonymous editorial surface (9 themes, ~2000 articles, agency tree, self-service launchers), Mit Virk dashboard, GraphQL gateway, and CVR data portals. Use when looking up Danish business-admin procedures, self-service forms, or querying virk.dk's GraphQL or Elasticsearch endpoints.
last-updated: 2026-05-07
---

# virk.dk — Danish business portal

Official entrypoint for businesses and advisors dealing with Danish authorities. Run by **Erhvervsstyrelsen** on Nuxt 2 / Vue SSR backed by Contentful (CMS) and a private Mit Virk aggregation backend. Anonymous browsing is open; personalised pages need **MitID Erhverv**. Site language: Danish.

All URLs are relative to `https://virk.dk/`. Slugs use URL-encoded Danish letters (`æ`→`%C3%A6`, `ø`→`%C3%B8`, `å`→`%C3%A5`). Trailing `/` is significant: `/emner/Byggeri` 301→`/emner/Byggeri/`.

## 1. Top-level sections

Front page is a grid of 9 "emner" (themes); each has 4–12 sub-themes.

| Theme | URL |
|---|---|
| Byggeri | `/emner/Byggeri/` |
| Handel - og servicefag | `/emner/Handel%20-%20og%20servicefag/` |
| Miljø | `/emner/Milj%C3%B8/` |
| Personale | `/emner/Personale/` |
| Sikkerhed | `/emner/Sikkerhed/` |
| Statistik | `/emner/Statistik/` |
| Transport | `/emner/Transport/` |
| Virksomhed | `/emner/Virksomhed/` |
| Økonomi | `/emner/%C3%98konomi/` |

Drill pattern: `/emner/<theme>/<sub-theme>/` → introside listing articles, ordninger, and self-service shortcuts.

## 2. Article anatomy

Articles live under sub-themes. Each mixes:

- **Body copy** — Contentful Rich Text, often with inline modals.
- **Genveje til selvbetjening** — CTAs pointing to `/myndigheder/<type>/<agency>/selvbetjening/<slug>/` launcher pages that hand off to the agency's own application.
- **Related mikroartikler** — short references.

## 3. Self-service entry points

| Pattern | Behaviour |
|---|---|
| `/myndigheder/<type>/<agency>/selvbetjening/<slug>/` | Per-agency launcher page. `<type>` is `stat`, `kommune`, `region`, etc. |
| `/myndigheder/` | Agency tree — 169 myndigheder by type and ministry. |
| `/search/?term=<query>` | SSR-rendered search (no JSON autocomplete). Query is `?term=` (URL-encoded); trailing `/` required. |
| `/nye-regler/` | Upcoming legislation by ministry. |

Named launchers on the home page include: Start virksomhed, Ændre virksomhed, Luk virksomhed, Indberet moms, Refusion af sygedagpenge, Overførsel af ferie, Anmeld arbejdsulykke. Launcher slugs use `_` and spelled-out Danish letters (e.g. `Aendre`, `Foersel`).

**Sister sites**: `businessindenmark.virk.dk` (English mirror, curated subset) and `datacvr.virk.dk` (CVR search).

## 4. "Mit Virk" — logged-in dashboard

Root: `/mit-virk/`. Aggregated state from agency backends (CVR, Skat, Danmarks Statistik, etc.) after MitID Erhverv login. Surfaces four item types:

| Type | What |
|---|---|
| `MVSag` | Active case with authority |
| `MVFrist` | Upcoming deadline |
| `MVBesked` | Message from authority |
| `MVTilladelse` | Permit / authorisation |

Backend services (queryable via `mvServices`): `elastic`, `virksomhedsaendringer`, `danmarksstatistik`, `regnskab`, `fstyr`, `kompensation`. No service-account path — all data is session-bound to a live MitID Erhverv login. `/mit-virk/` and `/digitalpost/` are in `robots.txt`.

## 5. Help & about

Help lives at `/vejledning/virk-hjaelp/`. Guides for voluntary associations, authorities, and cookie/privacy policies at `/vejledning/`. Accessibility statement at `https://www.was.digst.dk/virk-dk`.

## 6. Sitemap & enumeration

- Sitemap: `https://virk.dk/sitemap.xml` — ~7,800 `<loc>` entries, no `<lastmod>`. Omits `/myndigheder/<...>/selvbetjening/<...>/` — enumerate via agency tree or GraphQL `udstillerCollection` (8316 entries).
- `robots.txt` blocks: `/admin`, `/assistent`, `/design`, `/digitalpost`, `/mit-virk`, `/preview`, `/redigering`, `/search`.

## 7. Common business tasks

- **Find an article**: drill from theme tile or search `/search/?term=<query>`. Programmatic: query `artikelCollection`, `mikroartikelCollection` via GraphQL.
- **Launch a form**: article's "Genveje til selvbetjening" → launcher page → agency app.
- **Company overview**: `/mit-virk/` after MitID Erhverv login.
- **Agency info**: `/myndigheder/` or query `myndighedCollection`.
- **Read in English**: `businessindenmark.virk.dk`.
- **Look up CVR**: `datacvr.virk.dk` or `distribution.virk.dk` Elasticsearch.

## 8. Limits worth flagging

- Mit Virk data is session-bound to MitID Erhverv — no public API or service-account access.
- Site search returns SSR HTML only; no JSON autocomplete.
- English mirror is curated; many articles only exist in Danish.
- Launcher pages are stubs — actual filing happens in the agency's own application.

---

# GraphQL gateway

`https://virk.dk/graphql` — single anonymous endpoint backing the Nuxt SSR front-end. **No REST `/api/*` routes** (all 404). `robots.txt` does not block `/graphql`.

## Conventions

- `POST /graphql` with `Content-Type: application/json`: `{"query": "...", "variables": {...}}`. GET also works.
- Server: `x-env: Azure/K8s GraphQL Gateway`. CORS wide open (`Access-Control-Allow-Origin: *`).
- **Introspection disabled**: `__schema` returns errors. Type discovery from SPA bundle or trial-and-error.
- Error envelope: `{"errors":[...], "data": ...}`. Per-resolver errors don't fail the whole query. Codes include `SERVICE_REFERENCE_INVALID`.
- Federates **two** backends:
  - **Contentful Delivery API** — standard Contentful pattern: every type `Foo` has `fooCollection(limit, skip, where, locale, preview, order)`.
  - **Mit Virk aggregator** — private wrapper over per-agency backends.

## Auth model

| Surface | Auth |
|---|---|
| Contentful collections (`artikelCollection`, `myndighedCollection`, `udstillerCollection`, etc.) | Anonymous |
| `redirectQuery` | Anonymous |
| `mvServices` | Anonymous |
| `mvSag`, `mvFrist`, `mvBesked`, `mvTilladelse`, `mvInformationCollection` | Session-bound (MitID Erhverv) |
| Mutations (`mvSkjulInformation`, `updateMinisterier`) | Session-bound |

Anonymous use covers the entire editorial surface. Personal-business data is unreachable.

## Schema cribsheet

Verified via `<type>Collection { items { __typename } }`:

| Collection | total | Key fields |
|---|---|---|
| `artikelCollection` | 908 | `sys.id, slug, overskrift, tags` |
| `mikroartikelCollection` | 1908 | `sys.id, overskrift` |
| `masterCollection` | 1773 | `sys.id, slug, titel, myndighedstype` |
| `introsideCollection` | 1931 | `sys.id, slug, titel` |
| `udstillerCollection` | 8316 | Links self-service entry to issuing agency |
| `myndighedCollection` | 169 | `forkortelse, type, cvr, beskrivelse` — **no `navn`/`slug`** (on linked `Ministerium`) |
| `ordningCollection` | 64 | `slug, overordnetTitel` |
| `emneCollection` | 465 | Topic taxonomy |
| `cardCollection` | 13 | `overskrift, cardtype, billede` |
| `modalCollection` | 6 | Inline modals in rich text |
| `mitVirkSektionCollection` | 16 | Sections composing `/mit-virk/` |
| `mitVirkSideCollection` | small | Page tree under `/mit-virk/` |
| `ressourceSetCollection` | small | i18n string bundles |
| `ministeriumCollection` | small | Ministry → agency tree |

`Asset`: `{ url, fileName, contentType, width, height, sys{id,publishedAt} }`. `SimpeltLink`: `{url, linkText}`. `MVLink`: `{url, titel, ariaLabel}`.

Mit Virk types have common fields: `id, titel, beskrivelse, system{...}, gyldighedsperiode{from,to}, myndighed{cvr,navn}, primaerPart{partType,identifikator}, handlingsLink{...}`. Enums: `MVAubElevType`, `MVIdentitetType`. Input: `MVInformationFilter`.

## Verified queries

All examples: `POST https://virk.dk/graphql` with `{"query": "<below>", "variables": {...}}`.

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
    items { overskrift slug mitVirkSiderCollection { items { overskrift slug mitVirkSiderCollection { items { overskrift slug } } } } }
  }
}
```

```graphql
# i18n bundle
query RessourceSet($slug: String!, $locale: String = "da") {
  ressourceSetCollection(where: { slug: $slug }, locale: $locale, limit: 1) {
    items { ressourcerCollection(limit: 1000) { items { key value } } }
  }
}
```

```graphql
# Ministry / agency tree
query fetchMinisterier {
  ministeriumCollection { items { navn cvr myndigheder { navn cvr } } }
}
```

```graphql
# Vanity URL resolver
query redirects($q: String!, $realm: String!) {
  redirectQuery(query: $q, realm: $realm) { redirectUrl httpStatus }
}
# realm: "virk". Returns redirectUrl="" and httpStatus=-1 if no match.
```

**Mutations** (auth only): `mvSkjulInformation(service, uuid, identitetType, skjul)` — hide dashboard item. `updateMinisterier(ministerier)` — editorial mutation.

## Helper script

`virk_dk_api.py` (standard library only):

```bash
python3 virk_dk_api.py query '<graphql>'
python3 virk_dk_api.py article <slug>
python3 virk_dk_api.py search-articles <text> [--limit N]
python3 virk_dk_api.py ordninger [--limit N]
python3 virk_dk_api.py myndigheder [--type stat|kommune|region] [--limit N]
python3 virk_dk_api.py ministerier
python3 virk_dk_api.py mv-services
python3 virk_dk_api.py ressourceset <slug> [--locale da]
python3 virk_dk_api.py redirect <vanity-url> [--realm virk]
python3 virk_dk_api.py sitemap [--limit N] [--prefix /emner/]
python3 virk_dk_api.py raw <file>
```

---

# CVR data

The Central Business Register (**CVR**) is administered by Erhvervsstyrelsen. Two channels:

| Channel | Audience | Auth |
|---|---|---|
| `https://datacvr.virk.dk/` (UI) | Humans | Anonymous (Cloudflare Turnstile) |
| `http://distribution.virk.dk/cvr-permanent/...` (Elasticsearch) | Systems | HTTP Basic (free) |

Older URL `cvr.virk.dk` 308→`datacvr.virk.dk`. Successor: **Datafordeler** (`https://datafordeler.dk/dataoversigt/det-centrale-virksomhedsregister-cvr/`) — REST/JSON over HTTPS with OAuth2, phased-in replacement.

## 1. Human-facing portal — `datacvr.virk.dk`

React SPA behind Cloudflare Turnstile (returns 403 to headless scrapers). Use Playwright or the ES endpoint for programmatic access.

Features: free-text search (`?soeg=`), company detail (`/enhed/virksomhed/<cvr>`), P-unit detail (`/enhed/produktionsenhed/<pnr>`), advertising protection suppression, downloadable CSV/Excel snapshots at `/datakatalog/`. Legal document scans cost a small fee.

## 2. System-to-system — `distribution.virk.dk`

Plain HTTP (Elasticsearch v6). No anonymised crawling — returns 401 without credentials.

### Credentials

Email `cvrselvbetjening@erst.dk` with name, org, CVR, use-case description. Free, long-lived creds.

### Indices

```
cvr-permanent/virksomhed/_search          # companies
cvr-permanent/produktionsenhed/_search    # P-units
cvr-permanent/deltager/_search            # participants
registreringstekster/registreringstekst/_search   # registration texts
```

Alias `cvr-update` exists for incremental syncs.

### Auth & methods

HTTP Basic on every request (`-u user:pass`). `GET` and `POST /_search` both work. Replies are vanilla ES6 JSON.

### Canonical lookup

```bash
curl -s -u "USER:PASS" \
  -H 'Content-Type: application/json' \
  -X POST 'http://distribution.virk.dk/cvr-permanent/virksomhed/_search' \
  -d '{"query": {"term": {"Vrvirksomhed.cvrNummer": 10103940}}}' \
  | jq '.hits.hits[0]._source.Vrvirksomhed.virksomhedMetadata.nyesteNavn'
```

Field shortcuts:

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

Pagination: `from + size <= 3000`. Beyond that, `?scroll=1m`. For large exports prefer daily ndjson dumps from `/datakatalog/`.

"Reklamebeskyttede" units have email/phone redacted even with credentials. Update lag: minutes for live, end-of-day for dumps.

**Phase-out**: distribution endpoint retires end of 2026. New integrations should target Datafordeler.

### What you cannot do

- No personal data of protected sole-traders (address redacted).
- No tax/accounting figures beyond published annual reports (those are in Skat).
- No free unlimited bulk export (throttled at 3000 hits/query).
- No SLA after end-2026 — plan migration to Datafordeler.

## 3. Helper script

`datacvr_api.py` (expects `DATACVR_USER` / `DATACVR_PASS` env vars):

```bash
python3 datacvr_api.py virksomhed 10103940
python3 datacvr_api.py virksomhed 10103940 --field nyesteNavn.navn
python3 datacvr_api.py p-enhed 1003393495
python3 datacvr_api.py deltager 4000004072
python3 datacvr_api.py search "carlsberg" --limit 10
python3 datacvr_api.py raw cvr-permanent virksomhed query.json
python3 datacvr_api.py count cvr-permanent virksomhed
```
