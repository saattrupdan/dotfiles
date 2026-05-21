# tv2-dk

Reference for navigating tv2.dk — Denmark's largest commercial broadcaster and news portal.

## Requirements

- Internet access to `tv2.dk` and subdomains (`nyheder.tv2.dk`, `sport.tv2.dk`, `vejr.tv2.dk`, `play.tv2.dk`, `tv.tv2.dk`)
- TV 2 Login (mit.tv2.dk) optional — only needed for personalized content and some Play material
- Browser automation for full content access (site is heavily JS-dependent)

## Quick Start

```bash
# Browse front page
open https://tv2.dk/

# Read latest news
open https://nyheder.tv2.dk/seneste

# Check weather
open https://vejr.tv2.dk/

# Watch streaming content
open https://play.tv2.dk/

# View sports live scores
open https://sport.tv2.dk/livescore-og-resultater
```

## Navigation Reference

### Main subdomains

| Subdomain | URL |
|---|---|
| Front page | `https://tv2.dk/` |
| News | `https://nyheder.tv2.dk/` |
| Sport | `https://sport.tv2.dk/` |
| Weather | `https://vejr.tv2.dk/` |
| TV | `https://tv.tv2.dk/` |
| Play (streaming) | `https://play.tv2.dk/` |

### News subsections

| Subsection | URL |
|---|---|
| Latest news | `https://nyheder.tv2.dk/seneste` |
| Politics | `https://nyheder.tv2.dk/politik` |
| Crime | `https://nyheder.tv2.dk/krimi` |
| Society | `https://nyheder.tv2.dk/samfund` |
| International | `https://nyheder.tv2.dk/udland` |
| Business | `https://nyheder.tv2.dk/business` |
| Money | `https://nyheder.tv2.dk/penge` |
| Election 2026 | `https://nyheder.tv2.dk/folketingsvalg` |

### Sport subsections

| Subsection | URL |
|---|---|
| Latest sport | `https://sport.tv2.dk/seneste` |
| Schedule | `https://sport.tv2.dk/sendeplan` |
| Live scores | `https://sport.tv2.dk/livescore-og-resultater` |
| Tournaments | `https://sport.tv2.dk/turneringer` |
| Football (Superliga) | `https://sport.tv2.dk/fodbold/superliga` |
| Handball | `https://sport.tv2.dk/haandbold` |
| Cycling | `https://sport.tv2.dk/cykling` |

### Article URL pattern

```
https://nyheder.tv2.dk/YYYY/MM/DD/slug-here
https://sport.tv2.dk/YYYY/MM/DD/slug-here
```

### Services

| Service | URL |
|---|---|
| TV 2 Login | `https://mit.tv2.dk/?login` |
| Account management | `https://mit.tv2.dk/` |
| Tip us anonymously | `https://tv2.dk/kontakt-os/tip-os` |
| Editorial ombudsman | `https://tv2.dk/etik/serners-redaktor` |
| Corrections | `https://tv2.dk/etik/fejl-og-rettelser` |

## Troubleshooting

- **Pages load blank**: The site is heavily JavaScript-dependent. Use `agent-browser` with a full browser, not HTTP requests alone.
- **Videos won't play**: Brightcove player requires a valid policy key. The key is embedded in page HTML — it rotates occasionally.
- **Play content blocked**: Some TV 2 Play content requires a Danish IP address and/or TV 2 Login.
- **Weather shows DMI cookie banner**: vejr.tv2.dk shares infrastructure with DMI (Danish Meteorological Institute).
- **Search returns nothing**: Type the query and press Enter or click the search button — search is not instant.
