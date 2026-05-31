# retsinformation-dk

Reference for navigating retsinformation.dk — Denmark's central legal information portal operated by Civilstyrelsen. Provides access to Danish laws, regulations, circulars, parliamentary documents, and Ombudsman decisions. All content loads client-side (React SPA).

## Requirements

- `retsinformation` CLI — standard library only (`pipx install -e .`)
- Internet access to `www.retsinformation.dk`
- No login required; all endpoints are anonymous

## Quick Start

```bash
# Look up a law by year and number (ELI URL)
open https://www.retsinformation.dk/retsinfo/2024/0001
open https://www.retsinformation.dk/retsinfo/2024/0001/html  # raw HTML

# Look up by accession number
open https://www.retsinformation.dk/eli/accn/A20240001

# Parliamentary document
open https://www.retsinformation.dk/eli/ft/A20240001

# CLI: law register tree
retsinformation law-registers

# CLI: document types (Regler, Afgørelser)
retsinformation doc-types

# CLI: list ministries
retsinformation ressort

# CLI: ELI routing table
retsinformation eli-routing

# CLI: document by ELI path (POST)
retsinformation document eli/lta/2026/480
retsinformation document eli/accn/A20240001

# CLI: document metadata (requires numeric internal ID from document response)
retsinformation document 256418 --metadata

# CLI: document timeline (requires numeric internal ID from document response)
retsinformation document 256418 --timeline

# CLI: ELI authority values
retsinformation authority-lists type_document
```

## Navigation Reference

### ELI URL patterns (document access)

| Pattern | Example | Meaning |
|---|---|---|
| `/{pubMedia}/{year}/{number}` | `/retsinfo/1989/0001` | CST canonical |
| `/eli/accn/{accn}` | `/eli/accn/A19890001` | Accession alias |
| `/eli/ft/{accn}` | `/eli/ft/A19890001` | Parliamentary doc |
| `/eli/eu/{celex}` | `/eli/eu/CELEX:31989L0048` | EU document |
| `/{cls}/{docType}/{year}/{month}/{day}/{number}` | `/eli/regel/lovh/2024/01/15/001` | Classification alias |

Add suffixes for format: `/html`, `/dan`, `/dan/html`, `/rawhtml`.

### Internal APIs

| Endpoint | Purpose |
|---|---|
| `GET /api/extremesearch/GetLawRegisters` | Law register tree (ministry/topic) |
| `GET /api/extremesearch/GetFobTags` | Subject/tag filter tree |
| `GET /api/extremesearch/getcasehistorystatus` | Parliamentary case statuses |
| `GET /api/documentClassificationfilter` | Document type filter |
| `GET /api/lawregistry` | Law registry (A–Z index) |
| `GET /api/ressort` | Ministries |
| `GET /api/eli/routing-data` | ELI URL param → documentTypeId mapping |
| `GET /api/eli/named-authority-lists` | ELI authority codes |
| `GET /api/eli/documentation/uri-templates` | ELI URI templates |
| `GET /api/document/{id}` | Document by numeric ID |
| `GET /api/document/metadata/{id}` | Document metadata |
| `GET /api/document/{id}/timeline` | Legislative history |
| `GET /api/maintenance/messages` | Active maintenance notices |

## Troubleshooting

- **No public search API** — the main search is a client-side form. Use the website search or browse by filters.
- **SPA-only rendering** — all routes return the same shell HTML; content loads via internal APIs.
- **Undocumented APIs** — all `/api/*` endpoints are internal and may change without notice.
- **Danish language** — all content, labels, and API responses are in Danish.
