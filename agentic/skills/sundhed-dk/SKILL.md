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

The `sitemap`/`urls` commands enumerate the public URL space — use them to discover the citizen and clinician public pages tabulated in the reference section below.

---

## Reference: website navigation (MitID-gated) & site structure

Everything below requires **navigating the website with an interactive login** (MitID / MitID Erhverv / SOSI) and is **not covered by the CLI** — except the anonymous public URL tables, which are exactly what `sundhed sitemap` / `sundhed urls` enumerate. Use this as a map of where things live on the site.

### Citizen ("borger") — anonymous public pages

| Feature | URL |
|---|---|
| Citizen home | `/borger/` |
| Patienthåndbogen — patient handbook | `/borger/patienthaandbogen/` |
| Sygdom og behandling — illness articles | `/borger/sygdom-og-behandling/` |
| Forebyggelse — prevention | `/borger/forebyggelse/` |
| Patientrettigheder — patient rights | `/borger/patientrettigheder/` |
| Sygehusvalg & ventetider | `/borger/patientrettigheder/sygehusvalg-ventetider/` |
| Find behandler — find GP/dentist/pharmacy | `/borger/guides/find-behandler/` |
| News | `/borger/service/om-sundheddk/nyheder-og-presse/` |
| Help / live chat | `/borger/service/kontakt/hjaelp-borger/` |

Extended hospital-choice tool: `https://udvidetsygehusvalg.sundhed.dk/`.

### Citizen — logged-in dashboard ("Min Side", MitID)

Root: `/borger/min-side/`. **Website-only.**

**Min Sundhedsjournal** — aggregates regional/national back-ends. Key sections: medication record, lab results, hospital records, vaccinations, diagnoses, referrals, appointments, care plans, CAVE alerts, imaging reports, GP info, timeline, questionnaires, home measurements, regional apps (AK Online, Diabetes Online, AmbuFlex), hearing-aid file.

**Self-service**
- Prescription renewal: `/borger/min-side/receptfornyelse/`
- Book GP appointment: `/borger/min-side/tidsbestilling/`
- Email consultation: `/borger/min-side/e-mail-konsultation/`
- New-user onboarding: `/borger/min-side/ny-bruger-paa-sundheddk/`

**Registrations** (`/borger/min-side/mine-registreringer/`) — organ donor, living will, resuscitation opt-out, stem-cell donor, research consents, power-of-attorney (`fuldmagt.nemlog-in.dk`), master data card, cancer screenings, camera-pill screening, genetic-family register.

**Audit log** (`/borger/min-side/min-log/`) — who accessed your data, past digital consultations, mark data private, consent declarations.

Common task entry points: medication `/borger/min-side/min-sundhedsjournal/medicinkortet/`, lab results `/borger/min-side/min-sundhedsjournal/laboratoriesvar/`, hospital records `/borger/min-side/min-sundhedsjournal/journal-fra-sygehus/`, organ donor `/borger/min-side/mine-registreringer/organdonation/`, access audit `/borger/min-side/min-log/min-log/`, live chat `/borger/service/kontakt/hjaelp-borger/chat/`.

**Citizen limits** — data visibility depends on source systems; some records are delayed. Regional apps only work in operating regions. Danish-only. No public health-data API — personal data is session-bound to MitID. Fronted by `queue-it.net` at peak.

### Healthcare professional ("sundhedsfaglig") — anonymous public pages

- Professional home: `/sundhedsfaglig/`
- Lægehåndbogen (clinician handbook): `/sundhedsfaglig/laegehaandbogen/`
- Drug interactions (DLI): `/sundhedsfaglig/laegehaandbogen/dli-medicin/`
- Lookup tools hub: `/sundhedsfaglig/opslag-og-vaerktoejer/`
- External links: `/sundhedsfaglig/opslag-og-vaerktoejer/linkportalen/`
- Embedded textbooks: `/sundhedsfaglig/opslag-og-vaerktoejer/laereboeger/`
- Practice info: `/sundhedsfaglig/information-til-praksis/`
- Help & training: `/sundhedsfaglig/hjaelp-sundhedsfaglig/`
- Professional search: `/sundhedsfaglig/shf-soeg/`

Sitemaps: `/sitemap-laegehaandbog.xml`, `/sitemap-laegemiddelanbefaling.xml`, `/sitemap-patientforloeb.xml`, `/sitemap-informationtilpraksis.xml` (also reachable via `sundhed urls --shard laegehaandbog` etc.).

### Clinician — logged-in dashboard (`/sundhedsfaglig/min-side/`, MitID Erhverv / SOSI)

**Website-only.**

**Patient-data tools** (`/sundhedsfaglig/min-side/patientdata/`) — CPR-based patient lookup; requires established treatment relationship; audit-logged. Tools: national e-Journal, Laboratorieportalen, home measurements, hearing-aid file, camera-pill screening, regional anticoagulant systems, sentinel quality data, genetic register, researcher access, consents. Patient selection via global "person picker" (`personvaelger`); context persists until cleared.

**Clinic administration** (`/sundhedsfaglig/min-side/klinikadministration/`) — staff, audit logs, patient list, practice declaration (public profile for "Find behandler"), private-hospital agreements, product whitelist, researcher data export. Audit log: `.../log-over-andres-adgang/`; practice profile: `.../praksisdeklaration/`.

**Personal settings** (`/sundhedsfaglig/min-side/min-opsaetning/`) — profile, consent declarations.

**Clinician limits** — patient lookup requires established treatment relationship; audit-logged. Region-specific tools only show that region's data. The portal is a national overlay, not an EPR replacement.

### Internal JSON API (background)

`https://www.sundhed.dk/api/` backs the Angular SPA. No public/documented API; `robots.txt` disallows `/api/`. **Prefer the `sundhed` CLI** for the anonymous endpoints; this is background for cases the CLI doesn't cover.

- Send `Accept: application/json` + a normal browser `User-Agent`. Queue-it may challenge a missing UA.
- Most endpoints take parameters as **query strings** (`?section=borger`); path-segment variants often return 400 `SerializationException`.
- Some require **POST + JSON body** (notably `/api/ordbog/autocomplete/`); bodyless POSTs need `Content-Length: 0`.
- Error envelope: `{ "ResponseStatus": { "ErrorCode": "...", "Meta": { "Severity": "1" } } }`.
- HTTP `520` from `/api/search/autosuggest` is a deterministic rejection — reproduce the SPA's request shape via DevTools.
- Anonymous endpoints work without cookies. Authenticated endpoints use session cookies from MitID / MitID Erhverv / SOSI; no API keys.

Anonymous endpoints (all wrapped by the CLI): `/api/version`, `/api/login/isloggedin`, `/api/keepalive/timeleft`, `/api/keepalive/renew`, `/api/core/startupsettings`, `/api/core/appsetting/{Key}`, `/api/navigationtopmenu/`, `/api/navigationfootermenu/`, `/api/navigationiconmenu/`, `/api/navigationloginoverlay/`, `/api/searchorganizationtype/`, `/api/search/searchadditionalfilters`, `/api/pagetheme/`, `/api/core/applicationplugin/`, `/api/ordbog/autocomplete/`, `/api/cms/sitemap`, `/api/alertbanners/`.
