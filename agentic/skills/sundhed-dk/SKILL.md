---
name: sundhed-dk
description: sundhed.dk — Danish national e-health portal. Covers citizen (MitID) and clinician (MitID Erhverv/SOSI) flows - public content, Min Side dashboards, and the internal undocumented JSON API. Use for Danish health-portal tasks.
last-updated: 2026-05-07
---

# sundhed.dk — Danish e-health portal

Official Danish national e-health portal for citizens and healthcare professionals. All URLs relative to `https://www.sundhed.dk`. Respond in Danish unless the user signals otherwise.

---

# sundhed.dk — citizen ("borger")

Login = **MitID**.

## Anonymous (no login)

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

## Logged-in dashboard ("Min Side")

Root: `/borger/min-side/`.

### Min Sundhedsjournal

Aggregates regional/national back-ends. Key sections: medication record, lab results, hospital records, vaccinations, diagnoses, referrals, appointments, care plans, CAVE alerts, imaging reports, GP info, timeline, questionnaires, home measurements, regional apps (AK Online, Diabetes Online, AmbuFlex), hearing-aid file.

### Self-service

- Prescription renewal: `/borger/min-side/receptfornyelse/`
- Book GP appointment: `/borger/min-side/tidsbestilling/`
- Email consultation: `/borger/min-side/e-mail-konsultation/`
- New-user onboarding: `/borger/min-side/ny-bruger-paa-sundheddk/`

### Registrations (`/borger/min-side/mine-registreringer/`)

Organ donor, living will, resuscitation opt-out, stem-cell donor, research consents, power-of-attorney (`fuldmagt.nemlog-in.dk`), master data card, cancer screenings, camera-pill screening, genetic-family register.

### Audit log (`/borger/min-side/min-log/`)

Who accessed your data, past digital consultations, mark data private, consent declarations.

## Common citizen tasks

- **View medication / renew prescription**: MitID → `/borger/min-side/min-sundhedsjournal/medicinkortet/` or `/borger/min-side/receptfornyelse/`
- **Book GP appointment**: `/borger/min-side/tidsbestilling/`
- **Find a GP** (no login): `/borger/guides/find-behandler/`
- **Lab results**: `/borger/min-side/min-sundhedsjournal/laboratoriesvar/`
- **Hospital records**: `/borger/min-side/min-sundhedsjournal/journal-fra-sygehus/`
- **Organ donor**: `/borger/min-side/mine-registreringer/organdonation/`
- **Disease info** (no login): `/borger/patienthaandbogen/`
- **Access audit**: `/borger/min-side/min-log/min-log/`
- **Live chat**: `/borger/service/kontakt/hjaelp-borger/chat/`

## Limits

- Data visibility depends on source systems; some records are delayed. Regional apps only work in operating regions. Danish-only. No public health-data API — everything is session-bound to MitID. Fronted by `queue-it.net` at peak.

---

# sundhed.dk — healthcare professional ("sundhedsfaglig")

Login = **MitID Erhverv** (standard) or **SOSI** smartcard (legacy, in-clinic).

## Public reference content (no login)

- Professional home: `/sundhedsfaglig/`
- Lægehåndbogen (clinician handbook): `/sundhedsfaglig/laegehaandbogen/`
- Drug interactions (DLI): `/sundhedsfaglig/laegehaandbogen/dli-medicin/`
- Lookup tools hub: `/sundhedsfaglig/opslag-og-vaerktoejer/`
- External links: `/sundhedsfaglig/opslag-og-vaerktoejer/linkportalen/`
- Embedded textbooks: `/sundhedsfaglig/opslag-og-vaerktoejer/laereboeger/`
- Practice info: `/sundhedsfaglig/information-til-praksis/`
- Help & training: `/sundhedsfaglig/hjaelp-sundhedsfaglig/`
- Professional search: `/sundhedsfaglig/shf-soeg/`

Sitemaps: `/sitemap-laegehaandbog.xml`, `/sitemap-laegemiddelanbefaling.xml`, `/sitemap-patientforloeb.xml`, `/sitemap-informationtilpraksis.xml`.

## Logged-in dashboard (`/sundhedsfaglig/min-side/`)

### Patient-data tools (`/sundhedsfaglig/min-side/patientdata/`)

CPR-based patient lookup. Requires established treatment relationship; audit-logged. Tools: national e-Journal, Laboratorieportalen (lab results), home measurements, hearing-aid file, camera-pill screening, regional anticoagulant systems, sentinel quality data, genetic register, researcher access, consents.

Patient selection via global "person picker" (`personvaelger`). Context persists until cleared.

### Clinic administration (`/sundhedsfaglig/min-side/klinikadministration/`)

Manage staff, audit logs, patient list, practice declaration (public profile for "Find behandler"), private-hospital agreements, product whitelist, researcher data export.

### Personal settings (`/sundhedsfaglig/min-side/min-opsaetning/`)

Profile, consent declarations.

## Common clinician tasks

