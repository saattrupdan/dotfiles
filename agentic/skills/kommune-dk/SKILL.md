---
name: kommune-dk
description: Standalone WordPress portal covering all 98 Danish municipalities with structured content on demographics, housing, schools, culture, and citizen services. Use when the user wants factual information about a Danish municipality, retrieved via the website or public REST API.
last-updated: 2026-05-09
---

# Kommune.dk

**Kommune.dk** is a Danish informational portal covering all 98 municipalities ("kommuner") in Denmark. Tagline: *"Nyttig viden om alle kommuner i Danmark"* ("Useful knowledge about all municipalities in Denmark.").

Base URL: `https://www.kommune.dk/`

## Site structure

WordPress 6.9.4, Twenty Twenty-Five FSE theme, pure PHP-rendered HTML. 99 flat pages: 98 municipalities + 1 homepage. No blog, no comments, no custom post types.

Each page has 12 sections: overblik, historisk ridse, borgerservice, boligmarkedet, parkering, affald/miljø, skoler/pasning, uddannelsessteder, kulturliv, erhvervsliv, foreningsliv, populære bydele.

## URL structure

| Page | URL |
|---|---|
| Homepage | `https://www.kommune.dk/` (page ID 2, slug `kommune-dk`) |
| Municipality | `https://www.kommune.dk/{slug}/` |

### Slug normalization

Danish characters are ASCII-transliterated:

| Character | Replacement |
|---|---|
| Æ | ae |
| Ø | oe |
| Å | a |

Examples: `koebenhavn/` (København), `broendby/` (Brøndby), `laesoe/` (Læsø), `hoersholm/` (Hørsholm).

## WordPress REST API (public, anonymous)

| Endpoint | Description |
|---|---|
| `GET /wp-json/` | Site info |
| `GET /wp-json/wp/v2/pages` | List all pages |
| `GET /wp-json/wp/v2/pages/{id}` | Individual page content |
| `GET /wp-json/wp/v2/pages?slug={slug}` | Lookup by slug |
| `GET /wp-json/wp/v2/pages?per_page={n}` | Pagination |
| `GET /wp-json/wp/v2/users/1` | Author info |
| `GET /wp-json/wp/v2/types/page` | Post type registry |
| `GET /wp-json/oembed/1.0/embed?url={url}` | oEmbed by URL |

All page content is publicly readable. Block HTML is in `content.rendered`.

## Common task recipes

- **Municipality info**: visit `https://www.kommune.dk/{slug}/` or `GET /wp-json/wp/v2/pages?slug={slug}`
- **List all municipalities**: `GET /wp-json/wp/v2/pages` or parse `/wp-sitemap-posts-page-1.xml`
- **Get page content**: `GET /wp-json/wp/v2/pages/{id}` returns full block HTML
- **Crawl policy**: robots.txt specifies `Crawl-delay: 10`
