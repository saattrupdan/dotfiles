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
including Startpage, Brave, Google CSE, and DuckDuckGo. This establishes the
initial cutover gate; engine reliability should be revisited if searches begin
reporting persistent warnings or empty result sets.
