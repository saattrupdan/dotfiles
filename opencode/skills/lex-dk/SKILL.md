---
name: lex-dk
description: lex.dk — Denmark's national encyclopedia (~245 k articles). Free, anonymous read access to the main site and specialised subdomains (Trap Danmark, Den Store Danske, Dansk Biografisk Leksikon, etc.). Use for authoritative Danish-language facts, citations, or encyclopedic lookups. Includes documented anonymous API endpoints.
last-updated: 2026-05-07
---

# lex.dk — Danmarks Nationalleksikon

Run by *foreningen lex.dk*; published under restrictive licence (`/.licenses/restricted`). Free to read, no login needed. Login (`/.login`) only adds editor capabilities — no extra content. Site language: Danish; respond in Danish unless the user signals otherwise.

## URL conventions

| Pattern | Meaning |
|---|---|
| `https://lex.dk/<Slug>` | Article slug: spaces → `_`, Danish letters URL-encoded (`%C3%A6`/`%C3%B8`/`%C3%A5` for æ/ø/å). **Case-sensitive**: proper nouns capitalised (`Marie_Curie`), common nouns lower-case (`statiner`). Disambiguated articles use `_-_` (e.g. `Marie_-_dronning`). |
| `https://lex.dk/.search?query=<term>&page=<n>` | Search results (HTML). |
| `https://lex.dk/.alfabetisk/<L>/<page>` | Alphabetical browse. `<L>` ∈ `A`–`Z`, `Æ` (`%C3%86`), `Ø` (`%C3%98`), `Å` (`%C3%85`), `#` (`%23`). |
| `https://lex.dk/.taxonomy/<id>` | Subject-tree node. IDs from article breadcrumbs. |
| `https://lex.dk/.temaside/<slug>` | Editorial theme page. |
| `https://lex.dk/.recent-activities` | Recent edits stream. |
| `https://brugere.lex.dk/<user-id>` | Contributor profile. |
| `https://media.lex.dk/media/<id>/<filename>` | Image CDN. |
| `https://lex.dk/.sitemap/sitemap.xml` | Sitemap index → `sitemap1.xml`…`sitemap6.xml`. |

`https://www.lex.dk/...` redirects to `https://lex.dk/...`.

## Site sections (front page)

`https://lex.dk/` shows: **Det sker** (current events), **Opdag med temaer** (curated themes), **Kultur og historie** (cultural spotlights), reading stats ("Mest læst", "Usædvanlig meget læst"), **Vidste du?** (facts), **Emner på Lex** (top-level subject taxonomies), **Alfabetisk indeks**, and **Seneste ændringer**.

## Article anatomy

Each article (`/<Slug>`) has: `<h1>` title + *manchet* (lead), section anchors (`#-<anchor>`), **Faktaboks** (factbox), highlighted authors with `brugere.lex.dk` links, breadcrumbs to `/.taxonomy/<id>`, a schema.org `<script type="application/ld+json">` block (full citation data: author/editor/ORCID/ROR), a `dataLayer` `<script>` with `articleId`, "Se også" cross-links, "Senest ændret" date, and a "Citér denne artikel" block. Legacy *Den Store Danske* equivalents appear at `https://denstoredanske.lex.dk/<Slug>` when present.

For programmatic parsing, fetch raw HTML and read the `<script>` tags directly — markdown renderers strip them.

## Subdomain encyclopedias

Each subdomain is a separate encyclopedia sharing the same routing (`/.search`, `/.alfabetisk`, `/.taxonomy`, `/.recent-activities`, `/.search/autocomplete`, sitemap). Main-site search returns hits from all subdomains. Key subdomains:

| Subdomain | Encyclopedia |
|---|---|
| `trap.lex.dk` | **Trap Danmark** — geographical descriptions of every Danish municipality/locality. |
| `denstoredanske.lex.dk` | **Den Store Danske** — Gyldendal's legacy general encyclopedia (frozen). |
| `biografiskleksikon.lex.dk` | **Dansk Biografisk Leksikon** — historical Danish biographies (3rd ed.). |
| `danmarkshistorien.lex.dk` | Aarhus University's *Danmarkshistorien* — peer-written Danish history. |
| `naturenidanmark.lex.dk` | *Naturen i Danmark* — flora, fauna, ecology. |
| `kvindebiografiskleksikon.lex.dk` | **Dansk Kvindebiografisk Leksikon** — Danish women's biographies. |

