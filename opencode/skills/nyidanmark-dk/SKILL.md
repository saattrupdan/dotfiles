---
name: nyidanmark-dk
description: nyidanmark.dk — the official Danish immigration portal. Covers the five main sections (apply, wait, answered, extend, situation-changed), sub-page hierarchy, search and news APIs, and the self-service Min Side portals. Use when the user wants to find immigration rules for a specific visa/residence category, learn what to do after applying or receiving a decision, or programmatically query the site's search/news APIs.
last-updated: 2026-05-09
---

# nyidanmark.dk — Danish immigration portal

Official entrypoint for foreign nationals seeking rules, guidance and application procedures for visiting, living or working in Denmark or Greenland. Operated by **Udlændingestyrelsen** and **SIRI** on Sitecore CMS with AngularJS. Anonymous browsing is fully open; "Min Side" self-service uses separate sub-domains with MitID login. Site language: Danish — respond in Danish unless the user signals otherwise.

All URLs are relative to `https://nyidanmark.dk/`. Slugs use **URL-encoded Danish letters** (`æ`→`%C3%A6`, `ø`→`%C3%B8`, `å`→`%C3%A5`, `Æ`→`%C3%86`, `Ø`→`%C3%98`, `Å`→`%C3%85`). Trailing slashes are generally accepted.

## Five main sections

Each section is a hub page linking to sub-category pages. Every hub follows `/da/<Section>/<Category>`:

| Section | URL | Meaning |
|---|---|---|
| Du vil **ansøge** | `/da/Du-vil-ans%C3%B8ge` | New applications (visa, residence, work, study, family reunification, asylum…) |
| Du **venter svar** | `/da/Du-venter-svar` | Status info after submitting an application |
| Du har **fået svar** | `/da/Du-har-f%C3%A5et-svar` | What to do after approval or rejection |
| Du vil **forlænge** | `/da/Du-vil-forl%C3%A6nge` | Extending an existing residence permit |
| Din situation **ændrer sig** | `/da/Din-situation-%C3%A6ndrer-sig` | How life changes affect your permit |

Category names (e.g. `Familie`, `Arbejde`, `Studie`, `Asyl`, `Kort-ophold-(Visum)`, `Ph_d_`, `Permanent-ophold`, `Ukraine`) are mostly consistent across sections.

## Min Side — self-service portals

`/da/MinSide` links to separate sub-domains (each with its own MitID login):
- `https://minside.nyidanmark.dk/en-US/minside` — case status for submitted applications
- `https://nyidanmark.dk/en-us/siri-myoverview` — saved applications (SIRI)
- `https://www.nyidanmark.dk/us-mitoverblik` — saved + submitted applications (Immigration Service)

## English mirror

`/en-GB/` — limited translation of selected pages. Not all content has an English equivalent.

## Quick recipes

- **Find rules for a permit type**: go to the relevant section → pick the category card → read the sub-page.
- **After getting an answer**: `/da/Du-har-f%C3%A5et-svar` → pick category.
- **Track submitted application**: `https://minside.nyidanmark.dk/en-US/minside` (requires login).
- **Search**: on-site at `/da/S%C3%B8geresultater` (client-side rendering) or the internal API below.
- **Read in English**: append `/en-GB` to the Danish URL if available.

## Limits

- **No application submission.** The site is informational only. Applications go through Min Side portals or paper forms.
- **No personal-data API.** Case details and status are only in the Min Side login portals.
- **Site search is client-side.** Use the internal `/api/search` endpoint for programmatic access.
- **English content is incomplete.**
- **No documented contract.** Endpoints are inferred from rendered HTML and JS bundles — expect breaking changes.

## Internal JSON API

Base: `https://nyidanmark.dk/api/`. No API key, no auth, no OpenAPI spec. Most endpoints are `GET` with query params; some (news, forms, payments) are `POST` with `Content-Type: application/json`. Server: `Microsoft-IIS/10.0`. Error envelope: `{"Message":"<text>"}` with `4xx`/`5xx`. Set a realistic browser `User-Agent`.

### Auth model

All listed endpoints work **without authentication**.

### `GET /api/search/getsearchresults?query=<term>&page=<n>` — site search

Backs the on-site search. Returns ranked results across pages and news.

```
GET /api/search/getsearchresults?query=visum&page=1
```

**Response** (`application/json`):
```json
{
  "Results": [
    {
      "Title": "Indrejse til Færøerne og Grønland",
      "Text": "Du er tredjelandsstatsborger og ønsker at besøge Færøerne…",
      "ResultType": "Components",
      "ResultDate": "2026-03-20T15:31:39Z",
      "Score": 6.05758,
      "Link": "/da/Du-vil-ans%C3%B8ge/Kort-ophold-(Visum)/Visum-til-Gr%C3%B8nland-og-F%C3%A6r%C3%B8erne"
    }
  ]
}
```

Fields: `Title` (headline), `Text` (lead excerpt), `ResultType` (`"Components"` for pages, `"News Article"` for news), `ResultDate` (ISO-8601), `Score` (relevance), `Link` (relative URL). Pagination: `page` (1-indexed), ~200 results per page.

### `POST /api/news/getNews` — news articles

Optional JSON body with `newsTypeTag` to filter.

```json
{"newsTypeTag": "Arbejde"}
```

**Response**:
```json
{
  "newsArticles": [
    { "Title": "...", "Text": "...", "Link": "/da/Nyheder/2026/04/...", "Date": "2026-04-23T..." }
  ]
}
```
Empty body `{}` returns an empty array. Use `/api/news/getTags` to discover tags.

### `GET /api/news/getTags` — news tag taxonomy

Returns the full hierarchy of news categories.

**Response**:
```json
{
  "result": "[{\"TagName\":\"Asyl\",\"SubTags\":[]},{\"TagName\":\"Arbejde\",\"SubTags\":[\"'Fast-track ordningen'\",\"'Positivlisten for faglærte'\",...]}]"
}
```
The `result` field is a JSON-encoded string — parse twice. Sub-tags have extra quotes (`'Børn'`) — strip them.

## Helper script

`nyidanmark_dk_api.py` (in this skill folder) wraps the anonymous endpoints. Standard library only.

```bash
python3 nyidanmark_dk_api.py search visum                      # search for "visum"
python3 nyidanmark_dk_api.py search "arbejde" --page 2         # page 2 of results
python3 nyidanmark_dk_api.py news-tags                         # list news category tags
python3 nyidanmark_dk_api.py news "Arbejde"                    # news for Arbejde category
python3 nyidanmark_dk_api.py endpoints                         # all /api/* paths on the home page
```

Each subcommand exits non-zero on HTTP error and writes the response body to stderr.
