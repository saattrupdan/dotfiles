#!/usr/bin/env python3
"""Offline molecular-formula identification for PTR-MS product ions.

PTR is soft chemical ionisation: a detected ion is almost always the protonated
molecule [M+H]+, so its neutral mass is (m/z - proton). This module enumerates
every chemically plausible neutral formula whose exact mass matches, then ranks
the candidates using three independent lines of evidence:

  1. mass accuracy      - exact-mass error after removing the run's drift;
  2. isotope pattern    - the predicted 13C(M+1) and heteroatom(M+2, e.g. S/Cl)
                          relative intensities vs what is actually measured in the
                          spectrum (this is how near-isobars are told apart -
                          "look at what the compound is made of");
  3. plausibility       - integer DBE >= 0, the nitrogen rule, and Kind-Fiehn
                          element-ratio "golden rules".

No network, no licensed database: the candidate space is generated on the fly.
Human names + measured proton-transfer rate constants are attached from
reference/rate_constants.json when a formula is known; otherwise the formula
stands on its own with an estimated k.
"""
from __future__ import annotations
import math

PROTON = 1.007276

# monoisotopic masses of the most abundant isotope
MONO = {"C": 12.0, "H": 1.0078250319, "N": 14.0030740052, "O": 15.9949146221,
        "S": 31.97207069, "P": 30.97376151, "F": 18.99840322,
        "Cl": 34.96885271, "Br": 78.9183376}
VALENCE = {"C": 4, "H": 1, "N": 3, "O": 2, "S": 2, "P": 3,
           "F": 1, "Cl": 1, "Br": 1}
# isotopes as {element: [(nucleon_shift, abundance), ...]} (truncated to +2)
ISO = {
    "C":  [(0, 0.9893), (1, 0.0107)],
    "H":  [(0, 0.999885), (1, 0.000115)],
    "N":  [(0, 0.99636), (1, 0.00364)],
    "O":  [(0, 0.99757), (1, 0.00038), (2, 0.00205)],
    "S":  [(0, 0.9499), (1, 0.0075), (2, 0.0425)],
    "P":  [(0, 1.0)],
    "F":  [(0, 1.0)],
    "Cl": [(0, 0.7576), (2, 0.2424)],
    "Br": [(0, 0.5069), (2, 0.4931)],
}
# 13C-12C spacing; M+2 contributors (34S/37Cl/18O/2x13C) cluster near +2.004
DM1 = 1.003355
DM2 = 2.005

# default element bounds for breath / ambient VOCs (halogens allowed but rare)
DEFAULT_BOUNDS = {"C": 40, "N": 8, "O": 20, "S": 4, "P": 2,
                  "Cl": 4, "Br": 2, "F": 6}


def formula_mass(counts):
    return sum(MONO[e] * n for e, n in counts.items())


def formula_str(counts):
    """Hill notation: C, H, then the rest alphabetically."""
    out = ""
    for e in ("C", "H"):
        n = counts.get(e, 0)
        if n:
            out += e + (str(n) if n > 1 else "")
    for e in sorted(k for k in counts if k not in ("C", "H")):
        n = counts[e]
        if n:
            out += e + (str(n) if n > 1 else "")
    return out or "?"


def dbe(counts):
    """Rings + double-bond equivalents of the neutral formula."""
    c = counts.get("C", 0); n = counts.get("N", 0); p = counts.get("P", 0)
    h = counts.get("H", 0)
    x = counts.get("F", 0) + counts.get("Cl", 0) + counts.get("Br", 0)
    return 1 + c + (n + p) / 2.0 - (h + x) / 2.0


def _plausible(counts):
    """Hard sanity gate: only physical limits (integer DBE>=0, which already
    bounds H via valence) plus loose extremes. Small VOCs (methanol H/C=4, formic
    acid O/C=2) must survive, so the typical Kind-Fiehn ranges live in _prior, not
    here."""
    c = counts.get("C", 0); h = counts.get("H", 0)
    d = dbe(counts)
    if d < -0.0001 or abs(d - round(d)) > 1e-6:   # integer, non-negative DBE
        return False
    if c == 0:                                     # tiny inorganics (NH3, ...)
        return (h + counts.get("N", 0) + counts.get("O", 0)) > 0 and d <= 1
    hc = h / c
    if hc < 0.05 or hc > 6.0:                       # absurd only
        return False
    if counts.get("N", 0) / c > 4 or counts.get("O", 0) / c > 3 \
       or counts.get("S", 0) / c > 2:
        return False
    if d > c + 2:
        return False
    return True


