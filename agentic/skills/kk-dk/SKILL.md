---
name: kk-dk
description: kk.dk — City of Copenhagen (Københavns Kommune) official site. Covers navigation, search, news, jobs, and English mirror. Use for Copenhagen municipal services, events, policies, news, or jobs. Distinct from borger.dk and kommune.dk.
last-updated: 2026-05-09
---

# kk.dk — City of Copenhagen official website

Official site of **Københavns Kommune**, Denmark's capital. Built on **Drupal 11**. All content is server-rendered HTML. Language: Danish — respond in Danish unless the user has signalled otherwise.

Base URL: `https://www.kk.dk/`. Slugs use Danish letters spelled out (`æ`→`ae`, `ø`→`oe`, `å`→`aa`).

## Top-level navigation

Five sections accessible from the global header:

| Section | URL | Content |
|---|---|---|
| Borger | `/borger` | Citizen services: borgerservice, pas, flytning, pension, sundhed, skole, handicap |
| Erhverv | `/erhverv` | Business: permits, construction, employment, procurement, property rental |
| Brug byen | `/brug-byen` | Culture, sports, water activities, parks, associations, events |
| Politik | `/politik` | Governance: borgerrepræsentation, udvalg, borgmestre, budget, dagsordener, referater, valg |
| Om kommunen | `/om-kommunen` | Contacts, departments, jobs, statistics, data protection, press |

Each section page lists sub-sections as a navigation menu. Drill into `/<section>/<subslug>`.

## Article anatomy

Typical page at `/<section>/<subslug>/<article-slug>`: breadcrumbs ("Du er her"), article body (Danish prose, sometimes with embedded images/videos), publication date in byline, and category tags (`<span class="node__type">`). Clean URLs map Drupal node IDs to human-readable slugs.

## Search

- **Global search** — available on every page. `GET /soeg?k=<query>` returns HTML results.
- **News search** — `/nyheder` supports keyword (`text`), date range (`publication_date[min/max]`), category, content type, and department filters.

## News and press — `/nyheder`

Paginated Views list with eight filters (keyword, date range, category, content type, department, sort, pagination). Categories include Borger, Erhverv, Kultur, Sundhed, and many others — enumerate from the site. Content types: "Nyhed" and "Pressemeddelelse".

## Job listings — `/ledigestillinger`

Vacancies listed at `/ledigestillinger`. Linked from footer and `/om-kommunen/job`.

## English mirror — `https://international.kk.dk`

Subset of kk.dk content translated into English. Same navigation structure, different domain.

## Contact

- **Phone**: `+45 33 66 33 66`
- **General**: `/om-kommunen/kontakt`
- **Complaints**: `/om-kommunen/sagsbehandling-og-klager`
- **Data protection**: `/om-kommunen/databeskyttelse`

## Sitemap

Index: `https://www.kk.dk/sitemap.xml` (multi-page, `?page=1`, etc.). `robots.txt` blocks `/admin/`, `/search/`, `/user/*`, `/core/`.

## Common citizen tasks

- **Topic info**: navigate top-level section → sub-sections, or search `/soeg?k=<query>`.
- **Latest news**: `/nyheder`, optionally filtered.
- **Press release**: filter `/nyheder` by content type "Pressemeddelelse".
- **Borgerservice appointment**: `/borger/borgerservice` → "Bestil tid".
- **Passport/driver's license**: `/borger/borgerservice` → "Pas" or "Kørekort".
- **Job search**: `/ledigestillinger`.
- **Contact city office**: `/om-kommunen/kontakt`.
- **Cultural/sporting events**: `/brug-byen` → "Kunst og kultur" or "Bevæg dig i byen".
- **Politics/meeting minutes**: `/politik` → "Dagsordener og referater".
- **English version**: replace `www.kk.dk` with `international.kk.dk`.

## Limits

- Entirely server-rendered HTML — no REST, GraphQL, or JSON API.
- Search autocomplete (`/search_api_autocomplete/*`) returns empty arrays via HTTP; use HTML page instead.
- News listing paginated at 24 items/page.
- No MitID citizen dashboard (unlike borger.dk).
- Admin areas at `/admin/*` are blocked and require authentication.
