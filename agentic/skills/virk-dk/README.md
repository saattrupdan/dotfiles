# virk-dk

Reference for navigating virk.dk — the official Danish public-sector portal for businesses ("virksomhedernes digitale indgang til det offentlige").

## Requirements

- Internet access to `virk.dk`
- MitID Erhverv for logged-in personal pages
- Python 3.10+ for the included CLI helpers:
  - `virk_dk_api.py` — anonymous GraphQL gateway (standard library only)
  - `datacvr_api.py` — CVR Elasticsearch API (requires `DATACVR_USER` / `DATACVR_PASS` env vars; free creds via `cvrselvbetjening@erst.dk`)

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

## GraphQL API

The folder includes `virk_dk_api.py`, a CLI for virk.dk's anonymous GraphQL gateway at `https://virk.dk/graphql`. Standard library only.

```bash
# Run an arbitrary GraphQL query
python3 virk_dk_api.py query 'query{ ordningCollection(limit:5){ total items{slug overordnetTitel} } }'

# Fetch an article by slug
python3 virk_dk_api.py article start-virksomhed

# Search articles by title (case-insensitive)
python3 virk_dk_api.py search-articles "virksomhedsregistret" --limit 10

# List all ordninger
python3 virk_dk_api.py ordninger --limit 20

# List agencies (myndigheder)
python3 virk_dk_api.py myndigheder --type stat --limit 50

# Ministry → agency tree
python3 virk_dk_api.py ministerier

# Mit Virk backend service status
python3 virk_dk_api.py mv-services

# i18n string bundle
python3 virk_dk_api.py ressourceset <slug> --locale da

# Resolve a vanity URL
python3 virk_dk_api.py redirect /mit-virk/

# List URLs from the sitemap
python3 virk_dk_api.py sitemap --prefix /emner/ --limit 100
```

All commands accept `--raw` to print the unmodified JSON response. See `SKILL.md` for the full schema cribsheet and verified query examples.

## CVR API

The folder includes `datacvr_api.py`, a CLI for the CVR distribution Elasticsearch endpoint at `http://distribution.virk.dk`. Requires `DATACVR_USER` and `DATACVR_PASS` env vars (free credentials via `cvrselvbetjening@erst.dk`). Standard library only.

> **Note**: the distribution endpoint retires end of 2026. New integrations should target [Datafordeler](https://datafordeler.dk/dataoversigt/det-centrale-virksomhedsregister-cvr/).

```bash
# Company by CVR number
python3 datacvr_api.py virksomhed 10103940

# Extract a specific metadata field
python3 datacvr_api.py virksomhed 10103940 --field nyesteNavn.navn

# Production unit by P-number
python3 datacvr_api.py p-enhed 1003393495

# Participant by enhedsNummer
python3 datacvr_api.py deltager 4000004072

# Free-text company name search
python3 datacvr_api.py search "carlsberg" --limit 10

# Raw Elasticsearch query from a JSON file
python3 datacvr_api.py raw cvr-permanent virksomhed query.json

# Document count for an index/type
python3 datacvr_api.py count cvr-permanent virksomhed
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
- **Search returns no results** — `/search/` is SSR-rendered HTML only; there is no JSON autocomplete. Use the included `virk_dk_api.py` for programmatic GraphQL queries.
- **English mirror missing content** — `businessindenmark.virk.dk` is curated; many specialist articles only exist in Danish.
- **Self-service form doesn't load** — Launcher pages on virk.dk are stubs; the actual filing happens in the agency's own application with its own auth.
