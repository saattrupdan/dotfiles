---
name: retsinformation-dk
description: retsinformation.dk — Denmark's central legal information portal. Use when the user wants to look up Danish law/regulations, retrieve legislation metadata, find parliamentary documents, or navigate by ministry/topic.
last-updated: 2026-05-09
---

# retsinformation.dk — Danish legal information portal

Operated by *Civilstyrelsen* (Viborg). Free, anonymous, no login. All content loads client-side (React SPA). Respond in Danish unless the user signals otherwise.

## ELI URL patterns

Retsinformation uses the EU ELI standard. Document URIs:

| Pattern | Example | Meaning |
|---|---|---|
| `/{pubMedia}/{year}/{number}` | `/retsinfo/1989/0001` | CST canonical |
| `/eli/accn/{accn}` | `/eli/accn/A19890001` | Accession alias |
| `/eli/ft/{accn}` | `/eli/ft/A19890001` | Parliamentary doc |
| `/eli/eu/{celex}` | `/eli/eu/CELEX:31989L0048` | EU/CLEX |
| `/{cls}/{docType}/{year}/{month}/{day}/{number}` | `/eli/regel/lovh/2024/01/15/001` | Classification alias |

Suffixes for content format: `/html` (raw HTML), `/dan` (Danish text), `/dan/html`, `/rawhtml`.

Publication media codes in URLs: `lta`, `ltb`, `ltc`, `mt`, `retsinfo`, `ft`, `fob`.

## Internal JSON APIs

All endpoints return JSON, are anonymous, and use `GET`. Base URL: `https://www.retsinformation.dk/`. Undocumented — may change without notice.

### Filter/register trees

- **`/api/extremesearch/GetLawRegisters`** — Hierarchical law register tree by ministry/topic. Response: `[{value, title, children: [...]}]`.
- **`/api/extremesearch/GetFobTags`** — Hierarchical subject tags (same shape).
- **`/api/extremesearch/getcasehistorystatus`** — Parliamentary case history statuses. Response: `[{id, name}]` (Afvist, Beretning afgivet, Bortfaldet, Delt, Forkastet, Igangværende, Tilbagetaget, Vedtaget).
- **`/api/documentClassificationfilter`** — Document type filter tree. Top-level: `Regler` and `Afgørelser`. Response: `[{ids, key, displayName, documentTypes: [{documentTypeId, name, popularName}]}]`. Use `documentTypeId` for API filters.
- **`/api/lawregistry`** — Flat A–Z law register list. Response: `[{id, label, key}]`.
- **`/api/ressort`** — Ministries. Response: `[{id, name}]`.
- **`/api/ressort/fob`** — Ministries under Parliamentary Ombudsman (same shape).

### ELI routing & documentation

- **`/api/eli/routing-data`** — Maps URL param keys to `documentTypeId`. Key entries: `lovh`→10 (Lov), `lovc`→20 (Ændringslov), `lbkh`→30 (Lovbekendtgørelse), `dskh`→40 (Datasammenskrivning), `fin`→50 (Tekstanmærkning), `bekh`→60 (Bekendtgørelse), `bkr`→70 (Cirkulære), `bekc`→80 (Bekendtgørelse), `beki`→90 (Ikrafttrædelsesbekendtgørelse), `andh`→100 (Anordning), `andc`→110 (Andet).
- **`/api/eli/named-authority-lists`** — Definitive ELI authority codes. Keys: `type_document` (LOVH, LTBB, LOVC, …), `passed_by` (FOL, REG, …), `relevant_for` (INDOC, FO, GR, DK, …).
- **`/api/eli/documentation/uri-templates`** — ELI URI templates. Key types: `canonicalCst` (`/{pubMedia}/{year}/{number}`), `partialCst` (`/{pubMedia}/{year}`), `canonicalFt` (`/ft/{accn}`), `accn_alias` (`/eli/accn/{accn}`), `classification_alias` (`/{cls}/{docType}/{year}/{month}/{day}/{number}`).
- **`/api/eli/documentation/metadata-types`** — ELI ontology metadata properties. Response: `[{key, types: [{id, type}]}]`. Key keys: `LegalResource`, `Expression`, `Manifestation`, `Item`.

### Document endpoints

- **`POST /api/document/{eli_path}`** — Document details by ELI path (e.g. `eli/lta/2026/480`, `eli/accn/A20240001`). Body: `{"isRawHtml": false}`. Response: `[{}]` (fields: `id`, `accessionNumber`, `title`, `documentTypeId`, `shortName`, `documentHtml`, `ressort`, `metadata`). The `id` field is an internal numeric ID used for timeline/metadata lookups.
- **`/api/document/metadata/{id}`** — Structured metadata for a document (GET, uses internal numeric `id`).
- **`/api/document/{id}/timeline`** — Legislative history/timeline (GET, uses internal numeric `id`). Response: `[...]`.
- **`/api/document/documentLinks/{id}/references/{showRelated}`** — References (changes, commenced by, etc.).
- **`/api/document/documentLinks/{id}/{group}`** — Grouped document links.

### Maintenance & static files

- **`/api/maintenance/messages`** — Active maintenance notices (usually empty).
- **Static files**: `/static/eli-metadata-documentation.json`, `/static/eli-parameters-documentation.json`, `/static/eli-technical-documentation.json`, `/static/eliIntro.da.html`, `/static/eliIntro.en.html`.

### Sitemap

`https://www.retsinformation.dk/sitemap.xml` — Single XML with `<url>` entries for all pages. Use to enumerate all URLs.

## Key limits

- No public search API — search is a client-side form posting to extremesearch.
- No authentication required — fully anonymous.
- SPA-only — all routes return the same shell HTML; content loads via internal APIs.
- Undocumented APIs — internal endpoints may change without notice.
