# lex-dk

Reference for navigating lex.dk — Denmark's national encyclopedia ("Danmarks Nationalleksikon").

## Requirements

- No CLI script — this is a site-navigation skill
- Internet access to `lex.dk` and its subdomains
- Reading licence compliance (see `/.licenses/restricted`)

## Quick Start

```bash
# Read an article directly
open https://lex.dk/Marie_Curie

# Search for a term
open https://lex.dk/.search?query=Marie

# Browse by subject taxonomy
open https://lex.dk/.taxonomy/1648

# Browse alphabetically
open https://lex.dk/.alfabetisk/M/1
```

## Navigation Reference

### Article URL conventions

| Pattern | Meaning |
|---|---|
| `https://lex.dk/<Slug>` | An article. Spaces → `_`, Danish letters URL-encoded, disambiguation → `_-_` |
| `/<Slug>#-<Section_anchor>` | Link to a specific section within an article |
| `https://lex.dk/.search?query=<term>&page=<n>` | Search results (HTML) |
| `https://lex.dk/.alfabetisk/<L>/<page>` | Alphabetical browse (A–Z, Æ, Ø, Å, #) |
| `https://lex.dk/.taxonomy/<id>` | Subject-tree node |
| `https://lex.dk/.temaside/<slug>` | Editorial theme page |
| `https://lex.dk/.recent-activities` | Recent edits across the site |

### Subdomain encyclopedias

| Subdomain | Encyclopedia |
|---|---|
| `trap.lex.dk` | Trap Danmark — modern geography/topography |
| `trap5.lex.dk` | Trap Danmark, 5th ed. (1953–1972) |
| `denstoredanske.lex.dk` | Den Store Danske — legacy Gyldendal encyclopedia |
| `biografiskleksikon.lex.dk` | Dansk Biografisk Leksikon — historical Danes |
| `kvindebiografiskleksikon.lex.dk` | Dansk Kvindebiografisk Leksikon |
| `danmarkshistorien.lex.dk` | Danmarkshistorien — peer-written Danish history |
| `naturenidanmark.lex.dk` | Naturen i Danmark — flora, fauna, ecology |
| `symbolleksikon.lex.dk` | Symbolleksikon — symbols & iconography |
| `om.lex.dk` | About, terms, privacy, editorial contact |

### Common tasks

| Task | Approach |
|---|---|
| Look up a person/place/term | Try `https://lex.dk/<Title>` first; if 404, use search or autocomplete |
| Cite an article | Parse the schema.org JSON-LD block in the page |
| Find a Danish place | Prefer `trap.lex.dk` |
| Find a historical biography | Prefer `biografiskleksikon.lex.dk` |
| Browse by theme | Walk `/.temaside/<slug>` or the front-page taxonomy list |
| Enumerate all articles | Walk `/.sitemap/sitemap.xml` → 6 sub-sitemaps |

## Troubleshooting

- **404 on an article** — Slugs are case-sensitive. Proper nouns are capitalised (`Marie_Curie`), common nouns are lower-case (`statiner`). Try the search page instead.
- **Bulk-scraping blocked** — `robots.txt` explicitly blocks every major LLM crawler. Read interactively or by user request only.
- **Missing data in `.json` endpoint** — The JSON endpoint omits editor/ORCID/ROR fields. Fetch the HTML page and parse the `<script type="application/ld+json">` block for full citation data.
