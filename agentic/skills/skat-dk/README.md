# skat-dk

Reference for navigating skat.dk — the Danish Tax Agency's public citizen ("Borger") portal.

## Requirements

- Python 3 (stdlib only) for `skat_dk_api.py`
- Internet access to `skat.dk`
- MitID or TastSelv-kode for personal self-service

## Quick Start

```bash
# Browse the citizen tax portal (anonymous)
open https://skat.dk/borger

# Read about deductions
open https://skat.dk/borger/fradrag

# Read about the annual tax return
open https://skat.dk/borger/aarsopgoerelse

# Log in to TastSelv (requires MitID)
open https://vent.skat.dk/?c=skat&e=prod250303login&t=https%3A%2F%2Fwww.tastselv.skat.dk%2Fborger%2Floginsso
```

## Navigation Reference

### Top-level citizen sections

| Section | URL | Covers |
|---|---|---|
| Årsopgørelse | `/borger/aarsopgoerelse` | Annual tax return, refunds, residual tax |
| Forskudsopgørelse | `/borger/forskudsopgoerelse` | Preliminary assessment, tax cards |
| Fradrag | `/borger/fradrag` | Deductions: kørsel, håndværker, kost & logi, etc. |
| Bolig og ejendomme | `/borger/bolig-og-ejendomme` | Property tax, ejendomsskat, rental income |
| Aktier og værdipapirer | `/borger/aktier-og-andre-vaerdipapirer` | Securities, crypto, gains/losses |
| Pension og efterløn | `/borger/pension-og-efterloen` | Pensions, early retirement, ATP |
| Udlandsforhold | `/borger/udlandsforhold` | Cross-border tax, double taxation |
| B-indkomst | `/borger/b-indkomst` | Self-employment / freelance income |
| Deleøkonomi | `/borger/deleoekonomi` | Sharing economy (Airbnb, GoMore, etc.) |

### Language mirrors

| `hreflang` | Root |
|---|---|
| `da-dk` | `/borger` |
| `en-us` | `/en-us/individuals` |
| `de-de` | `/de-de/buerger` |
| `uk` | `/uk/osobi` |
| `pl` | `/pl/osoby-fizyczne` |
| `ro` | `/ro/persoana-fizica` |
| `lt` | `/lt/privatus-asmenys` |
| `kl` | `/kl/innuttaasoq` |

### Login launchers

| Button | URL |
|---|---|
| Log på med MitID | `https://vent.skat.dk/?c=skat&e=prod250303login&t=...` |
| Log på med TastSelv-kode | `https://vent.skat.dk/?c=skat&e=prod260306login&t=...` |
| Log på med autorisation | `https://vent.skat.dk/?c=skat&e=prod260306aut` |

### Sister sites

| Site | URL | Use |
|---|---|---|
| info.skat.dk | `https://info.skat.dk/` | Legal materials, satser, forms |
| motorst.dk | `https://motorst.dk/` | Motor vehicle taxation |
| toldst.dk | `https://toldst.dk/` | Customs |
| vurderingsportalen.dk | `https://www.vurderingsportalen.dk/` | Property valuations |
| skm.dk | `https://www.skm.dk/` | Tax ministry policy / law texts |

## Troubleshooting

- **No personal-data API** — All citizen-specific data lives in `tastselv.skat.dk` behind MitID login. There is no service-account path.
- **Search returns empty** — `/soeg` is client-side only (Cludo widget). Use the Cludo API via `skat_dk_api.py search` for programmatic search.
- **Login URLs broken** — The `vent.skat.dk/?…&e=prodNNNNNN…` campaign IDs rotate every few months. Re-fetch the home page for fresh URLs.
- **Translation unavailable** — Not every article has every language translation. Check `pageLanguageVersions` in the Next.js data feed.
