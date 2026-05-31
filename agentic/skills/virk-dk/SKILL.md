---
name: virk-dk
description: virk.dk — the Danish government portal for businesses. Covers the anonymous editorial surface (9 themes, ~2000 articles, agency tree, self-service launchers), Mit Virk dashboard, GraphQL gateway, and CVR data portals. Use when looking up Danish business-admin procedures, self-service forms, or querying virk.dk's GraphQL or Elasticsearch endpoints.
last-updated: 2026-05-31
---

# virk.dk — Danish business portal

Official entrypoint for businesses and advisors dealing with Danish authorities, run by **Erhvervsstyrelsen**. Two surfaces:

- **Editorial surface** (`virk.dk`) — anonymous themes/articles, agency tree, self-service launchers, plus the GraphQL gateway behind the SSR front-end.
- **CVR data** — the Central Business Register: company, P-unit, and participant data, served system-to-system from an Elasticsearch distribution API.

Personalised pages (Mit Virk dashboard) need **MitID Erhverv** and have no programmatic path. Site language is Danish, so **answer the user in Danish** unless they write in another language.

## CLI — use this first

Programmatic access goes through the `virk` CLI. It wraps both the GraphQL gateway and the CVR Elasticsearch API, so **always use it** — there is no other supported way to do these tasks. For anything the CLI's named commands do not expose, the escape hatches are `virk web query '<graphql>'` (arbitrary GraphQL) and `virk cvr raw <index> <type> <body-file>` (arbitrary Elasticsearch query body).

The CLI runs from anywhere; no need to point at the skill directory. Two subcommand groups:

```bash
virk web <command> [options]   # virk.dk editorial content + GraphQL gateway (anonymous)
virk cvr <command> [options]   # CVR distribution API (Elasticsearch; needs credentials)
```

### Install / prerequisites

```bash
which virk   # check if already installed
```

If missing, install editable with pipx:

```bash
which pipx || python3 -m pip install --user pipx
python3 -m pipx ensurepath
pipx install -e <path-to-virk-dk-skill>
which virk   # confirm on PATH (restart shell if ensurepath just ran)
```

Pure Python standard library — no extra dependencies. The `web` group is anonymous. The `cvr` group reads `DATACVR_USER` / `DATACVR_PASS` env vars (free, long-lived creds — email `cvrselvbetjening@erst.dk` with name, org, CVR, and use-case). Most commands accept `--raw` for unformatted JSON.

### `virk web` — editorial content + GraphQL gateway

| Command | Purpose | Example |
|---|---|---|
| `article <slug>` | Fetch one Artikel by slug | `virk web article start-virksomhed` |
| `search-articles <text> [--limit N]` | Substring match on `Artikel.overskrift` | `virk web search-articles moms --limit 20` |
| `ordninger [--limit N]` | List Ordninger (schemes) | `virk web ordninger` |
| `myndigheder [--type stat\|kommune\|region] [--limit N]` | List agencies | `virk web myndigheder --type stat` |
| `ministerier` | Ministry → agency tree (backs `/nye-regler/`) | `virk web ministerier` |
| `mv-services` | Mit Virk backend service status (anon) | `virk web mv-services` |
| `ressourceset <slug> [--locale da]` | Key/value strings of an i18n bundle | `virk web ressourceset <slug>` |
| `redirect <url> [--realm virk]` | Resolve a vanity URL via `redirectQuery` | `virk web redirect /start` |
| `sitemap [--limit N] [--prefix /emner/]` | URLs from `/sitemap.xml` | `virk web sitemap --prefix /emner/` |
| `query '<graphql>' [--variables JSON]` | Run an arbitrary GraphQL query string | `virk web query '{ ordningCollection { total } }'` |
| `raw <file> [--variables JSON]` | POST a GraphQL document from a file | `virk web raw query.graphql` |

All `virk web` commands take `--raw` to print the unformatted GraphQL JSON response.

### `virk cvr` — CVR distribution API

Needs `DATACVR_USER` / `DATACVR_PASS`. All commands print the matched `_source` (or `--raw` for the full ES response).

| Command | Purpose | Example |
|---|---|---|
| `virksomhed <cvr> [--field <dot-path>]` | Company by CVR number; `--field` extracts a path under `virksomhedMetadata` (then `Vrvirksomhed`) | `virk cvr virksomhed 10103940 --field nyesteNavn.navn` |
| `p-enhed <pnr>` | Production unit by P-number | `virk cvr p-enhed 1003393495` |
| `deltager <enhedsNummer>` | Participant by `enhedsNummer` | `virk cvr deltager 4000004072` |
| `search <name> [--limit N]` | Company name search (`match` on `nyesteNavn.navn`) | `virk cvr search carlsberg --limit 10` |
| `count <index> <type>` | Document count for an index/type (`match_all`) | `virk cvr count cvr-permanent virksomhed` |
| `raw <index> <type> <body-file>` | POST a raw ES query body to `<index>/<type>/_search` | `virk cvr raw cvr-permanent virksomhed query.json` |

#### CVR field shortcuts

Use these as the `--field` value for `virk cvr virksomhed --field <path>` (paths are relative to `virksomhedMetadata`, then `Vrvirksomhed`) and as the full field paths when building `virk cvr raw` query bodies:

| Lookup | `--field` path | Full field path (for `virk cvr raw`) |
|---|---|---|
| CVR number | — | `Vrvirksomhed.cvrNummer` |
| Name (full text) | `nyesteNavn.navn` | `Vrvirksomhed.virksomhedMetadata.nyesteNavn.navn` |
| Postal code | `nyesteBeliggenhedsadresse.postnummer` | `Vrvirksomhed.virksomhedMetadata.nyesteBeliggenhedsadresse.postnummer` |
| Industry (DB07) | `nyesteHovedbranche.branchekode` | `Vrvirksomhed.virksomhedMetadata.nyesteHovedbranche.branchekode` |
| Company form | `nyesteVirksomhedsform.virksomhedsformkode` | `Vrvirksomhed.virksomhedMetadata.nyesteVirksomhedsform.virksomhedsformkode` |
| P-number | — | `VrproduktionsEnhed.pNummer` |
| Participant | — | `Vrdeltagerperson.enhedsNummer` / `Vrvirksomhed.enhedsNummer` |

## Out of scope

The `datacvr.virk.dk` web UI (Cloudflare-gated SPA) and the MitID-gated Mit Virk dashboard are not covered by this skill. The CVR distribution API retires end of 2026; Datafordeler is its successor.
