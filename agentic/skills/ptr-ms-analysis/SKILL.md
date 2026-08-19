---
name: ptr-ms-analysis
description:
  Analyse PTR-MS / PTR-TOF data from IONICON IoniTOF HDF5 (.h5) files — an open-source
  replacement for the proprietary PTR-MS Viewer. Use when the user has IONICON PTR-MS
  .h5 output and wants product-ion peaks extracted, transmission-corrected, converted to
  concentration (ppb and µg/m³), and summarised per time segment (breath bags,
  backgrounds, sample periods). Triggers are "PTR-MS", "PTR-TOF", "IoniTOF", "IONICON",
  "PTR-MS Viewer", "breath VOC analysis", an .h5 with SPECdata/TRACEdata groups.
last-updated: 2026-08-17
---

# PTR-MS analysis (open-source PTR-MS Viewer replacement)

Reprocess IONICON IoniTOF PTR-MS `.h5` files without the proprietary PTR-MS Viewer.
Produces a Viewer-style CSV: for each target ion and time segment, the
Max/Min/Average/Deviation of **Raw** (cps), **Corrected** (transmission-corrected),
**Conc** (ppb) and **Conc [µg/m³]**. Each segment is integrated with each peak's
window re-centred on that segment's own spectrum (peaks drift between segments);
`--no-per-interval` reverts to one whole-run window per compound.

**This skill is agent-driven.** The CLI does the deterministic physics (peak
integration, transmission, concentration, statistics) and detects candidate peaks and
time segments. **You** assign chemistry and curate the segment boundaries — then hand the
curated config to the browser review (`viz`), which is the **default endpoint**. There is
intentionally no one-shot `auto`: `viz` always runs on your best solution, so the human is
confirming a good result rather than repairing a mechanical guess. Because you curated
first, ideally nothing needs changing and *Done* is a one-click confirmation — the CSV it
writes is identical to the no-review path. Only skip `viz` and go straight to `analyze`
when the user explicitly wants no review (headless/automated, or a portable file to hand
off).

Final range labels are deterministic: use `sample_01`, `sample_02`, … for high plateaus
and `background_01`, `background_02`, … for low plateaus, each numbered chronologically
and independently. **Never ask the user to label sample plateaus.**

Do not expect the user to hand you a config. Discover, reason, then analyse.

**This tool *replaces* PTR-MS Viewer — never send the user back to it.** Do not tell the
user to open, run, re-process, export from, or cross-check anything in PTR-MS Viewer (or
any other proprietary tool). Everything they need happens here. A "reference CSV" only
ever means a file the user *already has* (from a past run or a colleague) that you can
`calibrate`/`compare` against — never something you ask them to go and generate in the
Viewer. If accurate absolute concentration matters and no reference exists, say so and
offer a standards calibration; do not suggest the Viewer as the answer.

## How to run it — read this first

- **Everything is one CLI:** `bin/ptr <subcommand> …`. Set `PTR=<SKILL_DIR>/bin/ptr`
  (`<SKILL_DIR>` = the directory of this file).
- **No setup — you (the agent) always use the launcher.** `bin/ptr` manages its own Python
  environment; the first call installs h5py+numpy into a cache (~30 s, logged to stderr),
  later calls are instant. **Do NOT** create a venv, pip-install anything, or test for h5py
  yourself. (A human who wants the command on their PATH can install it — see *Installation*
  below — but the agent never needs that; the launcher always works.)
- **Never read `scripts/*.py`, and never write your own HDF5/parsing/quantification
  code.** Every operation is a subcommand and every value you need is in its JSON output
  — `peaks` already returns candidate compound assignments, the run's mass-drift, and
  artifact flags; `analyze` reports apex checks, humidity, and the params used. If
  something seems missing it is a flag: run `ptr <cmd> --help`, don't reimplement it.
- Discovery commands print JSON to stdout (logs go to stderr). Files are large (~1 GB);
  a full `analyze` streams in ~60 s.

**There is no one-shot command.** The flow is always: *detect → **you** curate into a
config → **review** that config in `viz`.* Curating first is the point — it means the
browser review reflects your best chemistry assignment and segment choices, not a
mechanical top-candidate guess. **`viz` is the default final step** for "analyse this
file": launch it once you have a config unless the user has said they don't want a review.

