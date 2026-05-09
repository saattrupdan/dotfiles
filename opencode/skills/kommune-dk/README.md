# kommune-dk

Reference for navigating kommune.dk — a standalone WordPress 6.9.4 informational portal covering all 98 Danish municipalities. Each municipality has a static page with demographics, housing, schools, parking, culture, business, and citizen services.

## Requirements

- Internet access to `www.kommune.dk`
- URL slugs use ASCII transliteration: `æ`→`ae`, `ø`→`oe`, `å`→`a`
- Conservative crawl policy: `robots.txt` sets `Crawl-delay: 10`

## Quick Start

```bash
# Look up a municipality page
open https://www.kommune.dk/koebenhavn/
open https://www.kommune.dk/aarhus/
open https://www.kommune.dk/oes/

# REST API: list all pages
curl 'https://www.kommune.dk/wp-json/wp/v2/pages'

# REST API: lookup by slug
curl 'https://www.kommune.dk/wp-json/wp/v2/pages?slug=koebenhavn'

# REST API: individual page by ID
curl 'https://www.kommune.dk/wp-json/wp/v2/pages/{id}'

# Sitemap
curl 'https://www.kommune.dk/wp-sitemap-posts-page-1.xml'
```

## Navigation Reference

### URL pattern

`https://www.kommune.dk/{slug}/` — one page per municipality.

Slug examples: `koebenhavn/` (København), `aarhus/` (Aarhus), `broendby/` (Brøndby), `laesoe/` (Læsø), `hoersholm/` (Hørsholm).

### Section layout (each municipality page)

Every page follows a consistent 12-section structure:

1. Overblik — demographics / population
2. Historisk rids — historical overview
3. Borgerservice — citizen services
4. Boligmarkedet — housing market
5. Parkeringsmuligheder — parking
6. Affald, miljø — waste / environment
7. Skoler og pasning — schools / care
8. Uddannelsessteder — education venues
9. Kulturliv og events — culture / events
10. Erhvervsliv og job — business / jobs
11. Foreningsliv — community life / associations
12. Populære bydele — popular neighbourhoods

### WordPress REST API

| Endpoint | Description |
|---|---|
| `GET /wp-json/wp/v2/pages` | List all 98 municipality pages |
| `GET /wp-json/wp/v2/pages?slug={slug}` | Lookup by slug |
| `GET /wp-json/wp/v2/pages/{id}` | Individual page (block HTML in `content.rendered`) |
| `GET /wp-json/oembed/1.0/embed?url={url}` | oEmbed by URL |

## Troubleshooting

- **No blog posts or categories** — the site is flat: 98 pages + 1 homepage.
- **Block editor HTML** — content is rendered block HTML in `post_content`; parse `content.rendered` from the REST API.
- **Crawl delay** — `robots.txt` sets `Crawl-delay: 10`; be conservative with requests.
- **No navigation menus or footer links** — no About, Contact, or Privacy pages exist.
