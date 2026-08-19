# ptr-ms-analysis

Open-source reprocessor for IONICON IoniTOF PTR-MS / PTR-TOF `.h5` files — a
replacement for the proprietary PTR-MS Viewer. Extracts product-ion peaks from the
raw mass spectra, transmission-corrects them, converts to concentration (ppb and
µg/m³), and summarises per time segment.

**Agent-driven by design.** The CLI does the deterministic physics and detects
candidate peaks (with compound assignments + artifact flags) and time segments; an
agent assigns chemistry and curates segments. Humans talk to the agent, not to this
CLI. See `SKILL.md` for the agent workflow.

## Install / run

Two ways to run it:

**Zero-install launcher** — nothing to install by hand. The `bin/ptr` launcher creates and
caches its own Python environment (h5py + numpy) on first use — via `uv` if present, else
`python3 -m venv`. First call ~30 s (logged to stderr); later calls are instant.

```bash
bin/ptr inspect FILE.h5
```

**As an installed CLI** — it's a proper package (`pyproject.toml`), so you can put `ptr` on
your PATH. Recommended via `pipx` (isolated env):

```bash
pipx install .          # from this directory -> `ptr` command on PATH
# or:  pip install .    # into a venv
ptr inspect FILE.h5
```

Not yet on PyPI — install from a checkout of this directory. Requires Python ≥ 3.9;
`h5py`/`numpy` are pulled in automatically.

## Commands (all discovery output is JSON)

```bash
PTR=bin/ptr        # the launcher; manages its own env, run from any directory

$PTR inspect  FILE.h5                       # metadata, calibration, concentration-K, Vm
$PTR peaks    FILE.h5                       # peaks + scored formula candidates (isotope-disambiguated)
$PTR segments FILE.h5                       # stable plateaus (high=sample / low=bg)
# agent curates peaks + ranges into cfg.json, then:
$PTR viz      FILE.h5 --config cfg.json --out results.csv   # serve review; 'Done' -> writes CSV
$PTR viz      FILE.h5 --config cfg.json --html review.html   # portable standalone HTML instead
$PTR analyze  FILE.h5 \                     # no review: curated config -> Viewer-style CSV
     --config cfg.json --include-cycle-rows --out results.csv
$PTR analyze  FILE.h5 --auto-peaks --auto-segments --out results.csv   # quick detect-only fallback
$PTR calibrate FILE.h5 viewer.csv          # fit concentration constant K -> pass via --K
$PTR compare   results.csv viewer.csv --per-mass   # accuracy vs a Viewer export
$PTR rates     benzaldehyde                # browse proton-transfer rate constants (k)
```

`viz` opens a browser review app for an existing peak list + ranges so an expert can
visually check and tweak peaks / segments / calibration with Raw/Corrected/Conc
recomputing live. **It is the default final step** for analysing a file: the agent curates
a config from `peaks`/`segments` first, then opens `viz` on that best solution — ideally
nothing needs changing and *Done* is a one-click confirmation. By default it serves a
localhost app that live-saves every edit into the `--config` file and, when the expert
clicks *Done*, runs the full-precision analysis and writes the `--out` CSV; `--html
review.html` writes a portable offline file instead (edits exported via a Download button).
A first-time user gets an automatic guided tour of the interface (skippable, remembered in
the browser). The agent can also add a `"checklist"` array to the config — short points for
the reviewer to confirm (an ambiguous segment, a relabelled background channel, a
calibration caveat) — which the app shows as a tickable list, so review notes live in the
app instead of a wall of chat text. `viz` does not detect peaks/segments. Skip it and run `analyze` directly only for a
headless/no-browser run or a hand-off file. There is no one-shot command; the delivered
CSV always comes from `analyze`, never the browser.

By default `analyze` integrates each interval with each isolated peak's apex/window
**re-centred on that interval's own spectrum** — peaks drift between intervals (mass-cal
drift; a compound may be absent in a background), so one whole-run window sits off-peak
elsewhere. The delivered CSV is unchanged in shape (still one row per compound × interval);
only each row's numbers reflect its interval's real peak. Pass `--no-per-interval` for one
whole-run window per compound. Absent-compound intervals and hand-placed/clustered windows
keep the whole-run placement.

Add `--pretty` to any command for indented JSON. `analyze` fallbacks: `--auto-peaks`,
`--auto-segments` (generic labels), or `--config file.json`. `--K` / `--molar-volume`
override the file-derived calibration to match a specific Viewer project. `--kinetic`
applies per-compound rate-constant (k) sensitivities (from
`reference/rate_constants.json`, 218 compounds from the PTR Library) for physically resolved absolute
concentrations. Low-proton-affinity compounds (HCN, formaldehyde, formic acid…) are
auto-flagged: `analyze` always reports a humidity diagnostic for them, and
`--humidity-correct` (with a calibrated `--humidity-p`) normalises the humidity swing.

## How it works

Everything instrument-specific (mass calibration, transmission, concentration constant
K, molar volume from drift temperature) is read from the `.h5`. Isolated peaks use an
apex-centred resolution window; overlapping peaks are separated by linear Gaussian
deconvolution. Time segments are found by log-space plateau detection on a composite VOC
signal. Compound identification (`scripts/formula_id.py`) enumerates candidate molecular
formulas offline (no external database) and ranks them by exact-mass error, the measured
vs predicted ¹³C(M+1)/heteroatom(M+2, e.g. S/Cl) isotope pattern, and plausibility
(integer DBE, nitrogen rule, element ratios) — so near-isobars are told apart by
composition, not "nearest mass". Names and proton-transfer rate constants come from
`reference/rate_constants.json` when the formula is known — 218 compounds compiled
from the **PTR Library** (Pagonis, Sekimoto & de Gouw, *J. Am. Soc. Mass Spectrom.*
2019, doi.org/10.1007/s13361-019-02209-3; tinyurl.com/PTRLibrary), one entry per
neutral formula with measured k where available (else Su-Chesnavich capture-theory
k, flagged `k_estimated`), plus proton affinity, isomer names, and fragmentation
flags. Regenerate from `reference/ptrlibrary.csv` with `scripts/gen_rate_constants.py`.
Details:
`reference/ionicon-h5-format.md`; compound assignment help: `reference/ptr-ms-chemistry.md`;
HCN/humidity calibration: `reference/hcn-calibration.md`.

## Accuracy

Median error vs PTR-MS Viewer on two reference exports — breath (396 points, default K):
Raw 2.4 %, Corrected 5.0 %, Conc 3.1 %, Conc[µg] 3.2 %; bitter-almonds (16 points,
calibrated K): Raw 0.7 %, Corrected 3.1 %, Conc 2.6 %, Conc[µg] 2.5 %.

Concentration carries one calibration constant K not uniquely fixed by the raw file (a
Viewer project uses its own sensitivity). Default K is the file's own acquisition
calibration; run `calibrate FILE.h5 reference.csv` and pass `--K` to match a specific
Viewer project exactly. Raw and Corrected are file-derived and robust.