```bash
PTR=<SKILL_DIR>/bin/ptr

# 1. Detect (deterministic; gives you candidates + flags to reason over):
$PTR inspect  FILE.h5                   # confirm IoniTOF; calibration, transmission, K, Vm
$PTR peaks    FILE.h5                   # peaks + candidate compounds + artifact flags
$PTR segments FILE.h5                   # stable plateaus to label

# 2. YOU write analysis-config.json: curated peaks (assignments picked from `candidates`,
#    honest `unknown` where unsure, artifacts judged) + ranges (sample_/background_ labels).

# 3. DEFAULT: browser review of YOUR config -> Done -> analyze -> CSV. BLOCKS on the
#    browser, so run it backgrounded and give the user the URL:
$PTR viz FILE.h5 --config analysis-config.json --out results.csv   # localhost app; waits for 'Done'

# 3-alt. No review — ONLY when the user explicitly wants headless/no-browser output, or a
#        portable file to hand off. Same curated config, straight to CSV:
$PTR analyze FILE.h5 --config analysis-config.json --include-cycle-rows --out results.csv

# Quick deterministic fallback (no curation, no browser — detect + quantify only; peaks
# left as bare m/z, not assigned). Only for a rough look, never a final labelled export:
$PTR analyze FILE.h5 --auto-peaks --auto-segments --include-cycle-rows --out results.csv
```

**`viz` is long-running and interactive** (it waits for a human to click *Done* in the
browser). Run it as a background command and tell the user to open the URL it prints; the
CSV is written when they finish. Do not wait for it to return before responding — hand
over the URL and let the user drive.

## Installation (optional — for a human who wants `ptr` on their PATH)

