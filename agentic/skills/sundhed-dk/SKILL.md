---
name: sundhed-dk
description: sundhed.dk — Danish national e-health portal. Covers citizen (MitID) and clinician (MitID Erhverv/SOSI) flows - public content, Min Side dashboards, and the internal undocumented JSON API. Use for Danish health-portal tasks.
last-updated: 2026-05-31
---

# sundhed.dk — Danish e-health portal

Official Danish national e-health portal for citizens and healthcare professionals. All URLs relative to `https://www.sundhed.dk`. Respond in Danish unless the user signals otherwise.

The portal has two sides, both mostly behind login:

- **Citizen ("borger")** — login = **MitID**.
- **Healthcare professional ("sundhedsfaglig")** — login = **MitID Erhverv** (standard) or **SOSI** smartcard (legacy, in-clinic).

The personal/clinical surfaces (Min Side, Min Sundhedsjournal, self-service, registrations, audit log, clinician patient-data tools) are **website-only** and require an interactive MitID login — the CLI cannot reach them. For everything **anonymous/public**, use the `sundhed` CLI rather than fetching pages or APIs by hand.

---

## CLI — `sundhed`

The `sundhed` CLI wraps the verified **anonymous** JSON endpoints. Use it for all anonymous/public lookups — settings, menus, the provider catalogue, medical-dictionary autocomplete, sitemap/URL enumeration, and session/version checks — instead of fetching pages or hitting `/api/` by hand. It runs from anywhere; no need to be in the skill directory.

```bash
sundhed <command> [options]
```

### Prerequisites

Verify the CLI is installed:

```bash
which sundhed
```

If missing, install it editable with pipx (from the skill directory). First make sure pipx itself is available, then install:

```bash
# Ensure pipx is installed
which pipx || python3 -m pip install --user pipx
python3 -m pipx ensurepath

# Install the sundhed CLI
pipx install -e <path-to-sundhed-dk-skill>
```

After installing, confirm `sundhed` is on the PATH (you may need to restart the shell so `pipx ensurepath` takes effect):

```bash
which sundhed
```

Pure Python standard library — no extra dependencies.

### Command reference

Append `--raw` to any command to skip the human-readable formatter and print raw JSON. Errors (including the standard `ResponseStatus` error envelope) go to stderr with a non-zero exit.

| Command | Purpose | Example |
|---|---|---|
| `version` | Site version info (`/api/version`) | `sundhed version` |
| `login` | Login-state check (anonymous → `IsLoggedIn:false`) | `sundhed login` |
| `keepalive [timeleft\|renew]` | Session lifetime in seconds (`-1` if anonymous); `renew` POSTs | `sundhed keepalive timeleft` |
| `settings` | Startup settings as `key=value` (`/api/core/startupsettings`) | `sundhed settings` |
| `setting <key>` | Single app setting | `sundhed setting PortalV2WebHost` |
| `menu --section <borger\|sundhedsfaglig> --kind <top\|footer\|icon>` | Navigation menus (URL + title) | `sundhed menu --section borger --kind top` |
| `filters --section <borger\|sundhedsfaglig>` | Regions + municipalities used by search | `sundhed filters --section borger` |
| `orgtypes` | Provider categories for "Find behandler" | `sundhed orgtypes` |
| `pagetheme --path <portalUrl>` | Per-page theming | `sundhed pagetheme --path /borger/` |
| `alerts` | Site-wide outage banners | `sundhed alerts` |
| `plugins` | SPA application-plugin registry (regional apps, etc.) | `sundhed plugins` |
| `autocomplete <term>` | Medical-dictionary autocomplete (ordbog) | `sundhed autocomplete blod` |
| `sitemap` | List sitemap shard URLs | `sundhed sitemap` |
| `urls --shard <name>` | Enumerate `<loc>` URLs in a sitemap shard | `sundhed urls --shard artikel` |

Known `--shard` values: `applikation`, `artikel`, `event`, `informationtilpraksis`, `patientforloeb`, `laegehaandbog`, `laegemiddelanbefaling`, `nyhed`, `patienthaandbog`, `patientklagesag`, `sundhedstilbud`, `sundheddkhjaelp`, `sundheddkinformation`, `tema`, `indloggetrum`.

The `sitemap`/`urls` commands enumerate the public URL space — use them to discover citizen and clinician public pages.

---

## Out of scope

Personal/clinical data behind MitID / MitID Erhverv / SOSI login (Min Side, Min Sundhedsjournal, self-service, registrations, audit log, clinician patient-data tools) is not covered by this skill — the CLI reaches only the anonymous public endpoints.
