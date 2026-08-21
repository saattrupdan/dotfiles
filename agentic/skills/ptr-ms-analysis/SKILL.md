---
name: ptr-ms-analysis
description: >
  Analyse PTR-MS / PTR-TOF data from IONICON IoniTOF HDF5 (.h5) files with the
  published ptr-ms-analysis CLI. Use when the user has IONICON PTR-MS .h5 output
  and wants product-ion peaks extracted, transmission-corrected, converted to
  concentration (ppb and µg/m³), and summarised per time segment (breath bags,
  backgrounds, sample periods). Triggers are "PTR-MS", "PTR-TOF", "IoniTOF",
  "IONICON", "PTR-MS Viewer", "breath VOC analysis", or an .h5 with
  SPECdata/TRACEdata groups.
last-updated: 2026-08-21
---

# PTR-MS analysis

Use the published [`ptr-ms-analysis`](https://pypi.org/project/ptr-ms-analysis/)
package. This skill is the agent-facing workflow and scientific guardrail; the HDF5
reader, quantification code, browser app, and reference data live in the package,
not in this skill.

## Run this first

The whole interface is one CLI: `ptr <subcommand> …`. Install it once, then call
`ptr` from any directory. Do not read or recreate package internals, write custom
HDF5 parsing, or hand-build a virtual environment.

### Install or upgrade

If you previously installed the skill from a checkout, editable install, or Git
source, first uninstall that pipx/uv tool (as applicable), then install
`ptr-ms-analysis` from PyPI. After that, use the normal upgrade commands below.

```bash
pipx uninstall ptr-ms-analysis  # or: uv tool uninstall ptr-ms-analysis
pipx install ptr-ms-analysis    # or: uv tool install ptr-ms-analysis
```

Use an isolated tool installation so the package's dependencies and flat internal
module names cannot collide with another Python project. Prefer `pipx`:

```bash
# First install
pipx install ptr-ms-analysis

# Later, upgrade the published package
pipx upgrade ptr-ms-analysis
```

If `uv` is already available, it is an equivalent alternative:

```bash
uv tool install ptr-ms-analysis
uv tool upgrade ptr-ms-analysis
```

If `pipx` is missing, bootstrap it and open a new shell if `ensurepath` changes
PATH:

```bash
# macOS with Homebrew
brew install pipx && pipx ensurepath

# Linux/macOS without Homebrew
python3 -m pip install --user pipx && python3 -m pipx ensurepath

# Windows PowerShell
py -m pip install --user pipx; py -m pipx ensurepath
```

### Verify the command and resolve collisions

After installation or upgrade, verify both ownership and execution. Existing
commands with the same name must not silently win through PATH ordering:

```bash
# POSIX shells
command -v ptr
type -a ptr
pipx list                         # or: uv tool list
ptr --help
ptr rates water
```

On Windows PowerShell use `Get-Command ptr -All` instead of `command -v` / `type
-a`. The first `ptr` reported must be the executable from the selected pipx/uv
tool environment, and the tool list must show `ptr-ms-analysis`. If another
installation appears first, fix PATH or remove/rename the conflicting command
before analysing data. If the command is not found after `ensurepath`, start a
new shell and repeat the verification.

All discovery commands emit JSON on stdout; logs go to stderr. Use `--pretty`
when readable JSON is useful. Large files may be about 1 GB; a full analysis can
take about a minute. `ptr <command> --help` is the authoritative option list.

## Standard workflow

There is deliberately no one-shot default. Use **detect → curate → browser
review → analyse**. Browser review is the default and required endpoint after
curation; skip it only when the user explicitly requests a headless/no-browser
analysis. Curation is important: it prevents a mechanical top-candidate guess
from deciding the chemistry and sample windows.

### 1. Inspect the file

```bash
ptr inspect FILE.h5
```

Confirm that the file is IoniTOF and record its cycle count, duration, cycle
length, mass calibration, transmission curve, file-derived concentration
constant `K`, and molar volume.

### 2. Decide the output scope before selecting peaks

Choose explicitly:

- **Comprehensive Viewer-style export** (the default for “analyse this file” or a
  final CSV): retain every credible analyte, fragment, isotope, reagent ion, and
  water-cluster channel. Keep ambiguous real channels with honest labels.
- **Targeted chemistry panel**: use only when the user asks for named compounds or
  a small biomarker panel.
- **Reference/project reproduction**: use the exact configured masses and cycle
  windows from the reference or operator protocol.

Comprehensive means every real channel, not every detected maximum. Never
silently reduce a general export to a handful of familiar VOCs. The common-VOC
assignments are aids, not a whitelist. If scope is genuinely ambiguous, ask
whether comprehensive or targeted output is wanted.

### 3. Detect peaks, then curate chemistry

```bash
ptr peaks FILE.h5 --min-height 0.001
```

The default output is cleaned of ringing combs, low-prominence ripples, and the
H₃O⁺ saturation skirt near m/z 19–21. Each remaining peak is safe to consider for
quantification and includes values such as `mz`, `height`, `prominence`,
`neutral_mass`, `suggested_label`, candidate assignments, `id_confidence`, and
artifact/overlap flags. `suggested_label` can be copied into a config, but it is
a suggestion: override it when chemistry or time behaviour says otherwise. Use
`--full` only for a deep isobar/formula investigation.

Important interpretation rules:

- `id_confidence` is a conservative normalized candidate score, **not** a
  calibrated probability. A sole generated candidate is not 100% confidence.
- A confident formula is not necessarily a uniquely identified isomer. Treat
  `id_ambiguous` and close candidates as unresolved.
- Near-duplicate integration windows can double-count one signal. Review
  `n_window_overlap_pairs` and keep one m/z from each overlapping pair unless
  there is a defensible reason not to.
- `likely_artifact` diagnostic ions (H₃O⁺, O₂⁺, NO⁺, and water clusters) are real
  ions that may be retained or dropped. Do not reintroduce noise merely to make
  the export broader. `--include-artifacts` is for investigation, not the
  normal panel.
- If `peaks` or automatic analysis returns `signal_present: false` and no peaks,
  report a blank/no-beam/aborted capture and stop. Do not lower thresholds or
  fabricate analytes from noise.

Mass alone does not settle identity. After selecting ranges, inspect the
`background` diagnostic from `analyze`: a real breath analyte should generally
have sample/background ratio (S/B) much greater than 1. A channel with S/B < 1
or a rising `bg_trend` is background, memory, or contamination. Relabel it
`background m/z …` or remove it from a targeted analyte panel; do not deliver it
as bare `unknown m/z …`.

### 4. Detect and curate time ranges

```bash
ptr segments FILE.h5 --merge-high-gap 30
```

The command proposes stable plateaus as `{start_cycle, end_cycle, start_s,
end_s, level, class}`. `high` is likely sample and `low` is background/setup.
Drop a long initial warm-up. A short unclassified gap may split one physical
sample; `--merge-high-gap N` can merge adjacent high plateaus across at most N
cycles, but never across a low plateau. Inspect every proposed merge: on
one-second data, 30 cycles was validated for a split breath sample while 60
cycles incorrectly merged distinct samples.

Detection is only a proposal. Curate stable windows, exclude transitions, and
write generic labels in chronological order: `sample_01`, `sample_02`, … and
`background_01`, `background_02`, …, numbering the classes independently. Do not
ask the user to name or order samples. Keep named labels only in a temporary
comparison file when exact reference matching requires them.

### 5. Save a config and produce the CSV

Put all peak and range decisions in a JSON config. A minimal example:

```json
{
  "peaks": [
    {"mz": 59.049, "label": "acetone/propanal", "formula": "C3H6O"},
    {"mz": 69.070, "label": "isoprene", "formula": "C5H8"}
  ],
  "ranges": [
    {"label": "sample_01", "start": 6337, "end": 6483, "unit": "cycle"},
    {"label": "background_01", "start": 6523, "end": 6675, "unit": "cycle"}
  ],
  "checklist": [
    "Confirm the final segment boundary and the background relabelled during curation."
  ]
}
```

`unit` is `cycle` (1-based, inclusive) or `second`. `checklist` is optional and
is for points the human should confirm in browser review: ambiguous boundaries,
background relabelling, humidity caveats, low-confidence IDs, or calibration
limitations.

The optional `analyze` object is authoritative for settings including `R`,
`R_phys`, `K`, `molar_volume`, `primary_mz`, `kinetic`, `k_anchor`,
`humidity_correct`, `humidity_p`, `humidity_ref`, and `whole_run_windows`.
Resolution is **CLI override > config value > legacy default**. Unknown config
fields are retained, and the output summary records effective values and their
sources.

For a headless export only when the user explicitly requests no browser review:

```bash
ptr analyze FILE.h5 \
  --config analysis-config.json \
  --include-cycle-rows \
  --out results.csv
```

Use `--include-cycle-rows` for final Viewer-style exports. It records every
range boundary, making later comparison and reproduction possible. Only when the
user explicitly requests an automated/no-browser result, the zero-curation
fallback is:

```bash
ptr analyze FILE.h5 --auto-peaks --auto-segments \
  --include-cycle-rows --out results.csv
```

Automatic mode drops noise artifacts and applies only confident labels; a
hand-curated config remains preferable. Do not run `peaks`/`segments` to curate
and then pass `--auto-peaks`/`--auto-segments`, because that discards the
curation.

Before delivery, check scope, channel breadth, noise, sample/background counts,
warm-up and transitions, cycle rows, `background` S/B results,
`measured_apexes`, `apex_warnings`, humidity warnings, row counts, and finite
numeric values. Investigate every apex warning. Never present unavailable or
uncalibrated concentration as if it were authoritative.

### 6. Review in the browser (required default after curation)

```bash
ptr viz FILE.h5 --config analysis-config.json --out results.csv
```

After curation, launch `viz` by default; do not deliver a curated analysis from
headless `analyze` unless the user explicitly requested no browser review. `viz`
reviews the curated peak list and ranges; it does not replace curation. It runs a
localhost app, normally opens a browser, saves edits to the config, and writes the
authoritative full-precision CSV when the expert clicks **Done**.
The command waits for the browser, so run it in the background and give the user
the printed URL. Wait for `review app running` in its stderr/log; startup can
take 30–90 seconds on a large file and the port refuses connections while the
file is loading.

Put review points in the config `checklist`, not in a long chat message. The
expert can inspect traces and integration windows, edit peaks/ranges, and change
`R`, `R_phys`, primary m/z, `K`, molar volume, kinetic correction, humidity, and
whole-run versus isolated windows. `R`, peak/range edits, K, molar volume,
kinetic, and humidity recompute from preview data. Primary m/z, `R_phys`, and
whole-run window mode require re-extraction/deconvolution; the app marks these
settings stale and shows preview versus final values. **Done** reruns `analyze`;
the delivered CSV comes from that full-precision run, never from a browser
approximation.

For an explicitly requested offline hand-off, use `--html review.html`. The
reviewer can edit the standalone page and click **Download config.json**, then
another operator can run `ptr analyze` on the returned config.

### 7. Calibrate and compare when references exist

Absolute concentration depends on one calibration constant `K`:

```bash
ptr calibrate FILE.h5 reference.csv
# Only for an explicitly requested headless calibrated export:
ptr analyze FILE.h5 --config analysis-config.json --K 16.26 \
  --include-cycle-rows --out results.csv
```

Use `calibrate` with an existing reference Viewer CSV or known standard; never
ask the user to generate a reference in proprietary PTR-MS Viewer. Without one,
state that concentration uses the file's acquisition calibration and may have
roughly 10–15% absolute uncertainty. Relative comparisons remain useful. Offer a
standards calibration for tighter absolute values.

```bash
ptr compare results.csv viewer.csv --per-mass
```

Comparison requires matching masses and range labels. Align the panel and cycle
windows first; “no overlapping rows” is a structural mismatch, not a numerical
failure.

## Scientific safeguards and provenance

The package calculates, in simplified form:

- **Raw [cps]**: sum of intensities over the peak's m/z window.
- **Corrected**: Raw divided by the `PTR-Transmission` curve; if transmission is
  absent, unity transmission is used and the result is flagged.
- **Conc [ppb]**: Corrected × K / the per-cycle primary-ion signal × the kinetic
  sensitivity factor when enabled.
- **Conc [µg/m³]**: concentration × neutral mass / molar volume.

Standard processed files may contain mass calibration, transmission, and
precomputed concentration data. Raw exports may lack some of these: then
`inspect`/`analyze` expose the fallback, and concentration can be unavailable
(`NaN`) unless `--K` is supplied. Report these limitations honestly.

The primary-ion normaliser is m/z 21.022 by default; change `--primary-mz` for
NO⁺/O₂⁺ modes. Isolated peaks use apex-centred windows; closely spaced clustered
peaks use fixed-centre Gaussian/deconvolved components. Do not recenter clustered
components onto the same local maximum.

With `--kinetic`, each compound's proton-transfer rate constant comes from its
explicit config `k`, formula, or m/z lookup in the package's bundled rate table.
The default uses one sensitivity for all compounds. Kinetic correction can be
more physically accurate but will diverge from a single-k reference; document
which mode was used. An explicit per-peak `k` does not suppress independent
library flags such as humidity or fragmentation.

Humidity-sensitive, near-thermoneutral compounds (HCN, formaldehyde, H₂S, formic
acid, ammonia) require special care. `analyze` reports per-range water-cluster
ratios (m/z 37 / primary ion) and cross-range spread. If humidity varies, flag
those concentrations as confounded. `--humidity-correct` applies
`(ratio / ref)^p`; `p` must be calibrated with a standard at at least two
humidities for accurate absolute values. Without an HCN standard, treat HCN's
absolute concentration as indicative only.

## Command reference and tuning

Commands: `inspect`, `peaks`, `segments`, `analyze`, `viz`, `calibrate`, `compare`,
and `rates <name|formula|mz>`. Add `--help` to any command; discovery output
is JSON and `--pretty` indents it.

| Option | Default | Use |
| --- | --- | --- |
| `--R` | 1200 | Integration resolution/window; adjust for neighbour overlap. |
| `--R-phys` | 2400 | Physical resolution for deconvolution; use the measured instrument resolution. |
| `--K` | File-derived | Pin concentration scale from `calibrate` or a standard. |
| `--kinetic` | Off | Per-compound rate correction; document divergence from single-k references. |
| `--k-anchor` | 2.0 | Baseline rate constant used by the kinetic correction. |
| `--humidity-correct` | Off | Normalise humidity-sensitive compounds. |
| `--humidity-p` | 1.0 | Humidity exponent; calibrate before treating as absolute. |
| `--humidity-ref` | Run median | Reference water-cluster ratio. |
| `--primary-mz` | 21.022 | Reagent-ion normaliser; change for other ion modes. |
| `--molar-volume` | Drift temperature | Set 24.465 for the 25 °C ambient convention. |
| `--include-cycle-rows` | Off | Include reproducible range-boundary rows in final exports. |
| `--merge-high-gap` | 0 | Merge high plateaus across a short unclassified gap; inspect every merge. |

## Out of scope

This workflow quantifies a peak list; it is not untargeted formula assignment or
isomer identification. For untargeted discovery use tools such as `ptairMS` or
`PTRwid`; for general IONICON file reading use IONICON's `PyTRMS`. The data does
not reliably reveal segment identities, the operator's original target panel, or
exact manual integration choices.