def _prior(counts):
    """Soft prior in (0,1]: encode the typical-VOC preferences (Kind-Fiehn element
    ratios, few heteroatoms, modest unsaturation). Only breaks near-ties — the
    mass and isotope evidence dominate."""
    p = 1.0
    c = counts.get("C", 0)
    if c > 0:
        hc = counts.get("H", 0) / c
        if hc > 3.1:
            p *= 0.6 ** (hc - 3.1)
        elif hc < 0.4:
            p *= 0.6 ** (0.4 - hc)
        oc = counts.get("O", 0) / c
        if oc > 1.2:
            p *= 0.7 ** (oc - 1.2)
        nc = counts.get("N", 0) / c
        if nc > 1.0:
            p *= 0.7 ** (nc - 1.0)
    het = counts.get("S", 0) + counts.get("P", 0) + counts.get("Cl", 0) \
        + counts.get("Br", 0) + counts.get("F", 0)
    p *= 0.72 ** het                       # each rare heteroatom costs a bit
    p *= 0.85 ** counts.get("N", 0)        # N less common than O in VOCs
    d = dbe(counts)
    if d > 6:
        p *= 0.9 ** (d - 6)
    return p


def enumerate_formulas(neutral_mass, tol_da, elements=None, bounds=None):
    """All neutral formulas within +-tol_da of neutral_mass passing _plausible().

    H is solved from the mass residual (not looped); the heavy elements are
    enumerated with mass pruning so this stays fast (a few ms per peak)."""
    bounds = dict(DEFAULT_BOUNDS if bounds is None else bounds)
    elements = elements or ["C", "N", "O", "S", "P", "Cl", "Br", "F"]
    mH = MONO["H"]
    hi = neutral_mass + tol_da
    out = []

    def rec(i, counts, mass_so_far):
        if mass_so_far > hi + mH:            # even one more atom overshoots
            return
        if i == len(elements):
            resid = neutral_mass - mass_so_far
            nH = int(round(resid / mH))
            if nH < 0:
                return
            c = dict(counts); c["H"] = nH
            m = mass_so_far + nH * mH
            if abs(m - neutral_mass) <= tol_da and _plausible(c):
                out.append((c, m))
            return
        el = elements[i]
        emass = MONO[el]
        nmax = min(bounds.get(el, 0), int((hi - mass_so_far) / emass))
        for n in range(0, nmax + 1):
            if n:
                counts[el] = n
            elif el in counts:
                del counts[el]
            rec(i + 1, counts, mass_so_far + n * emass)
        counts.pop(el, None)

    rec(0, {}, 0.0)
    return out


def _elem_pattern(shift_ab, n):
    """Truncated (to +2) isotope distribution of n identical atoms."""
    p0 = dict(shift_ab).get(0, 0.0)
    p1 = dict(shift_ab).get(1, 0.0)
    p2 = dict(shift_ab).get(2, 0.0)
    if n == 0 or p0 == 0:
        return [1.0, 0.0, 0.0]
    P0 = p0 ** n
    P1 = n * p0 ** (n - 1) * p1
    P2 = n * p0 ** (n - 1) * p2 + (n * (n - 1) / 2.0) * p0 ** (n - 2) * p1 ** 2
    return [P0, P1, P2]


def isotope_ratios(counts, protonated=True):
    """Predicted (M+1)/M and (M+2)/M intensity ratios for the [M+H]+ ion."""
    c = dict(counts)
    if protonated:
        c["H"] = c.get("H", 0) + 1          # the extra proton is an H atom
    acc = [1.0, 0.0, 0.0]
    for el, n in c.items():
        d = _elem_pattern(ISO.get(el, [(0, 1.0)]), n)
        acc = [acc[0] * d[0],
               acc[0] * d[1] + acc[1] * d[0],
               acc[0] * d[2] + acc[1] * d[1] + acc[2] * d[0]]
    if acc[0] <= 0:
        return 0.0, 0.0
    return acc[1] / acc[0], acc[2] / acc[0]