The agent never needs this: `bin/ptr` is a self-contained launcher that bootstraps its own
environment. But the project is a proper installable package (`pyproject.toml`), so a human
can put the `ptr` command on their PATH. **Recommended: `pipx`** (isolated env — the CLI's
flat module names can't collide with anything else):

```bash
pipx install <SKILL_DIR>            # -> `ptr` on PATH; `pipx upgrade ptr-ms-analysis` later
# or, into an existing environment:
pip install <SKILL_DIR>            # (ideally a venv; installs h5py+numpy)
```

Then `ptr inspect FILE.h5`, `ptr peaks FILE.h5`, etc. work from anywhere. It is not yet on
PyPI, so install from this directory (a git checkout works too). If `ptr` is not found on
PATH, it simply isn't installed — fall back to the launcher `<SKILL_DIR>/bin/ptr`, which
needs no installation.

## Workflow

### 1. Inspect

```bash
$PTR inspect FILE.h5
```

Confirms it is an IoniTOF file and returns cycle count, duration, cycle length, mass
calibration, transmission curve, the file-derived concentration constant K, and molar
volume.

### 2. Decide the output scope before selecting peaks

Use one of these explicit modes:

- **Comprehensive Viewer-style export (default for "analyse this file" or "final
  CSV")**: retain every credible analyte, fragment, isotope, reagent-ion, and
  water-cluster channel. Label ambiguous channels honestly; do not discard them merely
  because they are not familiar VOCs.
- **Targeted chemistry panel**: use only when the user asks for named compounds or a
  small biomarker panel.
- **Reference/project reproduction**: use the exact configured masses and cycle windows
  from the reference or operator protocol.

**Never silently reduce a general final export to a handful of common VOCs.** If scope
is genuinely ambiguous, ask whether the user wants comprehensive or targeted output. The
common-VOC table is an assignment aid, not a whitelist.

### 3. Detect peaks, preserve breadth, then assign chemistry

```bash
$PTR peaks FILE.h5 --min-height 0.001
```

Each peak comes annotated: `{mz, height, rel_height, neutral_mass, candidates, [likely_artifact]}`.
`candidates` lists the nearest table compounds (sorted by `|delta_mDa|` after removing
the reported `mass_drift`), so **pick the assignment from there** — you do not need to
query `TraceInfo` or compute mass offsets yourself. `likely_artifact` flags reagent
ions, water clusters, and ringing. Keep uncertain product-ion peaks labelled honestly
(e.g. `unknown m/z 75.046`) rather than inventing a compound; `reference/ptr-ms-chemistry.md`
adds context. Investigate every `apex_warning` from `analyze`.

**Then check behaviour, not just mass.** A peak's identity is not settled by its m/z
alone — its time profile tells you whether it is a breath analyte or instrument
background/contamination. Once you have curated ranges (step 4), run `analyze --config`
and read its **`background` diagnostic**: it reports each channel's sample-vs-background
ratio (S/B) and whether it drifts across the run. Real analytes are far higher in samples
(S/B ≫ 1); a channel with **S/B < 1** (higher in backgrounds) and/or a steady upward
`bg_trend` is background/memory/contamination, not something in the breath. **Relabel such
channels `background m/z …`, or drop them from an analyte panel** — do not ship them as
bare `unknown m/z …`. Scrutinise unidentified and high-m/z peaks first (reagent/cluster
diagnostic ions flagging here is expected and fine to keep as-is).

For a credible assignment pass the canonical target `mz`; the extractor estimates the
run-wide mass drift and reports the actual apex under `measured_apexes`.

The HDF5 formula library is broad and does **not** reveal the operator's selected target
panel. A channel absent at the detection threshold may still have been part of their
project, so exact project reproduction is impossible without that metadata.

### 4. Detect, merge, and curate time ranges

```bash
$PTR segments FILE.h5 --merge-high-gap 30
```

The command returns stable plateaus as
`{start_cycle, end_cycle, start_s, end_s, level, class}`. `class:"high"` is likely a
sample; `class:"low"` is background or setup. A long initial low period is usually
warm-up and should be dropped.

A physical sample can be split into two high plateaus by a short signal change.
`--merge-high-gap N` merges consecutive high plateaus across at most `N` unclassified
cycles, but never across a detected low plateau. A merged result reports
`merged_segments > 1` and the exact `merged_gaps`. Start conservatively: on 1-second
data, 30 cycles merged genuine split samples in the validated breath run, while 60
cycles incorrectly merged distinct samples. Inspect every proposed merge.

Detection is only a proposal. Curate stable windows, avoid transitions, and save ranges
explicitly. Always assign generic labels in chronological order: `sample_01`,
`sample_02`, … for high ranges and `background_01`, `background_02`, … for low ranges.
Number the two classes independently. **Do not ask the user for sample names or order.**
Even when external names are available, keep the delivered CSV generic; use named labels
only in a temporary comparison file when matching a reference requires them.

### 5. Save a config and analyse to a reproducible final CSV

Put the complete peak and range decisions in a JSON config rather than a long shell
argument. The following is illustrative, not a complete panel:

```json
{
  "peaks": [
    { "mz": 59.049, "label": "acetone/propanal", "formula": "C3H6O" },
    { "mz": 69.07, "label": "isoprene", "formula": "C5H8" }
  ],
  "ranges": [
    { "label": "sample_01", "start": 6337, "end": 6483, "unit": "cycle" },
    { "label": "background_01", "start": 6523, "end": 6675, "unit": "cycle" }
  ],
  "checklist": [
    "Confirm the end-of-run segmentation: three plateaus, or two samples with a decay tail?",
    { "text": "m/z 47 is labelled background (formic acid, memory)",
      "detail": "S/B 0.83 and rising across the run — confirm it should stay out of the analyte panel." }
  ]
}
```

`checklist` (optional) is **your** short list of points the human should confirm in the
browser review — the things that genuinely need a human eye, *beyond* eyeballing peaks and
intervals: an ambiguous segment boundary, a channel you relabelled as background, a
humidity-confounded compound, a low-confidence identification, a calibration caveat. Each
item is a plain string, or `{ "text": ..., "detail": ... }` for a one-line elaboration.
The viz app renders these as a tickable checklist (see 5b); it is ignored by `analyze`.

```bash
$PTR analyze FILE.h5 \
  --config analysis-config.json \
  --include-cycle-rows \
  --out results.csv
```

`unit` is `"cycle"` (1-based, inclusive) or `"second"`. `--include-cycle-rows` appends
Viewer-style rows recording each range's boundaries and makes later
comparison/reproduction possible. Keep `analysis-config.json` beside the CSV.

`--auto-peaks` and `--auto-segments` are exploratory fallbacks, **not final-output
defaults**. If a quick generic pass is explicitly requested, combine
`--auto-segments --merge-high-gap N`; otherwise curate and label the config.

Before delivery, verify:

- the requested scope is comprehensive or explicitly targeted;
- no credible channel was dropped solely because its chemistry was uncertain;
- adjacent high plateaus were reviewed for physical-sample merging;
- warm-up and transition cycles are excluded;
- sample/background labels and counts are correct;
- Cycle rows are present;
- the `background` diagnostic was reviewed — channels with S/B < 1 (higher in
  backgrounds) are relabelled `background m/z …` or dropped, not shipped as bare
  `unknown`;
- `measured_apexes`, `apex_warnings`, humidity warnings, row counts, and finite numeric
  values were checked.

### 5b. Review the result in the browser (the default final step)

`viz` is the **default endpoint** for analysing a file — an expert visually confirms and,
if needed, tweaks peaks/segments/calibration. `viz` does **not** detect anything — it
reviews an existing peak list + ranges. **Always curate first, then review your best
solution**: ideally the expert finds nothing to change and Done is a one-click
confirmation (identical CSV to the headless path); if the config were a raw mechanical
guess, the human would be doing curation you should have done. So the order is: `peaks` +
`segments` → apply your judgment (steps 2–4 above) → write `analysis-config.json` → open
`viz` on it. Skip straight to `analyze` (step 5) only when the user explicitly wants no
review — a headless/automated run, or a portable file to hand off.

```bash
$PTR viz FILE.h5 --config analysis-config.json --out results.csv    # serve; Done -> writes results.csv
```

By default `viz` runs a localhost server, opens the browser, and **writes every change
straight into the `--config` file**; when the expert clicks **Done** it runs the
full-precision analysis and writes `--out` (the CLI prints the URL and blocks until
*Done*/`--timeout`, so run it backgrounded). For a portable file to email to someone
offline, use `--html review.html` instead (no server, no CSV; the expert tweaks and
clicks **Download config.json** to hand back for a later `ptr analyze`).

**Put your review points in the config's `checklist`, not in a wall of chat text.** The
long message you would otherwise write *after* launching `viz` is bad UX — it lands after
the user has already opened the browser, and it buries the few things that actually need
their attention. Instead: fold those points into the `checklist` (see section 5) so they
appear as a tickable list inside the app, right where the user is looking. Anything you'd
have written as "things to check" — an ambiguous boundary, a relabelled background
channel, a humidity/calibration caveat, a shaky identification — belongs there. Then your
chat reply is short: one or two lines handing over the URL and noting there's a checklist
waiting in the app. First-time users also get an automatic guided tour of the interface;
you don't configure it, but it means you don't need to explain the buttons in chat either.

In the app the expert sees the mass spectrum, a large zoom of the selected peak with its
integration window, and the compound's time trace with segments overlaid. They can
re-centre / add / remove / relabel peaks, drag / add / rename segments, and change **K**,
molar volume, the kinetic (`k`) correction, and the humidity correction — everything
recomputes live (the live math mirrors `analyze`; re-centred or overlapping peaks are
flagged `≈`/`overlap`, exact only after the re-run). **The delivered CSV always comes
from `analyze`**, never the browser.

### 6. Calibrate concentration when accurate ppb/µg matters

Absolute concentration needs one calibration constant **K**. By default it is derived
from the file and reproduces the instrument's own concentration; a different acquisition
setup can use a different scale. If the user **already has** a reference CSV (a past
export or a colleague's) or a known standard, pin K to it — never ask them to go generate
one in PTR-MS Viewer:

```bash
$PTR calibrate FILE.h5 reference.csv
$PTR analyze FILE.h5 --config analysis-config.json --K 16.26 \
  --include-cycle-rows --out results.csv
```

`calibrate` recovers ranges from the reference's Cycle rows. Without a reference, state
that concentrations use the file's own calibration and may carry roughly 10-15 % absolute
uncertainty (raise it in the review `checklist`); relative comparisons remain useful. If
they want tighter absolute numbers, offer a standards calibration — not the Viewer.

### 7. Compare when a reference exists

```bash
$PTR compare results.csv viewer.csv --per-mass
```

Comparison requires matching mass and range labels. First align the target panel and
cycle windows; otherwise "no overlapping rows" is a structural mismatch, not a numerical
failure. The validated breath reference gives median errors of 2.4 % Raw, 5.0 %
Corrected, 3.1 % Conc, and 3.2 % Conc[µg].

## How the numbers are produced

| Column           | Formula                                     | Constants — all read from the .h5                                                 |
| ---------------- | ------------------------------------------- | --------------------------------------------------------------------------------- |
| **Raw** [cps]    | Σ intensities over the peak's m/z window    | mass cal `CALdata/Mapping`                                                        |
| **Corrected**    | Raw / Transmission(m/z)                     | `PTR-Transmission` curve                                                          |
| **Conc** [ppb]   | Corrected × K / I_primary(t) × (k_anchor/k) | K from `TRACEdata`; primary from m/z 21; k from rate-constant table (`--kinetic`) |
| **Conc [µg/m³]** | Conc × (mz − proton) / Vₘ                   | Vₘ from drift temperature                                                         |

Concentration uses the standard **primary-ion-normalised** model: dividing by the
per-cycle reagent-ion signal (H₃O⁺ via its m/z 21 isotope) tracks reagent-ion drift over
the run, and **K** is a single calibration constant. Peaks are apex-centred
(auto-corrects calibration drift); closely-spaced peaks (Δm/z < 0.2) are separated by
linear Gaussian deconvolution. Full derivation: `reference/ionicon-h5-format.md`.

**Per-compound sensitivity (`--kinetic`).** Sensitivity scales with each compound's
proton-transfer rate constant k (`Conc ∝ 1/k`). By default one k is assumed for all
compounds (matches a single-sensitivity reference). Passing `--kinetic` scales each
compound by its own k — physically more accurate but it _diverges from_ a single-k
reference (e.g. benzaldehyde, k≈3.9, drops to ~half a k=2 reference). k comes from a
peak's explicit `"k"`, its `"formula"`, or its m/z, looked up in
`reference/rate_constants.json` (218 compounds from the PTR Library — Pagonis,
Sekimoto & de Gouw 2019; browse with the `rates` command). See
`reference/ptr-ms-chemistry.md`.

**Humidity handling (low-proton-affinity compounds).** HCN, formaldehyde, H₂S, formic
acid and ammonia have proton affinity near water's, so proton transfer is partly
reversible and their sensitivity depends on sample **humidity** — a fixed k or K
misquantifies them. Whenever such a compound is in the run, `analyze` reports a
**humidity diagnostic**: the per-range water-cluster ratio (m/z 37 / m/z 21 — m/z 19 is
usually saturated) and the cross-range spread. If humidity varies (it swung 30 % across
the almond samples and 237 % across the breath run), relative concentrations of those
compounds are confounded and it says so. Pass `--humidity-correct` to normalise them
per-cycle by `(ratio/ref)^p` (`--humidity-p`, 0=off … 1=equilibrium upper bound). **p
must be calibrated** from a standard at ≥2 humidities for accurate absolute values;
uncalibrated, the correction only puts _relative_ comparisons on equal-humidity footing
and its magnitude is approximate. HCN is the canonical case — flag it to the user and,
without an HCN standard, treat its absolute concentration as indicative only. The
wet-lab calibration that pins HCN (and how to recognise existing calibration data) is
described in `reference/hcn-calibration.md`.

## Accuracy & concentration calibration

Validated against two reference Viewer exports:

| Experiment                                             | Raw   | Corrected | Conc  | Conc[µg] |
| ------------------------------------------------------ | ----- | --------- | ----- | -------- |
| Breath, 22 masses × 18 ranges (default K)              | 2.4 % | 5.0 %     | 3.1 % | 3.2 %    |
| Bitter-almonds, 2 masses × 8 ranges (**calibrated K**) | 0.7 % | 3.1 %     | 2.6 % | 2.5 %    |

Raw and Corrected are file-derived and robust (median < 5 % on both). Larger Raw errors
appear only on very small isotope peaks (low SNR) and intense overlapping peaks (the m37
water-cluster region) — flag these rather than trusting them.

**Concentration has one irreducible calibration constant K.** The raw file does not
store the sensitivity a specific Viewer project used, and it genuinely varies between
experiments (e.g. K ≈ 19 vs 16 on the two above — the operator's Viewer setting). So:

- **With a reference Viewer CSV** (or a known standard): run `calibrate` to fit K, then
  pass `--K`. Concentration then matches to a few percent (as above).
- **Without one**: the default K is derived from the file's own acquisition calibration
  — physically valid, but its absolute scale may differ from a given Viewer project by
  ~10-15 %. **Tell the user** the concentration is on the instrument's own scale and
  offer to calibrate if they have a reference. Raw and Corrected are unaffected by this.

## Tuning

| Flag                                                  | Default           | Change when                                                                                                            |
| ----------------------------------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `--R`                                                 | 1200              | Integration window (half-width m/2R). Raise to reduce neighbour overlap; lower for more area.                          |
| `--R-phys`                                            | 2400              | Physical resolution for deconvolution Gaussians; set to the instrument's measured resolution.                          |
| `--K`                                                 | derived from file | Concentration constant; set from `calibrate` or a standards calibration to fix the absolute scale.                     |
| `--kinetic`                                           | off               | Per-compound rate-constant correction (more accurate absolute concentrations, but diverges from a single-k reference). |
| `--k-anchor`                                          | 2.0               | Rate constant (1e-9 cm³/s) the baseline K assumes; only affects `--kinetic`.                                           |
| `--humidity-correct`                                  | off               | Humidity-normalise near-thermoneutral compounds (HCN, formaldehyde, formic acid…) using the water-cluster ratio.       |
| `--humidity-p`                                        | 1.0               | Humidity exponent, 0 (off) … 1 (equilibrium upper bound). Calibrate from a standard at ≥2 humidities.                  |
| `--humidity-ref`                                      | run median        | Water-cluster ratio to normalise humidity to.                                                                          |
| `--primary-mz`                                        | 21.022            | Reagent-ion normaliser; change for NO⁺/O₂⁺ modes.                                                                      |
| `--molar-volume`                                      | from drift T      | Set 24.465 for the 25 °C ambient µg/m³ convention.                                                                     |
| `--include-cycle-rows`                                | off               | Enable for final Viewer-style exports so every range boundary is reproducible.                                         |
| `--merge-high-gap`                                    | 0 (off)           | Merge consecutive high plateaus across a short unclassified transition; inspect every merge.                           |
| `segments --grad-thr / --min-duration / --high-ratio` | 0.02 / 30 / 3.0   | Loosen/tighten segment detection if plateaus are noisy or missed.                                                      |

## Commands

`inspect` · `peaks` · `segments` · `analyze` (add `--auto-peaks`/`--auto-segments` for a
quick detect-only pass) · `viz` (browser review/tweak app; serves live-saving or exports
standalone HTML with `--html`) · `calibrate` · `compare` · `rates <name|formula|mz>`
(browse the proton-transfer rate-constant table). Run any with `--help`; all discovery
output is JSON (add `--pretty` to indent).

## Out of scope

- **Untargeted formula assignment / isomer identification** — this quantifies a peak
  list _you_ define. For untargeted discovery use `ptairMS` (R) or `PTRwid`; for general
  IONICON file reading in Python, IONICON's own `PyTRMS`.
- **Segment _identities_** — the data shows _when_ samples occurred, never _what_ they
  were. Final exports deliberately use chronological generic labels rather than asking
  the user for identities.
- **The operator's target panel** — `TRACEdata/TraceInfo` is a broad formula library,
  not a record of which channels were selected in a Viewer project.
- **Exact manual windows** — plateau detection can propose stable ranges but cannot
  recover the operator's scientific choice of which samples/backgrounds to export.
