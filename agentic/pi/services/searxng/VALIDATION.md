# SearXNG validation

Validated locally on 9 September 2026 against the image pinned in
[`compose.yml`](compose.yml). The service was bound only to
`127.0.0.1:8888`, returned valid JSON, and reported no unresponsive engines
for any validation query.

| Query | Top-five relevance | Authoritative results | Latency |
| --- | ---: | ---: | ---: |
| Danish public-sector AI guidance | 5/5 | 5/5 | 0.745 s |
| EU AI Act implementation news, past month | 5/5 | 2/5 | 1.065 s |
| SearXNG JSON API configuration | 5/5 | 2/5 | 0.767 s |

The Danish query ranked Digitaliseringsstyrelsen and Datatilsynet first. The
freshness query included the European Data Protection Supervisor and a European
national data-protection authority. The technical query ranked SearXNG's own
Search API documentation first and its settings source third.

The three requests returned 39, 53, and 37 total results respectively. Their
top results were independently corroborated by multiple configured engines,
including Startpage, Brave, Google CSE, and DuckDuckGo. This established the
initial cutover gate.

## Rate-limit revalidation

Revalidated on 11 September 2026 after those original engines began returning
persistent traffic blocks, CAPTCHAs, and parser errors. The replacement Google,
Seznam, and Yep engine set returned 32, 36, and 28 results for the three failing
OpenAI `site:` queries that prompted the change. All three searches completed in
under two seconds and reported no unresponsive engines.