# ---- name / rate-constant lookup from the curated table (by formula) ----
_TABLE = None
def _table():
    global _TABLE
    if _TABLE is None:
        import ptrms
        t = ptrms.load_rate_constants() or {}
        by_formula = {}
        for comp in t.get("compounds", []):
            by_formula.setdefault(comp.get("formula", ""), comp)
        _TABLE = by_formula
    return _TABLE


def _known(formula):
    return _table().get(formula)


def _iso_factor(pred, obs, floor, contam):
    """Multiplicative isotope-consistency factor for one channel (M+1 or M+2).

    obs > contam            -> treat as contaminated by a neighbour; no info (1.0)
    obs below pred (deficit)-> strong penalty (formula predicts isotope not seen)
    obs above pred (excess) -> weak penalty (could be minor overlap/noise)
    """
    if obs is None:
        return 1.0
    if obs > contam:
        return 1.0
    s = 0.3 * pred + floor
    d = obs - pred
    return math.exp(-0.5 * (d / s) ** 2) if d < 0 else math.exp(-0.5 * (d / (3 * s)) ** 2)


def score_peak(mz, drift, obs_ratios=None, tol_mDa=12.0, max_candidates=5,
               elements=None):
    """Rank candidate formulas for a detected product ion at m/z.

    drift       : run mass-scale (measured apex / true mass) to undo before matching
    obs_ratios  : (r1_obs, r2_obs) measured (M+1)/M and (M+2)/M, or None
    Returns list of candidate dicts, best first, each with the evidence used.
    """
    neutral = mz / drift - PROTON
    tol = tol_mDa / 1000.0
    cands = enumerate_formulas(neutral, tol, elements=elements)
    if not cands:
        return []
    scored = []
    for counts, m in cands:
        ion_mz = m + PROTON
        delta_mDa = (mz / drift - ion_mz) * 1000.0
        p_mass = math.exp(-0.5 * (delta_mDa / 5.0) ** 2)        # ~5 mDa accuracy
        r1p, r2p = isotope_ratios(counts)
        p_iso = 1.0
        iso_used = False
        if obs_ratios is not None:
            r1o, r2o = obs_ratios
            iso_used = True
            # An isotope peak is a LOWER bound: a neighbouring compound at the next
            # nominal mass leaks into the +1/+2 window (unit resolution), so an
            # observed ratio far ABOVE prediction is contamination (no info), while
            # a deficit (observed BELOW prediction) is real evidence against the
            # formula (e.g. it predicts a sulfur M+2 that simply isn't there).
            p_iso = _iso_factor(r1p, r1o, 0.015, 0.50) * \
                    _iso_factor(r2p, r2o, 0.008, 0.60)
        prior = _prior(counts)
        score = p_mass * p_iso * prior
        known = _known(formula_str(counts))
        scored.append({
            "formula": formula_str(counts),
            "name": known["name"] if known else None,
            "ion_mz": round(ion_mz, 4),
            "delta_mDa": round(delta_mDa, 1),
            "dbe": round(dbe(counts), 1),
            "k": known.get("k") if known else None,
            "k_estimated": (known.get("k_estimated", False) if known else True),
            "flags": known.get("flags", []) if known else [],
            "iso_pred": [round(r1p, 4), round(r2p, 4)],
            "iso_obs": ([round(obs_ratios[0], 4), round(obs_ratios[1], 4)]
                        if obs_ratios is not None else None),
            "iso_used": iso_used,
            "score": score,
        })
    scored.sort(key=lambda c: c["score"], reverse=True)
    top = scored[:max_candidates]
    tot = sum(c["score"] for c in top) or 1.0
    for c in top:
        c["probability"] = round(c["score"] / tot, 3)
        c["score"] = round(c["score"], 4)
    return top
