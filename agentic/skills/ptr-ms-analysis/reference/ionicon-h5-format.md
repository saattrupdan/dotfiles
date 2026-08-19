# IONICON IoniTOF HDF5 format & the PTR-MS Viewer algorithm

Reverse-engineered from an IoniTOF PTR-MS breath run and its PTR-MS Viewer CSV
export. This documents the file layout, the calibration data, and the exact
Raw → Corrected → Concentration chain the pipeline reproduces.

## File layout

Root attributes hold instrument/run metadata: `Single Spec Duration (ms)`
(cycle length), `Timebin width (ps)`, `Pulsing Period (ns)`, `FileCreatedTime*`,
`InstrumentType = IoniTof`, drift settings, etc.

| Path | Shape | Meaning |
|---|---|---|
| `SPECdata/Intensities` | (n_cyc, n_bins) | **Raw mass spectra**, one row per cycle, columns = TOF timebins (cps). The bulk of the file (~1 GB, gzip, chunked one-row-per-chunk). |
| `SPECdata/AverageSpec` | (n_bins,) | Run-average spectrum — used for peak detection / apex finding. |
| `SPECdata/Times` | (n_cyc, 4) | col 0 = 1-based cycle index; col 2 = acquisition time (IONICON epoch). |
| `SPECdata/PCTime` | (n_cyc, 1) | PC Unix timestamp per cycle. |
| `CALdata/Mapping` | (2, 2) | Two `(m/z, timebin)` anchor points → mass calibration. |
| `TRACEdata/TraceRaw` | (n_cyc, n_pk) | Acquisition-time pre-computed peak traces (raw cps). |
| `TRACEdata/TraceCorrected` | (n_cyc, n_pk) | Pre-computed transmission-corrected traces. |
| `TRACEdata/TraceConcentration` | (n_cyc, n_pk) | Pre-computed concentration traces (ppb). |
| `TRACEdata/TraceInfo` | (8, n_pk) | Per-trace metadata: row1 = label, row2 = centre m/z, rows3–4 = m/z window. |
| `PTR-Transmission/Masses_Factors` | (5,2,21) | `[0,0,:]` = m/z nodes, `[0,1,:]` = relative transmission factors. |
| `PTR-PrimaryIons/*` | | Primary-ion definitions (H3O⁺ monitored via the m21 H₃¹⁸O⁺ isotope ×500, etc.). |
| `AddTraces/PTR-Reaction/Data` | (n_cyc, 6) | Per-cycle drift params: `Udrift`, `p_drift`, `T-Drift_Act`, `E/N`, primary-ion index. Column names in the sibling `Info` dataset. |
| `AddTraces/DataCollection/Data` | (n_cyc, 5) | Per-cycle `ACQ_SRV_MassCal_a/b` and spec timing. |
| `AddTraces/PTR-Instrument/Data` | (n_cyc, 75) | Full instrument telemetry (voltages, temperatures, flows, turbos). |

## Key finding: Viewer re-processes from raw spectra

The PTR-MS Viewer CSV values are **not** copies of the pre-computed `TRACEdata`.
Viewer re-integrates the raw `SPECdata/Intensities` with its own peak list and
calibration. Evidence: the CSV's exact max values never appear in any `TRACEdata`
array, and the CSV mass labels (theoretical masses) don't match the file's
built-in trace centres. So faithful reproduction must start from the raw spectra.

## Mass calibration

TOF relation is `timebin = a·√(m/z) + b`. Solve `a, b` from the two
`CALdata/Mapping` anchors:

```
a = (tb2 − tb1) / (√m2 − √m1)
b = tb1 − a·√m1
m/z = ((timebin − b) / a)²
```

**Drift caveat:** a global 2-point calibration drifts over a long run; measured
peak apexes sit ~0.0007·m above the nominal masses. The pipeline corrects this
with a robust global mass-scale factor (median apex/nominal over all target
peaks) and then apex-snaps each isolated peak. Per-cycle `MassCal_a/b` exist in
`AddTraces/DataCollection` but barely differ from the global fit here.

## The four quantities

