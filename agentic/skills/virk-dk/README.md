# virk-dk

Reference for navigating virk.dk — the official Danish public-sector portal for businesses ("virksomhedernes digitale indgang til det offentlige").

## Requirements

- Internet access to `virk.dk`
- MitID Erhverv for logged-in personal pages
- Python 3.12+ and the `virk` CLI (standard library only), with two subcommand groups:
  - `virk web ...` — anonymous virk.dk editorial content + GraphQL gateway
  - `virk cvr ...` — CVR Elasticsearch distribution API (requires `DATACVR_USER` / `DATACVR_PASS` env vars; free creds via `cvrselvbetjening@erst.dk`)

Install the CLI editable with pipx from this skill directory:

```bash
pipx install -e .
```

## Quick Start

```bash
# Browse the business portal (anonymous)
open https://virk.dk/

# Browse a theme
open https://virk.dk/emner/Virksomhed/

# Browse the agency tree
open https://virk.dk/myndigheder/

# Read upcoming legislation
open https://virk.dk/nye-regler/

# Log in to Mit Virk (requires MitID Erhverv)
open https://virk.dk/mit-virk/
```

## GraphQL API — `virk web`

`virk web ...` drives virk.dk's anonymous GraphQL gateway at `https://virk.dk/graphql`. Standard library only.

```bash
# Run an arbitrary GraphQL query
virk web query 'query{ ordningCollection(limit:5){ total items{slug overordnetTitel} } }'

# Fetch an article by slug
virk web article start-virksomhed

# Search articles by title (case-insensitive)
virk web search-articles "virksomhedsregistret" --limit 10

# List all ordninger
virk web ordninger --limit 20

# List agencies (myndigheder)
virk web myndigheder --type stat --limit 50

# Ministry → agency tree
virk web ministerier

# Mit Virk backend service status
virk web mv-services

# i18n string bundle
virk web ressourceset <slug> --locale da

# Resolve a vanity URL
virk web redirect /mit-virk/

# List URLs from the sitemap
virk web sitemap --prefix /emner/ --limit 100
```

All commands accept `--raw` to print the unmodified JSON response. See `SKILL.md` for the full schema cribsheet and verified query examples.

## CVR API — `virk cvr`

`virk cvr ...` drives the CVR distribution Elasticsearch endpoint at `http://distribution.virk.dk`. Requires `DATACVR_USER` and `DATACVR_PASS` env vars (free credentials via `cvrselvbetjening@erst.dk`). Standard library only.

> **Note**: the distribution endpoint retires end of 2026. New integrations should target [Datafordeler](https://datafordeler.dk/dataoversigt/det-centrale-virksomhedsregister-cvr/).

```bash
# Company by CVR number
virk cvr virksomhed 10103940

# Extract a specific metadata field
virk cvr virksomhed 10103940 --field nyesteNavn.navn

# Production unit by P-number
virk cvr p-enhed 1003393495

# Participant by enhedsNummer
virk cvr deltager 4000004072

# Free-text company name search
virk cvr search "carlsberg" --limit 10

# Raw Elasticsearch query from a JSON file
virk cvr raw cvr-permanent virksomhed query.json

# Document count for an index/type
virk cvr count cvr-permanent virksomhed
```

All commands accept `--raw` to print the full JSON response.

## Navigation Reference

### Top-level sections (emner)

| Theme | URL |
|---|---|
| Byggeri | `/emner/Byggeri/` |
| Handel - og servicefag | `/emner/Handel%20-%20og%20servicefag/` |
| Miljø | `/emner/Milj%C3%B8/` |
| Personale | `/emner/Personale/` |
| Sikkerhed | `/emner/Sikkerhed/` |
| Statistik | `/emner/Statistik/` |
| Transport | `/emner/Transport/` |
| Virksomhed | `/emner/Virksomhed/` |
| Økonomi | `/emner/%C3%98konomi/` |

### Key patterns

| Pattern | Description |
|---|---|
| `/emner/<theme>/<sub-theme>/` | Intro pages listing articles, ordninger, and self-service shortcuts |
| `/myndigheder/<type>/<agency>/selvbetjening/<slug>/` | Per-agency self-service launcher |
| `/myndigheder/` | Top of the agency tree (169 myndigheder) |
| `/search/?term=<query>` | Site search (SSR-rendered HTML; disallowed for crawlers) |
| `/nye-regler/` | Upcoming legislation curated by ministry |

### Frequently-used self-service launchers

| Form | URL |
|---|---|
| Start virksomhed | `/myndigheder/stat/ERST/selvbetjening/Start_virksomhed/` |
| Ændre/lukke virksomhed | `/myndigheder/stat/ERST/selvbetjening/Webreg_aendre_virksomhed__lukke_virksomhed/` |
| Indberet årsrapport | `/myndigheder/stat/ERST/selvbetjening/Regnskab_20/` |
| Indberet moms | `/myndigheder/stat/SKST/selvbetjening/Indberet_moms/` |
| Refusion af sygedagpenge | `/myndigheder/stat/NemRefusion/selvbetjening/Refusion_af_sygedagpenge/` |
| Overførsel af ferie | `/myndigheder/stat/feriekonto/selvbetjening/Overfoersel_af_ferie/` |
| Anmeld arbejdsulykke | `/myndigheder/stat/AES/selvbetjening/Anmeldelse_af_arbejdsulykke/` |

### "Mit Virk" — logged-in dashboard

| Item type | What it is |
|---|---|
| `MVSag` | Active case with an authority |
| `MVFrist` | Upcoming deadline (e.g. quarterly VAT) |
| `MVBesked` | Inbound message/notification |
| `MVTilladelse` | Permit/authorisation |

### Help & about

| URL | Content |
|---|---|
| `/vejledning/virk-hjaelp/` | Help root — login problems, MitID Erhverv |
| `/vejledning/virk-assistent/` | On-site chatbot/support |
| `/vejledning/frivillige-foreninger/` | Guide for voluntary associations |
| `/vejledning/virk-om-virk/` | About the site |
| `/vejledning/virk-om-virk/virk-kontakt/` | Contact editorial team |

### Sister sites

| Host | Purpose |
|---|---|
| `businessindenmark.virk.dk` | English mirror — "Business in Denmark" |
| `datacvr.virk.dk` | CVR data search portal (behind Cloudflare) |
| `mitid-erhverv.dk` | MitID Erhverv login + delegated access |

### URL conventions

- Slugs use **URL-encoded Danish letters** (`æ` → `%C3%A6`, `ø` → `%C3%B8`, `å` → `%C3%A5`)
- Trailing `/` is significant: `/emner/Byggeri` 301-redirects to `/emner/Byggeri/`
- Self-service slugs use `_` and spelled-out Danish letters (`Aendre`, `Foersel`)

## Troubleshooting

- **No personal-data API** — Mit Virk data is session-bound to MitID Erhverv. There is no service-account path.
- **Search returns no results** — `/search/` is SSR-rendered HTML only; there is no JSON autocomplete. Use `virk web` for programmatic GraphQL queries.
- **English mirror missing content** — `businessindenmark.virk.dk` is curated; many specialist articles only exist in Danish.
- **Self-service form doesn't load** — Launcher pages on virk.dk are stubs; the actual filing happens in the agency's own application with its own auth.
