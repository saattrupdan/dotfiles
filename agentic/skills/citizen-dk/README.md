# citizen-dk

A slim `citizen` CLI to search Denmark's official citizen / public-service
portals. Merges the former `borger-dk`, `nyidanmark-dk`, `frederiksberg-dk`,
`kommune-dk`, and `kk-dk` skills.

## Requirements

- `citizen` CLI — standard library only (`pipx install -e .`)
- Internet access to `borger.dk`, `nyidanmark.dk`, `frederiksberg.dk`,
  `kommune.dk`

## Quick start

```bash
citizen search "pas"                                   # borger.dk (default)
citizen search "arbejdstilladelse" --source nyidanmark # full results + links
citizen search "flytning" --source all                 # fan out to all sources
citizen municipality "København"                       # municipality facts
citizen municipality "Aarhus" --section borgerservice
```

Add `--json` to any command for raw upstream JSON.

## Commands

| Command | Purpose |
|---|---|
| `search QUERY [--source …]` | Q&A search: `borger` (national, suggestions), `nyidanmark` (immigration, full results), `frederiksberg` (municipal), or `all` |
| `municipality NAME [--section S]` | Factual page for one of the 98 municipalities (kommune.dk) |

## Notes

- **borger** and **frederiksberg** return search **suggestions** (no public
  full-results API); **nyidanmark** returns full results with links.
- **kk.dk** (City of Copenhagen) has no JSON search API — browse
  `https://www.kk.dk/soeg?k=<query>` directly.
- borger's `portalId` and frederiksberg's `pageId` are pinned as constants at the
  top of `citizen_dk/main.py`; refresh them if the portals re-key.
- No MitID / personal-dashboard access (Mit Overblik, Digital Post, Min Side).
