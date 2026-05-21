---
name: frederiksberg-dk
description: Frederiksberg Kommune's official website — citizen-facing sections, internal APIs (typeahead search, agenda, top questions), and common procedure recipes. Use when the user asks about Frederiksberg municipal services, regulations, events, or how to find information on frederiksberg.dk.
last-updated: 2026-05-09
---

# Frederiksberg Kommune — www.frederiksberg.dk

Official website of **Frederiksberg Kommune** (one of Denmark's 98 municipalities). Built on **ASP.NET MVC + Umbraco CMS** with **Alpine.js** and **Cludo** search. Content is Danish by default; an English mirror exists at `/en` covering a subset.

**Not `kommune.dk`** — that is a generic WordPress site about all Danish municipalities.

## Top-level sections

| Section | URL | What it covers |
|---|---|---|
| **Borgerservice** | `/borgerservice` | Pass, driver's licence, marriage, death/funeral, ID cards, pension, holiday pay, digital post exemption, power of attorney, opening hours, appointment booking |
| **By, Bolig og Miljø** | `/by-bolig-og-miljoe` | Waste & recycling, housing, construction permits, traffic & parking, climate & environment, urban planning, flood adaptation |
| **Dagtilbud og Skole** | `/dagtilbud-og-skole` | Daycare, schools, school holidays, private care, pricing, school choice, special education |
| **Erhverv** | `/erhverv` | Business services, permits & licenses, waste for businesses, tenders, procurement, recruitment |
| **Social og Sundhed** | `/social-og-sundhed` | Elderly services, disability, health & nursing, child & family support, dental care |
| **Job og Ledighed** | `/job-og-ledighed` | Unemployment benefits, integration programs, courses |
| **Politik** | `/politik` | Council meetings, agendas, minutes, policies, get involved |
| **Kommunen** | `/kommunen` | News, press room, contact, jobs, facts about the city |
| **Fritid og Oplevelser** | `/fritid-og-oplevelser` | Events, facilities, flea markets, grants & funds |

## URL conventions

- Slugs spell out Danish letters: `æ` → `ae`, `ø` → `oe`, `å` → `aa`.
- Example: `/borgerservice/aegteskab-og-vielser`, `/by-bolig-og-miljoe/trafik/parkering`.
- Page metadata lives in HTML `<meta>` tags:
  - `pageId` — Umbraco page ID (integer)
  - `page_date` — ISO-8601 last-modified date
  - `page_breadcrumb` — pipe-separated breadcrumb trail
  - `author` — editor email
  - `page_Image` — hero image URL with resize params

## English mirror

Root: `/en/`. Key mappings:

| Danish | English |
|---|---|
| `/borgerservice` | *(none — personal admin is Borger.dk)* |
| `/erhverv` | `/en/business/...` |
| `/fritid-og-oplevelser` | `/en/leisure-and-culture` |
| `/job-og-ledighed` | `/en/work/...` |
| `/politik` | `/en/politics/...` |

Not every Danish page has an English sibling. Check `<link rel="alternate" hreflang="en-us">` in the page source.

## Sitemap

`https://www.frederiksberg.dk/sitemap.xml` — single XML file, **~720 URLs**, with `<lastmod>` and `<changefreq>`.

## Internal APIs

Undocumented but functional, called from `/js/bundle.js`.

### Typeahead search — `GET /api/search/GetTypeAhead`

Autocomplete suggestions from the search box.

```
GET /api/search/GetTypeAhead?searchTerm=<query>&lang=<da|en>
```

Returns JSON with a `results` array. Each item has `title`, `url`, `description`, `type`.

```bash
curl 'https://www.frederiksberg.dk/api/search/GetTypeAhead?searchTerm=pas&lang=da'
```

### Top questions — `POST /api/search/GetTopQuestions`

Editorially-curated FAQs shown on the search page.

```
POST /api/search/GetTopQuestions
Content-Type: application/json
Body: {}
```

Returns JSON with a `questions` array (`question` field, optional `url`).

### Agenda surface — `GET /surface/AgendaSurface/GetAgendaList`

Municipal council meeting agenda items.

```
GET /surface/AgendaSurface/GetAgendaList?pageId=<int>&pageUrl=<url>&folderId=<int>&elementId=<int>&pageSize=<int>&pageNumber=<int>
```

Required: `pageId` (from `<meta name="pageId">`), `pageUrl`, `folderId`, `elementId`. Returns JSON with an `items` array (`title`, `date`, `description`, links).

## Common citizen tasks

| Task | How |
|---|---|
| Find info about a service | Browse section table or use typeahead API |
| Read a specific article | Navigate to the URL directly; extract metadata from `<meta>` tags |
| Book an appointment | Go to `/borgerservice/tidsbestilling` → link to Borger.dk |
| Read meeting agendas | `/politik/moeder-dagsordener-og-referater` or Agenda API |
| Find news | `/kommunen/nyheder` |
| Read in English | Append `/en` where a version exists |
| Contact info | `/kommunen/forvaltning-og-fakta-om-kommunen/kontakt` |
| Parking rules | `/by-bolig-og-miljoe/trafik/parkering` |
| Waste collection | `/by-bolig-og-miljoe/affald-og-genbrug` |
| Register child in daycare | `/dagtilbud-og-skole/boernehave/skriv-op-til-boernehave` |
| Building permit | `/by-bolig-og-miljoe/byggeri/byggetilladelse` |
| Business permits | `/erhverv/tilladelse-og-bevillinger` |

## Limits worth flagging

- **No personal-data API.** Citizen services (booking, payment, admin) are on **Borger.dk** (`https://www.borger.dk/`).
- **No structured content API.** Pages are server-rendered HTML. Use the sitemap to enumerate URLs, then fetch pages.
- **Search is limited.** Typeahead API returns suggestions only, not full results.
- **English content is incomplete.** Many pages exist only in Danish.
- **Internal APIs are undocumented.** May change without notice.

## Helper script

`frederiksberg_dk_api.py` (this folder) wraps the useful APIs. Standard library only.

```bash
python3 frederiksberg_dk_api.py typeahead pas --lang da               # typeahead search
python3 frederiksberg_dk_api.py top-questions                         # FAQ questions
python3 frederiksberg_dk_api.py agenda --page-id 11076 --page-url / --folder-id 0 --element-id 0
                                                                       # meeting agenda
python3 frederiksberg_dk_api.py sitemap --section borgerservice       # list URLs
python3 frederiksberg_dk_api.py article /borgerservice/pas --raw     # page metadata
```

Each subcommand exits non-zero on HTTP error and writes the error body to stderr.
