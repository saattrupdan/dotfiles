# Assigning compounds to PTR-MS m/z peaks

Guidance for turning a detected-peak list into labelled target ions. This is a
starting reference — apply your own chemistry judgement to the specific dataset
(instrument mode, sample type, mass accuracy). PTR-MS cannot distinguish isomers,
so a formula often maps to several possible compounds; label with the family or
the most likely compound for the sample context, and say so.

## Ionisation basics (H₃O⁺ mode)

- The detected ion is the **protonated molecule [M+H]⁺**, so
  **neutral monoisotopic mass ≈ detected m/z − 1.00728**.
- Some species fragment (e.g. alcohols lose water → [M+H−H₂O]⁺) or appear as
  water clusters [M+H+H₂O]⁺. Expect the main protonated peak plus minor
  fragment/cluster peaks.
- Assign from the exact detected m/z (the `peaks` command already includes the
  run's calibration drift), not the textbook value.

## Reagent / instrument ions — quantify separately or skip

These are not analytes; they are the chemistry of the source. Skip them as VOCs
(but m/z 21 is the key primary-ion normaliser used internally).

| m/z | Ion | Note |
|---|---|---|
| 19.018 | H₃O⁺ | primary ion (usually off-scale) |
| 21.022 | H₃¹⁸O⁺ | primary-ion isotope, ×500 → total H₃O⁺ |
| 37.028 | H₃O⁺·H₂O | first water cluster |
| 55.039 | H₃O⁺·(H₂O)₂ | second water cluster |
| 32 / 30 / 48 | O₂⁺ / NO⁺ / O₂⁺·? | present if in NO⁺/O₂⁺ mode or from impurities |

## Common breath / ambient VOCs (H₃O⁺ mode)

| m/z [M+H]⁺ | Formula (neutral) | Likely compound(s) |
|---|---|---|
| 33.033 | CH₄O | methanol |
| 42.034 | C₂H₃N | acetonitrile |
| 45.033 | C₂H₄O | acetaldehyde |
| 47.049 | C₂H₆O | ethanol |
| 59.049 | C₃H₆O | acetone / propanal |
| 61.028 | C₂H₄O₂ | acetic acid |
| 63.026 | C₂H₆S | dimethyl sulfide (DMS) |
| 69.070 | C₅H₈ | isoprene |
| 71.049 | C₄H₆O | methyl vinyl ketone / methacrolein |
| 73.065 | C₄H₈O | butanone (MEK) |
| 79.054 | C₆H₆ | benzene |
| 87.044 | C₄H₆O₂ | 2,3-butanedione (diacetyl) |
| 93.070 | C₇H₈ | toluene |
| 99.080 | C₆H₁₀O | hexenal / cyclohexanone |
| 107.086 | C₈H₁₀ | xylenes / ethylbenzene |
| 137.132 | C₁₀H₁₆ | monoterpenes (limonene, α-pinene, …) |

Breath markers to expect prominently: **acetone (59)** — usually the largest VOC;
**isoprene (69)**; **methanol (33)**; **acetaldehyde (45)**; **ethanol (47)**.
These make excellent segment discriminators (high during breath, low in
background).

## Distinguishing close peaks

At unit mass, several formulas can appear (e.g. m/z 43: C₃H₇⁺ fragment vs
C₂H₃O⁺). High-resolution PTR-TOF separates them by exact mass; the deconvolution
in this skill will resolve peaks down to ~Δm/z 0.03 if you list both. If two
formulas are within the resolution and you only care about one, list just that
one and widen inspection of the residual.

## Per-compound sensitivity: proton-transfer rate constants (k)

Concentration sensitivity scales with each compound's **proton-transfer rate
constant k** (`Conc ∝ 1/k`). The default (single-K) model assumes one k for every
compound; the `--kinetic` mode instead scales each compound by its own k, which is
physically more accurate (a compound with k=4 vs the assumed k=2 is otherwise
reported at ~2× its true concentration).

A rate-constant database ships as `reference/rate_constants.json` (71 compounds,
k in 1e-9 cm³/s, from Zhao & Zhang 2004; Cappellin 2012; Sekimoto 2017; de Gouw &
Warneke 2007). Query it with `analyze.py rates <name|formula|mz>`. Values carry
~20–50 % uncertainty and set *relative* sensitivities — they refine, but do not
replace, calibration with real standards.

Two flags in the table matter:

- **`frag`** — the compound fragments off its parent m/z (most alcohols, larger
  aldehydes, terpenes, acids), so its *effective* sensitivity is lower than k
  alone predicts. k gets you the ionisation rate, not the surviving-parent
  fraction.
- **`humid`** — proton affinity near water's (HCN, formaldehyde, H₂S, formic acid,
  ammonia). Proton transfer is partly reversible, so sensitivity depends strongly
  on sample **humidity and temperature**; a fixed k is unreliable.

### Humidity correction for `humid` compounds

Whenever a `humid` compound is present, `analyze` reports a humidity diagnostic:
the per-range **water-cluster ratio** X = I(m/z 37) / I(m/z 21) and its
cross-range spread. (The textbook proxy is m/z 37 / m/z 19, but m/z 19 is normally
saturated/blanked, so m/z 21 — the H₃¹⁸O⁺ isotope — is used; a constant isotope
factor cancels once X is normalised to a reference.) A large spread means the
compound's sensitivity differed between samples, so relative comparisons are
confounded.

`analyze --humidity-correct` multiplies each `humid` compound's per-cycle
concentration by `(X / X_ref)^p`:
- **p = 0** — no correction (kinetic limit; sensitivity humidity-independent).
- **p = 1** — full equilibrium limit (sensitivity ∝ 1/[H₂O]); the physical upper
  bound on the correction.
- The true p is in between and instrument/E-N specific. **Calibrate it** by
  measuring one standard at ≥2 humidities and fitting p so the reported
  concentration is humidity-flat. Uncalibrated, the correction only makes
  *relative* comparisons across differing humidity valid; absolute values still
  need a standard. For a rigorous HCN treatment see Knighton et al. 2009, which
  adds a thermodynamic temperature/pressure term on top of the cluster ratio.

How k is resolved per peak (in `--kinetic` mode), in priority order:
1. an explicit `"k"` on the peak (your value, in 1e-9 or SI units);
2. an exact `"formula"` match in the table;
3. a unique m/z match. Isomers share m/z (e.g. acetone vs propanal at 59.049),
   so pass the `formula` to disambiguate, or an explicit `k`.

## When unsure

- Report the m/z and neutral mass and offer the candidate formula(s) rather than
  guessing a single compound.
- Cross-check against the sample context (breath vs ambient vs headspace).
- Flag peaks the tool marks in `apex_warnings` (possible overlap/misassignment).
- In `--kinetic` mode, check the `no_k` list (peaks with no rate constant, left on
  the anchor k) and the `humidity_warning`.
