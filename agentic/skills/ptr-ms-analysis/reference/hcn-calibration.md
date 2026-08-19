# Calibrating HCN (and other humidity-sensitive compounds)

HCN, formaldehyde, H₂S, formic acid and ammonia have proton affinity near water's,
so their PTR-MS sensitivity depends on sample humidity and cannot be predicted from
rate constants (the field consensus: it must be measured per instrument). To get
*absolute* concentrations for these you need a short wet-lab calibration on the
same instrument at the same operating conditions. This note describes that
experiment so it can be run — or so an existing calibration dataset can be
recognised and reused.

## First: check whether it already exists

A usable HCN calibration is a set of PTR-MS runs (`.h5`) that contain m/z 28.018 at
**known** HCN concentrations, taken at the instrument's normal settings (here: drift
80 °C, ~3.2 mbar, E/N ≈ 120 Td). Look for:

- `.h5` files named `cal`, `calibration`, `HCN`, or dated near the sample runs, from
  the same operator/instrument.
- A **certificate** for an HCN gas cylinder or permeation tube (gives the source
  concentration/emission rate).
- A lab logbook entry pairing HCN levels (ppb) with instrument response and, ideally,
  humidity (relative humidity, dew point, or the instrument's m/z 37 / m/z 21 ratio).

If those exist, no new experiment is needed — jump to "Feeding it back in".

## The experiment (if it must be run)

**Goal:** two numbers — HCN's absolute sensitivity, and how that sensitivity changes
with humidity.

**You need**
- A traceable HCN source. Safest/common: an **HCN permeation tube** held at fixed
  temperature (known emission rate) diluted into a known carrier flow → known ppb.
  Alternative: a certified HCN-in-N₂ cylinder with dynamic dilution.
- A humidity generator: zero air/N₂ split between a **dry** line and a **humidified**
  line (bubbler or dew-point generator) with adjustable mixing, so the sample stream
  humidity can be set across the range the real samples span.
- Zero air for blanks/dilution, and a hygrometer (or just record the instrument's
  m/z 37 / m/z 21 water-cluster ratio as the humidity axis).
- ⚠ HCN is acutely toxic — fume hood/scrubbed exhaust, gas detection, trained
  personnel. This is why permeation tubes (tiny, controlled emission) are preferred.

**Procedure**
1. Set the instrument to the exact conditions used for samples (drift T, pressure,
   E/N). Calibration is condition-specific.
2. **Sensitivity:** deliver HCN at 3–4 known concentrations spanning the sample range,
   plus a zero, at one fixed humidity. Response vs concentration → a linear
   calibration; the slope is the sensitivity, the intercept the background.
3. **Humidity dependence:** hold HCN at a fixed known concentration and step the
   humidity across 3–5 levels covering the samples' range (~0.02–0.03 in m/z 37 / m/z 21
   here). Record sensitivity at each. This is the curve that pins the humidity
   correction. (Because the sample runs are isothermal at 80 °C, temperature need not
   be varied; a thermodynamic temperature term is unnecessary — see
   `ionicon-h5-format.md`.)
4. A single dry+humid pair is the bare minimum; 3–5 points make the fit trustworthy.

## Feeding it back in

The experiment yields three things the pipeline consumes:

- **HCN absolute sensitivity** → set HCN's per-compound sensitivity: pass an explicit
  `"k"` for the m/z 28 peak (chosen so the tool reproduces the standard at the
  reference humidity), or `calibrate` against a reference in which HCN is known.
- **Humidity exponent p** → fit sensitivity ∝ (m/z37 / m/z21)^(−p); the resulting
  `p ∈ [0,1]` goes to `--humidity-p`. (p = 1 is the equilibrium upper bound; the
  measured value is usually less.)
- **Reference cluster ratio X_ref** (the humidity the sensitivity is quoted at) →
  `--humidity-ref`.

Then `analyze ... --humidity-correct --humidity-p <p> --humidity-ref <X_ref>` gives
humidity-corrected absolute HCN. Without this calibration the tool still gives sound
*relative* HCN across samples (once `--humidity-correct` puts them on equal-humidity
footing) and reports the humidity swing so the uncertainty is visible.

## Note on the well-behaved VOCs

The same multi-point approach with a standard VOC gas mix (acetone, benzene, toluene,
etc. — commercially available, non-toxic) pins the **global K** for everything else,
independent of the HCN work. That is the more routine calibration and may already
exist in the lab's records.