- **Drug interactions**: `/sundhedsfaglig/laegehaandbogen/dli-medicin/` (no login)
- **Clinic audit log**: `/sundhedsfaglig/min-side/klinikadministration/log-over-andres-adgang/`
- **Update practice profile**: `/sundhedsfaglig/min-side/klinikadministration/praksisdeklaration/`

## Limits

- Patient lookup requires established treatment relationship; audit-logged. Region-specific tools only show that region's data. Portal is a national overlay, not an EPR replacement.

---

# sundhed.dk internal JSON API

`https://www.sundhed.dk/api/`. No public/documented API; `robots.txt` disallows `/api/`. Endpoints back the Angular SPA. Treat as undocumented.

## Conventions

- Send `Accept: application/json` + normal browser `User-Agent`. Queue-it may challenge missing UA.
- Most endpoints take parameters as **query strings** (`?section=borger`). Path-segment variants often return 400 `SerializationException`.
- Some require **POST + JSON body** (notably `/api/ordbog/autocomplete/`).
- Error envelope: `{ "ResponseStatus": { "ErrorCode": "...", "Meta": { "Severity": "1" } } }`.
- HTTP `520` from `/api/search/autosuggest` is deterministic rejection — reproduce the SPA's request shape via DevTools.

## Auth model

- Anonymous endpoints work without cookies.
- Authenticated endpoints use session cookies from MitID / MitID Erhverv / SOSI. No API keys.
- Login state: `GET /api/login/isloggedin`
- Keepalive: `GET /api/keepalive/timeleft` (seconds, `-1` if anonymous), `POST /api/keepalive/renew`

## Verified anonymous endpoints

### `GET /api/login/isloggedin`
```json
{"IsLoggedIn":false,"DisplayName":"","RoleName":"","ConsentSigned":false,"Cpr":"","IsDelegated":false,"IsCitizen":false,"IsSosi":false,"Version":1}
```

### `GET /api/keepalive/timeleft`
Bare integer (seconds). `-1` when not logged in.

### `POST /api/keepalive/renew`
Returns `false` with 200. Send with `Content-Length: 0`.

### `GET /api/core/startupsettings`
Site config. Stable keys: `EnableUserLogin`, `dufUrl`, `fmUrl`, `PortalV2WebHost`, `GlobalServiceHelpLinksPath`, `UseGlobalPersonSelector`.

### `GET /api/core/appsetting/{Key}`
Single entry, e.g. `{"Key":"PortalV2WebHost","Value":"https://v2.sundhed.dk"}`.

### `GET /api/navigationtopmenu/?section={borger|sundhedsfaglig}`
Top menu keyed by structure ID.

### `GET /api/navigationfootermenu/?section={borger|sundhedsfaglig}`
Footer blocks + contact info. Two top-level keys: `FooterMenuItems`, `ContactInfo`. Abstract text has HTML entities.

### `GET /api/navigationiconmenu/?section={borger|sundhedsfaglig}`
Icon menu. Four keys: `BorgerMenuItemBlocks`, `FagPersonMenuItemBlocks`, `Borger`, `Fagperson`.

### `GET /api/navigationloginoverlay/`
Login redirect paths: `LoginAdvantagePathBorger`, `LoginAdvantagePath`.

### `GET /api/searchorganizationtype/`
Provider categories for "Find behandler" filter.

### `GET /api/search/searchadditionalfilters?section={borger|sundhedsfaglig}`
Regions and municipalities for search.

### `GET /api/pagetheme/?path={portalUrl}`
Per-page theming. Array matched by `PortalUrl`.

### `GET /api/core/applicationplugin/`
SPA application-plugin registry (regional apps, etc.).

### `POST /api/ordbog/autocomplete/`
Medical-dictionary autocomplete. Body: `{"SearchTerm":"..."}`.

### `GET /api/cms/sitemap`
JSON list of sitemap shard URLs.

### `GET /api/alertbanners/`
Site-wide outage banners keyed by root page.

## Helper script

`sundhed_dk_api.py` (same folder) wraps verified endpoints. Standard library only.

```bash
python3 sundhed_dk_api.py version                                # /api/version
python3 sundhed_dk_api.py login                                  # login state
python3 sundhed_dk_api.py keepalive [timeleft|renew]             # session lifetime
python3 sundhed_dk_api.py settings                               # startup settings as key=value
python3 sundhed_dk_api.py setting PortalV2WebHost                # single app setting
python3 sundhed_dk_api.py menu --section borger --kind top       # top|footer|icon menu
python3 sundhed_dk_api.py filters --section borger               # regions + municipalities
python3 sundhed_dk_api.py orgtypes                               # provider catalogue
python3 sundhed_dk_api.py pagetheme --path /borger/              # page themes
python3 sundhed_dk_api.py alerts                                 # active banners
python3 sundhed_dk_api.py plugins                                # app-plugin registry
python3 sundhed_dk_api.py autocomplete blod                      # medical dictionary
python3 sundhed_dk_api.py sitemap                                # sitemap shards
python3 sundhed_dk_api.py urls --shard artikel                   # URLs in a shard
```

Append `--raw` to skip the formatter and print raw JSON. Errors go to stderr (non-zero exit).