Other subdomains exist (Trap 5th ed., Grønland, Færøerne, etc.). See `om.lex.dk` for the full list.

## Common tasks

- **Look up a person/place/term**: try `https://lex.dk/<Title>` first (preserve capitalisation). If 404, use autocomplete (below).
- **Cite an article**: parse the schema.org JSON-LD block or use the "Citér denne artikel" block at the bottom.
- **Find a Danish place**: prefer `trap.lex.dk`.
- **Historical biography**: prefer `biografiskleksikon.lex.dk`; for living Danes, use main `lex.dk`.
- **Browse by subject**: open an article, click a breadcrumb (`/.taxonomy/<id>`) to list all articles in that node.
- **Recent edits**: `/.recent-activities.json`.
- **Enumerate all articles**: walk `https://lex.dk/.sitemap/sitemap.xml` → 6 shards (~9 MB each). Don't crawl page-by-page.

## Search tips

- Case-insensitive, matches title + lead. Danish characters (æ ø å) match but should be URL-encoded in links.
- Disambiguated titles use ` – ` (em-dash) in display and `_-_` in slugs.
- HTML search page reports total hits and paginates via `&page=<n>`.
- For programmatic disambiguation, use `GET /.search/autocomplete?query=<term>` (returns up to 5 ranked suggestions with source encyclopedia).

## What lex.dk is *not* good for

- Non-Danish topics outside encyclopedic scope.
- Real-time news (not a news site).
- Bulk data export or ML training — licence forbids redistribution; `robots.txt` blocks all major LLM crawlers.
- Social/user-generated content (vetted experts only).

# lex.dk anonymous API endpoints

No documented API, no `/api/` contract, no OpenAPI. Routes with leading dot (`/.search`, `/.sitemap`, `/.announcements`) or `.json` suffix serve JSON/XML. `robots.txt` disallows `/.search*`, `/.version*`, `/.bruker*`, `/.admin*`, `/.improvements*`. AI crawlers (CCBot, GPTBot, ClaudeBot, etc.) blocked outright.

> **Note:** `Disallow: /.search*` covers `/.search/autocomplete`. Light interactive use is fine; do not bulk-iterate.

All anonymous endpoints below work without cookies. Send a real-looking `User-Agent` and `Accept: application/json`. Every subdomain shares the same routes for its own corpus. HTTP 404 with HTML body is the normal "not found" response.

## `GET /<Slug>.json` — full article

Append `.json` to any article URL. (`?format=json` does **not** work.)

Top-level keys:
| Field | Description |
|---|---|
| `id` | Numeric article ID |
| `title`, `url` | Title and canonical URL |
| `xhtml_body` | Rendered HTML (links, headings, figures resolved). Starts with lead paragraph (omits headword by convention). |
| `created_at`, `changed_at` | ISO timestamps |
| `subject_title`, `subject_url` | Taxonomy node |
| `authors` | Array of `{ full_name }` — **no** id, affiliation, ORCID, or ROR. Parse HTML JSON-LD for full citation data. |
| `images[]` | `{ full_size_url, standard_size_url, copyright, license, xhtml }` |
| `license_name` | Typically `"begrænset"` |
| `metadata` | Varies by type (person/place/concept). People: `birth_date`, `death_date`, `gender`, `birth_place`, `death_place`. |
| `professions`, `language` | |

Works on every subdomain (`trap.lex.dk/Aalborg.json`, `biografiskleksikon.lex.dk/Marie_-_dronning.json`). Returns 404 for unknown slugs or cross-subdomain lookups.

## `GET /.taxonomy/<id>.json` — taxonomy node

Returns `{ "taxonomy": { "title": "...", "ancestors": [{ "title", "url" }] } }`. `ancestors[].url` are `.json`-suffixed — walk up the tree by following them. **Does not include article list**; fetch HTML at `/.taxonomy/<id>` for that.

## `GET /.recent-activities.json` — edits feed

Array of edit objects. Key fields per item:
| Field | Description |
|---|---|
| `id` | Edit ID |
| `trackable_type` | e.g. `"Image"`, `"Article"` |
| `encyclopedia_id` | Numeric |
| `created_at` | ISO timestamp |
| `properties.action` | e.g. `"article.update"`, `"image.update"` |
| `properties.user_name` | Contributor name |
| `properties.article_url` | Slug only (not full URL) |
| `properties.article_title` | Article title |
| `properties.taxonomy_id`, `taxonomy_title` | |

## `GET /.search/autocomplete?query=<term>` — autocomplete

