# borger-dk

Reference for navigating borger.dk — the official Danish public-sector portal for citizens ("din indgang til det offentlige").

## Requirements

- No CLI script — this is a site-navigation skill
- Internet access to `www.borger.dk`
- MitID for logged-in personal pages

## Quick Start

```bash
# Browse the citizen portal (anonymous)
open https://www.borger.dk/

# Look up a topic in a life-domain section
open https://www.borger.dk/familie-og-boern/foedsoejfoerstoerelse

# See your personal overview (requires MitID login)
open https://www.borger.dk/mitoverblik
```

## Navigation Reference

### Top-level life-domain sections

| Section | URL |
|---|---|
| Familie og børn | `/familie-og-boern` |
| Skole og uddannelse | `/skole-og-uddannelse` |
| Sundhed og sygdom | `/sundhed-og-sygdom` |
| Internet og sikkerhed | `/internet-og-sikkerhed` |
| Pension og efterløn | `/pension-og-efterloen` |
| Handicap | `/handicap` |
| Arbejde, dagpenge, ferie | `/arbejde-dagpenge-ferie` |
| Økonomi, skat, SU | `/oekonomi-skat-su` |
| Ældre | `/aeldre` |
| Bolig og flytning | `/bolig-og-flytning` |
| Miljø og energi | `/miljoe-og-energi` |
| Transport, trafik, rejser | `/transport-trafik-rejser` |
| Danskere i udlandet | `/danskere-i-udlandet` |
| Udlændinge i Danmark | `/udlaendinge-i-danmark` |
| Samfund og rettigheder | `/samfund-og-rettigheder` |
| Politi, retsvæsen, forsvar | `/politi-retsvaesen-forsvar` |
| Kultur og fritid | `/kultur-og-fritid` |

### Key patterns

| Pattern | Description |
|---|---|
| `/<section>/<topic>/<article>` | Article pages within a life-domain section |
| `/Handlingsside?selfserviceId=<GUID>` | Universal launcher for a self-service flow |
| `/Soeg?k=<query>` | Site search results (HTML; disallowed for crawlers) |
| `/vaelg-kommune` | Standalone kommune selector |
| `/om-borger-dk/Find-en-myndighed` | "Find en myndighed" — authority lookup |
| `/mitoverblik` | Logged-in personal dashboard (requires MitID) |

### Logged-in dashboard — "Mit Overblik"

| URL | Content |
|---|---|
| `/mitoverblik` | Personal landing page |
| `/mitoverblik/sager` | Active cases with authorities |
| `/mitoverblik/oekonomiske-ydelser` | Benefit payments |
| `/mitoverblik/betalinger` | Outgoing payments and debt |
| `/mitoverblik/indkomst-og-skat` | Salary and tax data |

### Related portals

| Portal | URL |
|---|---|
| Digital Post | `https://post.borger.dk` |
| English mirror | `https://lifeindenmark.borger.dk` |

## Troubleshooting

- **Logged-in pages return 403/redirect** — You must log in via MitID at `/mitoverblik?allowLogin=1`.
- **Self-service forms don't load** — `/Handlingsside` delegates to dozens of different backend systems (Udbetaling Danmark, Skat, kommune ESDH, etc.); the same `selfserviceId` may behave differently per kommune.
- **English mirror missing content** — The English site is a curated subset; many specialist articles only exist in Danish.
