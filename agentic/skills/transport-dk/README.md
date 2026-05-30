# transport-dk

One `transport` CLI for Danish public transport — trains (DSB), buses (Movia),
Metro and light rail. Merges the former `rejseplanen-dk`, `dsb-dk`, `m-dk`, and
`dinoffentligetransport-dk` skills.

The journey engine is **Rejseplanen**'s HaCon **HAFAS** RPC API; disruptions
also use **dinoffentligetransport.dk**, and content search uses the **m.dk**
(Metro) Ankiro index. All anonymous and free. **Buying tickets is out of
scope.**

## Requirements

- `transport` CLI — standard library only (`pipx install -e .`)
- Internet access to `webapp.rejseplanen.dk`, `dinoffentligetransport.dk`,
  `m.ankiro.dk`

## Quick start

```bash
transport route "København H" "Aarhus H"            # plan a journey
transport route "Nørreport" "Lufthavnen" --time 08:30
transport departures "Nørreport"                    # live board + delays
transport departures "Aarhus H" --arrivals
transport stations "Nørreport"                      # resolve a place name
transport changes                                   # disruptions + bus changes
transport tickets --operator dsb                    # ticket products
transport search "cykel"                            # metro content Q&A
```

Add `--json` to any command for raw upstream JSON.

## Commands

| Command | Purpose |
|---|---|
| `route FROM TO` | Journey planning (legs, times, platforms, transfers) |
| `departures STATION` | Live station board with real-time delays |
| `stations QUERY` | Resolve a name to stations/addresses/POIs |
| `changes` | Rejseplanen HIM disruptions + planned bus schedule changes |
| `tickets` | Curated ticket-product reference with official links |
| `search QUERY` | Transport content Q&A (m.dk Metro index) |

## Notes

- HAFAS endpoint: `https://webapp.rejseplanen.dk/bin/iphone.exe` (`aid`
  `j1sa92pcj72ksh0-web`, ver `1.24`, ext `DK.11`). Update the constants at the
  top of `transport_dk/main.py` if Rejseplanen rotates them.
- `--only` filters products: `ic lyn re train stog bus expressbus nightbus
  otherbus ferry metro tram`.
- No purchasing, seat reservation, fare calculation, or personal-account data —
  those require MitID and the operators' own apps.
