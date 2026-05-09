# frederiksberg-dk

Reference for navigating frederiksberg.dk — the official website of Frederiksberg Municipality. Built on ASP.NET MVC + Umbraco CMS with Alpine.js and Cludo search. Five citizen-facing sections plus English mirror.

## Requirements

- `frederiksberg_dk_api.py` CLI helper — standard library only
- Internet access to `www.frederiksberg.dk`
- URL slugs use Danish letters spelled out: `æ`→`ae`, `ø`→`oe`, `å`→`aa`

## Quick Start

```bash
# Citizen services
open https://www.frederiksberg.dk/borgerservice
open https://www.frederiksberg.dk/borgerservice/aegteskab-og-vielser

# English mirror
open https://www.frederiksberg.dk/en

# CLI: typeahead search
python3 frederiksberg_dk_api.py typeahead pas --lang da

# CLI: top FAQ questions
python3 frederiksberg_dk_api.py top-questions

# CLI: site map
python3 frederiksberg_dk_api.py sitemap --section borgerservice

# CLI: page metadata
python3 frederiksberg_dk_api.py article /borgerservice/pas --raw
```

## Navigation Reference

### Top-level sections

| Section | URL | What it covers |
|---|---|---|
| Borgerservice | `/borgerservice` | Pass, driver's licence, marriage, funeral, ID cards, pension |
| By, Bolig og Miljø | `/by-bolig-og-miljoe` | Waste, housing, construction permits, parking, environment |
| Dagtilbud og Skole | `/dagtilbud-og-skole` | Daycare, schools, school holidays, private care |
| Erhverv | `/erhverv` | Business permits, tenders, recruitment, green programs |
| Social og Sundhed | `/social-og-sundhed` | Elderly services, disability, health, child support |
| Job og Ledighed | `/job-og-ledighed` | Unemployment benefits, integration programs |
| Politik | `/politik` | Council meetings, agendas, minutes, policies |
| Kommunen | `/kommunen` | News, press room, contact, jobs |
| Fritid og Oplevelser | `/fritid-og-oplevelser` | Events, facilities, grants |

### Internal APIs

| Endpoint | Purpose |
|---|---|
| `GET /api/search/GetTypeAhead?searchTerm=<q>&lang=da` | Autocomplete suggestions |
| `POST /api/search/GetTopQuestions` | Editorial FAQ questions |
| `GET /surface/AgendaSurface/GetAgendaList?pageId=<id>&pageUrl=<url>&folderId=<id>&elementId=<id>` | Council meeting agendas |
| Sitemap | `/sitemap.xml` (~720 URLs) |

## Troubleshooting

- **No personal-data API** — appointment booking and payments are on Borger.dk, not this site.
- **No structured content API** — pages are server-rendered HTML only. Use the sitemap to enumerate.
- **English content is incomplete** — many service pages exist only in Danish.
- **APIs are undocumented** — internal endpoints may change without notice.