### 1. Raw [cps]
Sum of `Intensities` over the peak's m/z window. Window is apex-centred with a
resolution-based half-width `hw = m / (2·R)`, R ≈ 1200 (≈ ±1 FWHM; the physical
resolution is R ≈ 2400, so this captures ~95 % of a Gaussian peak). Reproduces
isolated CSV peaks to <2 %.

### 2. Corrected
`Corrected = Raw / Transmission(m/z)`, transmission linearly interpolated (and
end-clamped) from the `PTR-Transmission` curve. Verified against the file's own
pre-computed traces: `TraceCorrected/TraceRaw` exactly equals `1/T(m)` with this
curve. Viewer uses a slightly different transmission curve (its own project
setting), giving a ~3–5 % systematic offset.

### 3. Concentration [ppb]
Standard primary-ion-normalised model: **`Conc = Corrected × K / I_primary(t)`**,
where `I_primary(t)` is the per-cycle reagent-ion signal (H₃O⁺ monitored via its
H₃¹⁸O⁺ isotope at m/z ≈ 21, since m/z 19 saturates) and `K` is a single
calibration constant. Dividing by `I_primary(t)` tracks reagent-ion drift over the
run. Verified: on the reference exports, `ref_sensitivity(t) × I_primary(t)` is
constant per experiment (K ≈ 18.3 and 16.6 on the two files) even though the
sensitivity itself drifts ~15 % over each run.

**K is the one irreducible calibration constant** and is *not* uniquely fixed by
the raw file — a specific PTR-MS Viewer project uses its own sensitivity setting
(K differed by ~15 % between the two experiments). Defaults:
- Default `K` is derived from the file's own pre-computed concentration
  (`K = median_t[(TraceConc/TraceCorrected)(t) × I_primary(t)]`), reproducing the
  *acquisition* calibration.
- `calibrate` fits `K` against a reference CSV
  (`K = median[ref_conc × I_primary / Corrected]`), matching a Viewer project to
  ≈ 3 %.
Raw and Corrected do not depend on K.

### 4. Concentration [µg/m³]
`Conc_µg = Conc_ppb × M_neutral / Vₘ`, where `M_neutral = m_ion − m_proton`
(1.007276) and `Vₘ` is the molar volume at the drift/inlet temperature:
`Vₘ = 22.414 · (T_drift[K] / 273.15)` ≈ 28.9 L/mol at 80 °C. Verified: the
CSV's µg/ppb ratio equals `M_neutral/28.90` across all masses to <0.1 %.

## Overlapping peaks (isobaric interference)

The central difficulty of PTR-TOF. A window wide enough for accurate area on
isolated peaks reaches into neighbours < ~0.05 m/z away. The pipeline groups
peaks within `cluster_gap` (0.2 m/z) and separates them by **vectorised linear
least-squares Gaussian unmixing**: build unit-Gaussian basis functions at each
(scale-corrected) centre with σ from `R_phys`, solve `A = Y·G(GᵀG)⁻¹` for all
cycles at once, clip negatives, and rescale each amplitude to the window-sum
definition so isolated and deconvolved peaks share one Raw scale. This turns
100 %+ errors on close pairs (m43.020/m43.052, m47.013/m47.049,
m57.035/m57.071) into 1–4 %.

## What is NOT in the raw file (must be supplied)

- **The target peak list** — which compounds to quantify.
- **The time ranges** — which cycle windows are which sample. (Here they were
  recovered from the CSV's own `Cycle` variable rows; in general they are the
  operator's annotations.)
- **Viewer's exact transmission curve and sensitivity constant** — its private
  calibration. The file's own values are used as a physically valid default.

## Open-source ecosystem

| Tool | Lang | Notes |
|---|---|---|
| **PyTRMS** (ionicon-analytik) | Python | Reads IONICON `.h5`, traces → pandas. Vendor library. |
| **ptairMS** | R/Bioconductor | Purpose-built for exhaled-breath PTR-TOF biomarker discovery; raw `.h5` → peak tables. |
| **PTRwid** | IGOR Pro | Untargeted peak detection, internal m/z calibration, deconvolution (Tofwerk instruments). |
| **PeakCalc** | — | Normalised peak areas for PTR-TOF. |
| Ionicon Data Analyzer / Tofware | commercial | Full HR peak fitting. |
