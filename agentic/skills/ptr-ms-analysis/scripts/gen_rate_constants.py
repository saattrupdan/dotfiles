#!/usr/bin/env python3
"""Generate reference/rate_constants.json from the bundled PTR Library CSV.

Source: the PTR Library — Pagonis, D., Sekimoto, K. & de Gouw, J. A.,
"A Library of Proton-Transfer Reactions of H3O+ Ions Used for Trace Gas
Detection", J. Am. Soc. Mass Spectrom. 2019, 30(7), 1330-1335,
doi.org/10.1007/s13361-019-02209-3 (tinyurl.com/PTRLibrary). The library is a
community compilation; individual rate constants cite their own papers (Zhao &
Zhang 2004; Cappellin 2010/2012; Španěl & Smith; Sekimoto 2017; Koss 2018; …).

We collapse the library's many per-instrument rows to one entry per neutral
molecular formula (PTR cannot separate structural isomers by mass), keeping:
  k         = measured proton-transfer rate constant (median over measured rows,
              in 1e-9 cm3/s); if none measured, the Su-Chesnavich capture value
              kcap (flagged k_estimated) — the standard fallback.
  flags     = 'humid' (proton affinity within ~60 kJ/mol of water -> a fixed k is
              humidity/temperature dependent) and 'frag' (the protonated parent is
              not the main product ion -> fragments).
  isomers   = the distinct compound names the library lists at that formula.
Run:  python scripts/gen_rate_constants.py   (writes reference/rate_constants.json)
"""
import csv
import json
import os
import re
import statistics

import formula_id as F   # MONO, PROTON, formula_str, formula_mass

HERE = os.path.dirname(__file__)
SRC = os.path.join(HERE, "..", "reference", "ptrlibrary.csv")
OUT = os.path.join(HERE, "..", "reference", "rate_constants.json")

PA_WATER = 691.0          # kJ/mol
HUMID_PA_MAX = 750.0      # PA below this -> humidity/temperature-sensitive k


def num(s):
    s = (s or "").strip()
    if not s:
        return None
    try:
        return float(s)
    except ValueError:
        return None


def neutral_counts(comp):
    """Neutral element counts from a 'Parent Ion Composition' like 'C2H6OH+'."""
    comp = comp.strip()
    protonated = comp.endswith("H+")
    body = comp.rstrip("+")
    counts = {}
    for el, n in re.findall(r"([A-Z][a-z]?)(\d*)", body):
        if not el or el not in F.MONO:
            if el:                       # unknown element (isotope label etc.) -> skip compound
                return None
            continue
        counts[el] = counts.get(el, 0) + (int(n) if n else 1)
    if protonated:                        # remove the added proton
        counts["H"] = counts.get("H", 0) - 1
        if counts["H"] <= 0:
            counts.pop("H", None)
    return counts or None


