---
name: retsinformation-dk
description: retsinformation.dk — Denmark's central legal information portal. Use when the user wants to look up Danish law/regulations, retrieve legislation metadata, find parliamentary documents, or navigate by ministry/topic.
last-updated: 2026-05-31
---

# retsinformation.dk — Danish legal information portal

Operated by *Civilstyrelsen* (Viborg). Free, anonymous, no login. Respond in Danish unless the user signals otherwise.

**Use the `retsinformation` CLI for everything.** Run `retsinformation ...` to look up laws, metadata, timelines, registers, ministries and ELI documentation.

## CLI

The `retsinformation` CLI can be run from anywhere — no need to point at the skill directory. Pure Python standard library, no extra dependencies.

### Limits

- No public search API: the site is a React SPA with no server-rendered HTML and no search endpoint, so use the CLI's register/registry/sitemap commands to discover documents rather than scraping or searching the site.
- All access is anonymous (no login).

### Prerequisites

Verify the CLI is installed:

```bash
which retsinformation
```

If missing, install it editable with pipx (from the skill directory). First make sure pipx itself is available, then install:

```bash
# Ensure pipx is installed
which pipx || python3 -m pip install --user pipx
python3 -m pipx ensurepath

# Install the retsinformation CLI
pipx install -e <path-to-retsinformation-dk-skill>
```

After installing, confirm `retsinformation` is on the PATH (you may need to restart the shell so `pipx ensurepath` takes effect):

```bash
which retsinformation
```

### Command reference

Every command supports `--raw` to print the unformatted JSON/XML response instead of the cleaned output.

| Command | Purpose | Example |
|---|---|---|
| `law-registers` | Hierarchical law register tree by ministry/topic | `retsinformation law-registers` |
| `fob-tags` | Hierarchical subject/tag tree (used for filtering) | `retsinformation fob-tags` |
| `case-statuses` | Parliamentary case-history statuses (Afvist, Vedtaget, …) | `retsinformation case-statuses` |
| `doc-types` | Document type filter tree (`Regler`, `Afgørelser`); gives `documentTypeId`s | `retsinformation doc-types` |
| `law-registry` | Flat A–Z law registry; `--filter <substr>`, `--sort`, `--limit <n>` | `retsinformation law-registry --filter miljø --sort --limit 20` |
| `ressort` | List of Danish ministries | `retsinformation ressort` |
| `fob-ressort` | Ministries under the Parliamentary Ombudsman | `retsinformation fob-ressort` |
| `eli-routing` | ELI URL routing table (param key → `documentTypeId`) | `retsinformation eli-routing` |
| `authority-lists` | ELI authority value summary; pass one authority to expand it | `retsinformation authority-lists type_document` |
| `uri-templates` | ELI URI template definitions | `retsinformation uri-templates` |
| `metadata-types` | ELI ontology metadata property definitions | `retsinformation metadata-types` |
| `document <id>` | Fetch a document; see below | `retsinformation document eli/lta/2026/480` |
| `maintenance` | Active maintenance notices (usually none) | `retsinformation maintenance` |
| `sitemap` | Enumerate URLs from `sitemap.xml`; `--filter <substr>`, `--limit <n>` | `retsinformation sitemap --filter eli --limit 50` |

### Looking up documents

`document` takes either an **ELI path** (for the document body/details) or a **numeric internal ID** (for `--timeline` / `--metadata`):

```bash
# Document details by ELI path (POSTs the ELI path to the document API)
retsinformation document eli/lta/2026/480
retsinformation document eli/accn/A20240001

# Timeline and metadata take the numeric internal ID
# (found in the `id` field of the document-details response)
retsinformation document 256418 --metadata     # structured ELI metadata
retsinformation document 256418 --timeline      # legislative history
```

#### Forming the `<eli_path>` argument

The ELI path is the document URI with the leading `/` stripped. Retsinformation uses the EU ELI standard; map the URL you have to the CLI argument like so:

| URL pattern | Example URL | CLI invocation |
|---|---|---|
| `/{pubMedia}/{year}/{number}` (CST canonical) | `/retsinfo/1989/0001` | `retsinformation document eli/lta/2026/480` |
| `/eli/accn/{accn}` (accession alias) | `/eli/accn/A19890001` | `retsinformation document eli/accn/A20240001` |
| `/eli/ft/{accn}` (parliamentary doc) | `/eli/ft/A19890001` | `retsinformation document eli/ft/A19890001` |
| `/eli/eu/{celex}` (EU/CELEX) | `/eli/eu/CELEX:31989L0048` | `retsinformation document eli/eu/CELEX:31989L0048` |
| `/{cls}/{docType}/{year}/{month}/{day}/{number}` (classification alias) | `/eli/regel/lovh/2024/01/15/001` | `retsinformation document eli/regel/lovh/2024/01/15/001` |

Publication media codes used in CST paths: `lta`, `ltb`, `ltc`, `mt`, `retsinfo`, `ft`, `fob`.