Returns up to 5 ranked suggestions across all subdomains. No pagination.

| Field | Description |
|---|---|
| `id` | Global article ID |
| `title` | Display title |
| `excerpt` | ~100-char snippet |
| `article_url` | Fully qualified URL |
| `permalink` | Slug only |
| `encyclopedia` | Empty for main site; source name otherwise (e.g. `"Dansk Biografisk Leksikon"`) |

Alternate form: `GET /.search/autocomplete.json?query=<term>`. Subdomain-scoped calls (e.g. `trap.lex.dk/.search/autocomplete`) return only that encyclopedia's hits.

## `GET /.announcements?v=2` — banners

Returns `{ "announcements": [] }`. Almost always empty. `?v=2` is the SPA cache-buster.

## `GET /api/definition/v1/definition/<word>` — dictionary

Passthrough to *Den Danske Ordbog*. Returns array of homonyms:
| Field | Description |
|---|---|
| `word`, `conjugation`, `partOfSpeech`, `phonetic` | Word metadata |
| `etymology` | Origin info |
| `definitions[]` | Each has `definition`, `usage`, `domain`, `synonyms`, `relateds`, `examples` |

## `GET /.status` — health check

Returns plaintext `ready`.

## Sitemap endpoints

`GET /.sitemap/sitemap.xml` — XML sitemap index listing `sitemap1.xml`…`sitemap6.xml` with `<lastmod>`.

`GET /.sitemap/sitemap<N>.xml` — each shard is a `<urlset>` of every article URL across all subdomains (~7–9 MB each). Includes `<lastmod>`, `<changefreq>`, `<priority>`, sometimes `<image:image>`. **Use to enumerate URLs — never crawl page-by-page.**

## HTML fallback routes

Prefer `.json` equivalents. Fall back to HTML when you need fields the JSON omits (schema.org JSON-LD with editor/ORCID/ROR).

| Route | Purpose |
|---|---|
| `GET /<Slug>` | Article HTML. Two `<script>` blocks: schema.org JSON-LD (full citation) and `dataLayer` (`articleId`, breadcrumbs). |
| `GET /.search?query=<term>&page=<n>` | Full search results. Hit count in first `<h2>`. |
| `GET /.alfabetisk/<L>/<page>` | Alphabetical article list. |
| `GET /.taxonomy/<id>` | Article list for a subject node (JSON form gives breadcrumbs only). |
| `GET /.temaside/<slug>` | Curated theme page. |
| `GET /.recent-activities` | ~400 kB HTML — use JSON form instead. |

## Helper script

`lex_dk_api.py` (in this folder) wraps verified endpoints. Standard library only. **`--host` is a top-level option, must precede subcommands.**

```bash
python3 lex_dk_api.py autocomplete Marie                        # autocomplete
python3 lex_dk_api.py --host trap.lex.dk autocomplete Aalborg   # subdomain autocomplete
python3 lex_dk_api.py article Marie_Curie                       # full article JSON
python3 lex_dk_api.py article-meta Marie_Curie                  # JSON-LD + articleId from HTML
python3 lex_dk_api.py taxonomy 1648                             # taxonomy node
python3 lex_dk_api.py recent                                    # edits feed
python3 lex_dk_api.py define blod                               # dictionary
python3 lex_dk_api.py announcements                             # banners
python3 lex_dk_api.py status                                    # health check
python3 lex_dk_api.py sitemap                                   # list sitemap shards
python3 lex_dk_api.py urls --shard 1                            # all <loc> URLs in shard 1
python3 lex_dk_api.py urls --shard 1 --grep Curie               # filter shard URLs
```

Pass `--raw` for raw JSON/XML output. Errors go to stderr, exit non-zero.

## Etiquette and licence

- Small Danish non-profit operates lex.dk. Throttle: stay under ~1 req/s. For bulk URL work, use the sitemap, not the search page. Heavy `/.search*` iteration is `Disallow`ed by `robots.txt`.
- Licence (`/.licenses/restricted`, "Begrænset anvendelse"): copyright-protected. Linking, citing under §22, and personal copies are fine. **Foreningen lex.dk has opted out of the §11 b stk. 2 text-and-data-mining exception** — do not build ML-training corpora; bulk redistribution requires permission. Image rights are per-image and may be more restrictive.
- Permissions: `info@lex.dk` / `https://om.lex.dk/Kontakt_redaktionen`. Educational/institutional reuse via Copydan Tekst & Node.