def main():
    with open(SRC, encoding="utf-8") as fh:
        rows = list(csv.reader(fh))
    hdr = rows[2]
    col = {h.strip(): i for i, h in enumerate(hdr)}
    C_MASS = col["Parent Ion Mass"]; C_COMP = col["Parent Ion Composition"]
    C_NAME = col["Compound Name"]; C_CAS = col["CAS number"]
    C_PA = col["Proton Affinity (kJ/mole)"]
    C_KM = col["Rate coefficient, measured, 0 Td, 298 K (cm3/s)"]
    C_KC = col["kcap, 120 Td, 323 K"]; C_CLASS = col["Class"]
    # product-ion m/z columns (A..G) to detect fragmentation
    prod_cols = [col[k] for k in ("m/z A", "m/z B", "m/z C", "m/z D",
                                  "m/z E", "m/z F", "m/z G") if k in col]

    groups = {}
    for r in rows[3:]:
        if len(r) <= C_CLASS:
            continue
        comp = r[C_COMP].strip()
        if not comp or not comp.endswith("+"):
            continue
        counts = neutral_counts(comp)
        if not counts or counts.get("C", 0) + counts.get("N", 0) + \
                counts.get("O", 0) + counts.get("S", 0) == 0 and "H" not in counts:
            continue
        formula = F.formula_str(counts)
        mz = round(F.formula_mass(counts) + F.PROTON, 4)
        parent = num(r[C_MASS])
        name = r[C_NAME].strip()
        km = num(r[C_KM]); kc = num(r[C_KC]); pa = num(r[C_PA])
        # fragmentation: any product ion far from the protonated parent
        frag = False
        if parent is not None:
            for pc in prod_cols:
                pv = num(r[pc]) if pc < len(r) else None
                if pv is not None and abs(pv - parent) > 0.3:
                    frag = True
                    break
        g = groups.setdefault(formula, {
            "formula": formula, "mz": mz, "names": [], "km": [], "kc": [],
            "pa": None, "cas": None, "class": None, "frag_votes": 0, "n": 0})
        g["n"] += 1
        if name and name not in g["names"]:
            g["names"].append(name)
        if km:
            g["km"].append(km)
        if kc:
            g["kc"].append(kc)
        if pa is not None and g["pa"] is None:
            g["pa"] = pa
        if not g["cas"] and r[C_CAS].strip():
            g["cas"] = r[C_CAS].strip()
        if not g["class"] and r[C_CLASS].strip():
            g["class"] = r[C_CLASS].strip()
        if frag:
            g["frag_votes"] += 1

    compounds = []
    for g in groups.values():
        if g["km"]:
            k = round(statistics.median(g["km"]) / 1e-9, 3); est = False; ksrc = "measured"
        elif g["kc"]:
            k = round(statistics.median(g["kc"]) / 1e-9, 3); est = True; ksrc = "kcap"
        else:
            # keep the compound for its NAME/identification value even with no k;
            # no made-up rate constant (kinetic correction just won't apply)
            k = None; est = True; ksrc = "none"
        flags = []
        if g["pa"] is not None and g["pa"] < HUMID_PA_MAX:
            flags.append("humid")
        if g["frag_votes"] * 2 >= g["n"] and g["frag_votes"] > 0:
            flags.append("frag")
        compounds.append({
            "name": g["names"][0] if g["names"] else g["formula"],
            "formula": g["formula"], "mz": g["mz"], "k": k,
            "k_estimated": est, "k_source": ksrc, "flags": flags,
            "pa": g["pa"], "cas": g["cas"], "class": g["class"],
            "isomers": g["names"],
        })
    # small supplement for VOCs absent from the library but important in breath /
    # plant work, with literature k (cited). Only added if the formula is missing.
    SUPPLEMENT = [
        # sesquiterpenes fragment heavily in PTR; k from Kim et al., Atmos. Environ.
        # 43, 2009 (~2.3e-9). Representative name beta-caryophyllene.
        {"name": "sesquiterpenes", "formula": "C15H24", "k": 2.3,
         "k_estimated": False, "k_source": "Kim2009", "flags": ["frag"],
         "pa": None, "cas": None, "class": "terpene",
         "isomers": ["beta-caryophyllene", "sesquiterpenes"]},
    ]
    have = {c["formula"] for c in compounds}
    for s in SUPPLEMENT:
        if s["formula"] not in have:
            s = dict(s); s["mz"] = round(
                F.formula_mass({m[0]: int(m[1] or 1) for m in
                                re.findall(r"([A-Z][a-z]?)(\d*)", s["formula"])})
                + F.PROTON, 4)
            compounds.append(s)

    compounds.sort(key=lambda c: c["mz"])

    doc = {
        "_source": "PTR Library (Pagonis, Sekimoto & de Gouw, J. Am. Soc. Mass "
                   "Spectrom. 2019, doi.org/10.1007/s13361-019-02209-3; "
                   "tinyurl.com/PTRLibrary). One entry per neutral formula; k in "
                   "1e-9 cm3/s (measured median, else Su-Chesnavich kcap flagged "
                   "k_estimated). Regenerate with scripts/gen_rate_constants.py.",
        "compounds": compounds,
    }
    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, indent=1)
    n_meas = sum(1 for c in compounds if not c["k_estimated"])
    print(f"wrote {len(compounds)} compounds ({n_meas} with measured k, "
          f"{len(compounds) - n_meas} capture-theory) to {OUT}")


if __name__ == "__main__":
    main()
