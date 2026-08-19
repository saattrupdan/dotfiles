#!/usr/bin/env python3
"""PTR-MS analysis CLI — open-source reprocessor for IONICON IoniTOF HDF5 files.

Designed to be driven by an agent, not a human. Install once with
`pipx install --editable <SKILL_DIR>` and invoke as `ptr <subcommand>` — do not
read this source; every operation is a subcommand and every value is in its JSON
output.

Commands (all discovery output is JSON on stdout):
  inspect    File metadata, calibration, transmission, concentration-K, molar volume.
  peaks      Peak detection -> {mz, height, neutral_mass, suggested_label,
             top_candidate, [likely_artifact]} (compact; --full for all candidates).
  segments   Time-segment detection -> stable plateaus (samples vs background).
  analyze    Full pipeline (from a config) -> PTR-MS-Viewer-style results CSV.
  viz        Review app for an existing peak list + ranges (live-save to a config
             with --serve, or a standalone HTML with --out). Does NOT detect.
  calibrate  Fit the concentration constant K to a reference Viewer CSV.
  compare    Error stats of a results CSV vs a reference Viewer CSV.
  rates      Browse the bundled proton-transfer rate-constant table.

There is deliberately NO one-shot command. The agent detects with `peaks`/`segments`,
applies its own chemistry + curation judgment, writes a config, and only then reviews or
analyses it — so `viz`/`analyze` always operate on the best solution, not a mechanical guess.

Flows:
  primary — agent curates, then an expert confirms in the browser:
    1. ptr peaks FILE        -> pick assignments from each peak's `candidates`
    2. ptr segments FILE     -> sample_01/background_01 ranges; never ask names
    3. write analysis-config.json (the curated peaks + ranges)
    4. ptr viz FILE --config analysis-config.json --out results.csv
       (serves the browser app; clicking 'Done' writes results.csv itself)
  no review (the same curated config, straight to CSV):
       ptr analyze FILE --config analysis-config.json --include-cycle-rows --out results.csv
  quick deterministic fallback (no agent judgment, no browser — detect + quantify only):
       ptr analyze FILE --auto-peaks --auto-segments --include-cycle-rows --out results.csv
"""
from __future__ import annotations
import argparse
import csv
import json
import os
import sys
import numpy as np
import h5py

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ptrms  # noqa: E402
import formula_id  # noqa: E402


def _emit(obj, raw=True):
    json.dump(obj, sys.stdout, indent=None if raw else 2)
    sys.stdout.write("\n")


def detect_peaks(f, min_rel_height=1e-3, max_peaks=300, mz_min=15.0, mz_max=None,
                 R_phys=2400.0):
    """Untargeted peak detection on the average spectrum.

    Local maxima above a relative-height threshold, then merged if closer than one
    peak half-width (so a flat-topped peak flagged on adjacent timebins collapses
    to a single entry, keeping the tallest)."""
    a, b = ptrms.load_mass_cal(f)
    avg = f["SPECdata/AverageSpec"][:]
    thr = avg.max() * min_rel_height
    hi = (avg[1:-1] > avg[:-2]) & (avg[1:-1] >= avg[2:]) & (avg[1:-1] > thr)
    idx = np.where(hi)[0] + 1
    mz = ptrms.tb_to_m(idx, a, b)
    keep = mz >= mz_min
    if mz_max:
        keep &= mz <= mz_max
    idx, mz = idx[keep], mz[keep]
    # merge maxima within one half-width (m/(2*R_phys)), keeping the tallest
    order_m = np.argsort(mz)
    idx, mz = idx[order_m], mz[order_m]
    merged = []  # (mz, height)
    for k in range(len(mz)):
        h = float(avg[idx[k]])
        if merged and mz[k] - merged[-1][0] < mz[k] / (2 * R_phys):
            if h > merged[-1][1]:
                merged[-1] = (float(mz[k]), h)
        else:
            merged.append((float(mz[k]), h))
    merged.sort(key=lambda t: t[1], reverse=True)
    merged = merged[:max_peaks]
    peaks = [{"mz": round(m, 4), "height": round(h, 1),
              "rel_height": round(h / float(avg.max()), 5)} for m, h in merged]
    peaks.sort(key=lambda p: p["mz"])
    return peaks


# ----------------------------- commands -----------------------------
def cmd_inspect(args):
    with h5py.File(args.h5, "r") as f:
        a, b = ptrms.load_mass_cal(f)
        tm, tf = ptrms.load_transmission(f)
        ncyc = int(f["SPECdata/Intensities"].shape[0])
        dur = ptrms.spec_duration_s(f)
        created = ""
        try:
            created = f.attrs["FileCreatedTimeSTR_LOCAL"][0].decode("latin-1")
        except Exception:
            pass
        _emit({
            "file": args.h5,
            "instrument": _attr(f, "InstrumentType"),
            "created_local": created,
            "n_cycles": ncyc,
            "cycle_duration_s": dur,
            "duration_min": round(ncyc * dur / 60, 1),
            "n_spectrum_bins": int(f["SPECdata/Intensities"].shape[1]),
            "mass_cal": {"model": "timebin = a*sqrt(mz) + b", "a": a, "b": b},
            "transmission_masses": [round(x, 3) for x in tm.tolist()],
            "transmission_factors": [round(x, 4) for x in tf.tolist()],
            "concentration_K_from_file": ptrms.derive_K(
                f, ptrms.extract_primary(f)),
            "molar_volume_L_per_mol": round(ptrms.derive_molar_volume(f), 3),
            "has_precomputed_traces": "TRACEdata/TraceConcentration" in f,
        }, args.raw)


def _attr(f, key):
    try:
        v = f.attrs[key]
        v = v[0] if hasattr(v, "__len__") and not isinstance(v, (bytes, str)) else v
        return v.decode("latin-1") if isinstance(v, bytes) else v
    except Exception:
        return None


_REAGENT_MZ = {19.018: "H3O+ primary", 21.022: "H3O+ (18O) isotope",
               37.028: "H3O+·H2O cluster", 55.039: "H3O+·(H2O)2 cluster",
               73.049: "H3O+·(H2O)3 cluster", 31.989: "O2+", 32.997: "O2+ (17O)",
               33.994: "O2+ (18O)", 29.997: "NO+", 30.994: "O2+/NO+ region"}


def annotate_peaks(peaks, avgspec=None, a=None, b=None, R=1200.0, elements=None):
    """Enrich detected peaks with candidate FORMULA assignments (scored by mass +
    isotope pattern + plausibility) and artifact flags, so the agent/expert can
    pick assignments without scripting mass-matching.

    Candidates come from offline formula enumeration (`formula_id`), not a fixed
    short list, so near-isobars are disambiguated by their measured 13C(M+1) and
    heteroatom(M+2, e.g. S/Cl) isotope ratios rather than by "nearest mass". When
    `avgspec`+`a`+`b` are supplied the isotope ratios are measured from the average
    spectrum; without them the ranking falls back to mass + plausibility only.

    Returns (drift, annotated_peaks). `drift` is the run's global mass scale
    (measured apex / true m/z ≈ 1.0008); each candidate's `delta_mDa` is the exact
    -mass residual after removing that drift, plus predicted/observed isotope
    ratios and a normalised `probability`."""
    tbl = ptrms.load_rate_constants()
    comps = tbl["compounds"] if tbl else []
    ratios = []
    for p in peaks:
        near = [c for c in comps if abs(c["mz"] - p["mz"]) < 0.08]
        if len(near) == 1:
            ratios.append(p["mz"] / near[0]["mz"])
    drift = float(np.median(ratios)) if ratios else 1.0

    have_spec = avgspec is not None and a is not None and b is not None
    def obs_ratios(mz):
        if not have_spec:
            return None
        def wsum(center):
            wl, wr = ptrms.peak_window(center, a, b, R)
            lo, hi = max(0, wl), min(len(avgspec), wr)
            return float(avgspec[lo:hi].sum()) if hi > lo else 0.0
        i0 = wsum(mz)
        if i0 <= 0:
            return None
        return (wsum(mz + formula_id.DM1) / i0, wsum(mz + formula_id.DM2) / i0)

    all_mz = sorted(q["mz"] for q in peaks)
    def nearest_other(mz):
        best = None
        for x in all_mz:
            if x == mz:
                continue
            if best is None or abs(x - mz) < abs(best - mz):
                best = x
        return best

    out = []
    for p in peaks:
        mz, h = p["mz"], p.get("height", 0.0)
        e = dict(p)
        e["neutral_mass"] = round(mz - ptrms.PROTON, 4)
        cands = formula_id.score_peak(
            mz, drift, obs_ratios=obs_ratios(mz), elements=elements)
        e["candidates"] = cands
        # identification confidence / near-isobar ambiguity, surfaced explicitly
        if cands:
            e["id_confidence"] = cands[0]["probability"]
            top2 = (len(cands) > 1 and cands[0]["probability"] - cands[1]["probability"] < 0.2)
            if cands[0]["probability"] < 0.6 or top2:
                e["id_ambiguous"] = [
                    {"formula": c["formula"], "name": c["name"],
                     "probability": c["probability"]}
                    for c in cands[:3] if c["probability"] >= 0.05]
        # spectral overlap with a neighbouring peak (affects quantification)
        nb = nearest_other(mz)
        if nb is not None:
            sep = abs(nb - mz)
            if sep < mz / 2400.0 * 1.5:       # within ~1.5 physical FWHM
                e["overlap"] = {"neighbor": round(nb, 4), "sep_mDa": round(sep * 1000, 1),
                                "level": "unresolved",
                                "note": "closer than the instrument resolution — "
                                        "Raw is unreliable even after deconvolution"}
            elif sep < 0.20:
                e["overlap"] = {"neighbor": round(nb, 4), "sep_mDa": round(sep * 1000, 1),
                                "level": "deconvolved",
                                "note": "overlaps a neighbour; Raw comes from Gaussian "
                                        "deconvolution (moderate extra uncertainty)"}
        flags = []
        for rmz, rname in _REAGENT_MZ.items():
            if abs(mz - rmz * drift) < 0.03:
                flags.append("reagent/cluster: " + rname)
                break
        for q in peaks:
            if 0.008 < mz - q["mz"] < 0.4 and q.get("height", 0) > 20 * max(h, 1):
                flags.append(f"possible tail/ringing of taller m/z {q['mz']:.3f}")
                break
        if flags:
            e["likely_artifact"] = flags
        # A ready-to-use label so you don't hand-format one (and so `unknown`
        # labels carry a clean 3-dp m/z, not a full-precision float). Override it
        # when your chemistry judgment differs — it's a default, not a verdict.
        reagent = next((fl.split(": ", 1)[1] for fl in flags
                        if fl.startswith("reagent/cluster: ")), None)
        top = cands[0] if cands else None
        if reagent:
            e["suggested_label"] = reagent
        elif top and top.get("name") and e.get("id_confidence", 0) >= 0.6:
            e["suggested_label"] = top["name"]
        else:
            e["suggested_label"] = "unknown m/z %.3f" % mz
        out.append(e)
    return drift, out


def _compact_peak(e):
    """Trim a fully-annotated peak to the fields needed for curation: the top
    candidate summary + flags, dropping the per-candidate isotope arrays and the
    long tail of low-probability formulas. `ptr peaks --full` keeps everything."""
    cands = e.get("candidates") or []
    top = cands[0] if cands else None
    out = {"mz": e["mz"], "height": e.get("height"),
           "rel_height": e.get("rel_height"),
           "neutral_mass": e.get("neutral_mass"),
           "suggested_label": e.get("suggested_label")}
    if top:
        out["top_candidate"] = {"formula": top.get("formula"), "name": top.get("name"),
                                "delta_mDa": top.get("delta_mDa"), "k": top.get("k"),
                                "k_estimated": top.get("k_estimated")}
    if "id_confidence" in e:
        out["id_confidence"] = e["id_confidence"]
    if "id_ambiguous" in e:
        out["id_ambiguous"] = e["id_ambiguous"]
    if "overlap" in e:                            # keep the facts, drop the prose
        o = e["overlap"]                          # (explained once in the header note)
        out["overlap"] = {"neighbor": o.get("neighbor"), "sep_mDa": o.get("sep_mDa"),
                          "level": o.get("level")}
    if "likely_artifact" in e:
        out["likely_artifact"] = e["likely_artifact"]
    return out


def cmd_peaks(args):
    with h5py.File(args.h5, "r") as f:
        peaks = detect_peaks(f, args.min_height, args.max_peaks, args.mz_min, args.mz_max)
        a, b = ptrms.load_mass_cal(f)
        avg = f["SPECdata/AverageSpec"][:]
    drift, peaks = annotate_peaks(peaks, avgspec=avg, a=a, b=b)
    n_amb = sum(1 for p in peaks if p.get("id_ambiguous"))
    n_ovl = sum(1 for p in peaks if p.get("overlap"))
    full = getattr(args, "full", False)
    if full:
        note = ("Each peak lists candidate FORMULAS ranked by `probability` "
                "(combining exact-mass error, the measured vs predicted "
                "13C(M+1)/heteroatom(M+2) isotope ratios, and plausibility) — "
                "use this, not nearest-mass, to resolve isobars. `id_confidence` "
                "is the top candidate's probability; `id_ambiguous` lists the "
                "close rivals when the call is not clear-cut; `overlap` flags a "
                "neighbouring peak whose spectral overlap adds quantification "
                "uncertainty (unresolved = worse than deconvolved). `name`/`k` are "
                "filled when the formula is in the rate table (else k_estimated). "
                "`iso_pred` vs `iso_obs` = predicted vs observed (M+1,M+2)/M. "
                "`suggested_label` is a ready-to-use default label. "
                "Skip likely_artifact peaks. neutral_mass = mz − proton.")
        out_peaks = peaks
    else:
        note = ("Compact view (default). Each peak: `suggested_label` (a ready-to-use "
                "label — drop it into your config's peaks, or override it), "
                "`top_candidate` (best formula/name/mass-error, chosen by isotope "
                "pattern + plausibility, NOT nearest-mass), `id_confidence`, and, when "
                "relevant, `id_ambiguous` (close rivals), `overlap` (quantification "
                "uncertainty), and `likely_artifact` (skip these). neutral_mass = mz − "
                "proton. Pass `--full` for every candidate + the isotope arrays.")
        out_peaks = [_compact_peak(p) for p in peaks]
    _emit({"n_peaks": len(peaks), "mass_drift": round(drift, 6),
           "n_ambiguous": n_amb, "n_overlapping": n_ovl,
           "note": note, "peaks": out_peaks}, args.raw)


def cmd_segments(args):
    with h5py.File(args.h5, "r") as f:
        segs = ptrms.detect_segments(
            f, min_duration=args.min_duration, grad_thr=args.grad_thr,
            high_ratio=args.high_ratio)
        if args.merge_high_gap:
            segs = ptrms.merge_adjacent_high_segments(segs, args.merge_high_gap)
    _emit({"n_segments": len(segs),
           "note": "class 'high' = elevated signal (likely a sample); 'low' = "
                   "background or pre-run setup. Final outputs use chronological "
                   "sample_01/background_01 labels; do not ask for sample names. "
                   "merged_segments > 1 marks high plateaus joined across a short "
                   "unclassified transition.",
           "segments": segs}, args.raw)


def _load_peaks(args, f):
    if args.peaks_json:
        return json.loads(args.peaks_json)
    if args.config:
        cfg = json.load(open(args.config, encoding="utf-8"))
        if cfg.get("peaks"):
            return cfg["peaks"]
    if getattr(args, "auto_peaks", False):
        return detect_peaks(f, args.min_height, args.max_peaks, args.mz_min, args.mz_max)
    return None


def _load_ranges(args, f):
    if args.ranges_json:
        return json.loads(args.ranges_json)
    if args.config:
        cfg = json.load(open(args.config, encoding="utf-8"))
        if cfg.get("ranges"):
            return cfg["ranges"]
    if getattr(args, "auto_segments", False):
        segs = ptrms.detect_segments(f)
        merge_gap = getattr(args, "merge_high_gap", 0)
        if merge_gap:
            segs = ptrms.merge_adjacent_high_segments(segs, merge_gap)
        out = []
        counts = {"high": 0, "low": 0}
        for s in segs:
            kind = s["class"]
            counts[kind] += 1
            prefix = "sample" if kind == "high" else "background"
            lbl = f"{prefix}_{counts[kind]:02d}"
            out.append({"label": lbl, "start": s["start_cycle"],
                        "end": s["end_cycle"], "unit": "cycle"})
        return out
    return None


def _load_checklist(args):
    """Read the agent-authored review checklist from the config, if any.

    Accepts a top-level ``checklist`` (list of strings or {text, detail} objects)
    or ``review.checklist``. These are notes the agent wants the human to confirm
    in the browser review — surfaced as a checklist in the viz app instead of being
    dumped as a wall of text after `viz` launches."""
    path = getattr(args, "config", None)
    if not path or not os.path.exists(path):
        return []
    try:
        cfg = json.load(open(path, encoding="utf-8"))
    except Exception:
        return []
    cl = cfg.get("checklist")
    if cl is None and isinstance(cfg.get("review"), dict):
        cl = cfg["review"].get("checklist")
    return cl or []


def _resolve_ranges(f, ranges_cfg):
    ncyc = int(f["SPECdata/Intensities"].shape[0])
    if not ranges_cfg:
        return {"All": (1, ncyc)}
    dur = ptrms.spec_duration_s(f)
    out = {}
    for r in ranges_cfg:
        if r.get("unit", "cycle") == "second":
            lo = max(1, int(round(r["start"] / dur)) + 1)
            hi = min(ncyc, int(round(r["end"] / dur)) + 1)
        else:
            lo, hi = max(1, int(r["start"])), min(ncyc, int(r["end"]))
        out[r["label"]] = (lo, hi)
    return out


def cmd_analyze(args):
    with h5py.File(args.h5, "r") as f:
        peaks = _load_peaks(args, f)
        if not peaks:
            sys.exit("No peaks. Pass --peaks-json '[{\"mz\":..}]', --config, or --auto-peaks.")
        masses = [float(p["mz"]) for p in peaks]
        labels = {float(p["mz"]): (p.get("label") or p.get("formula") or "")
                  for p in peaks}
        ranges = _resolve_ranges(f, _load_ranges(args, f))

        R = args.R if args.R is not None else 1200.0
        R_phys = args.R_phys if args.R_phys is not None else 2400.0

        # resolve rate constants once (for kinetic correction and/or humid flags)
        resolved = ptrms.resolve_k(peaks, ptrms.load_rate_constants())
        k_map = resolved if args.kinetic else None
        humid_masses = {m for m, info in resolved.items() if "humid" in info.get("flags", [])}

        # humidity proxy (per-cycle water-cluster ratio) — always computed if any
        # humid compound is present, so it can be reported as a diagnostic
        hum_ratio = ptrms.water_cluster_ratio(f, R=R) if humid_masses else None

        # per-interval windows (default on): re-centre each isolated peak's window
        # on every interval's own spectrum. Disable with --no-per-interval to get
        # one whole-run window per compound (the pre-2026-08 behaviour).
        real_ranges = not (len(ranges) == 1 and "All" in ranges)
        per_range = ranges if (real_ranges and not getattr(args, "no_per_interval", False)) else None
        traces, _ = ptrms.extract_traces(f, masses, R=R, R_phys=R_phys, per_range=per_range)
        rows, params = ptrms.quantify(
            traces, f, ranges, K=args.K, primary_mz=args.primary_mz,
            molar_volume=args.molar_volume, R_used=R, k_map=k_map,
            k_anchor=args.k_anchor,
            humid_masses=(humid_masses if args.humidity_correct else None),
            humidity_ratio=hum_ratio, humidity_ref=args.humidity_ref,
            humidity_p=args.humidity_p)
        apexes = {m: ap for m, (_, ap) in traces.items()}

        # per-range humidity proxy + cross-range spread diagnostic
        humidity_report = None
        if humid_masses and hum_ratio is not None:
            per_range = {}
            for label, (lo, hi) in ranges.items():
                seg = hum_ratio[lo - 1:hi]
                seg = seg[np.isfinite(seg)]
                per_range[label] = round(float(seg.mean()), 5) if seg.size else None
            vals = [v for v in per_range.values() if v]
            spread = (max(vals) - min(vals)) / (sum(vals) / len(vals)) if vals else 0.0
            humidity_report = {
                "humid_compounds": sorted(f"{m:.3f}" for m in humid_masses),
                "proxy": "m/z 37 / m/z 21 (water-cluster ratio; m/z 19 saturates)",
                "per_range": per_range,
                "cross_range_spread_pct": round(100 * spread, 1),
                "corrected": params.get("humidity_corrected", False),
                "p": params.get("humidity_p"),
                "reference_ratio": params.get("humidity_ref"),
            }
            if spread > 0.1 and not params.get("humidity_corrected"):
                humidity_report["warning"] = (
                    f"Humidity varies {100*spread:.0f}% across ranges — relative "
                    "concentrations of the humid compounds are confounded. Add "
                    "--humidity-correct (needs a calibrated --humidity-p for accuracy).")

    _write_csv(
        args.out, args.h5, rows, labels, args.sep, ranges=ranges,
        include_cycle_rows=args.include_cycle_rows,
    )

    # agent-facing quality flags: peaks whose measured apex deviates from the
    # systematic calibration drift (median apex/nominal) — a sign the peak snapped
    # to a neighbour, is missing, or is mis-assigned. The uniform drift is expected.
    warn = []
    rel = np.array([apexes[m] / m for m in masses])
    drift = float(np.median(rel))
    for m in masses:
        resid = apexes[m] / m - drift
        if abs(resid) * m > 0.03:  # residual beyond the shared drift, in Da
            warn.append(f"m{m:.3f}: apex {apexes[m]:.4f} deviates "
                        f"{resid * m:+.3f} Da beyond the run's mass drift "
                        f"(check assignment / possible peak overlap)")
    note = None
    if args.K is None and params.get("concentration_available"):
        note = ("Concentration uses K derived from the file's own calibration; "
                "absolute scale may differ from a specific PTR-MS Viewer project. "
                "Run `calibrate` against a reference CSV, or pass --K, to match exactly.")
    if not params.get("concentration_available"):
        note = "No primary-ion/pre-computed data: Conc columns are NaN. Pass --K and ensure a primary-ion peak exists."

    # per-compound kinetic reporting + humidity flags
    kinetic_info = None
    if k_map is not None:
        used, estimated, missing, humid = {}, [], [], []
        for m in masses:
            info = k_map.get(m, {})
            if info.get("k") and not info.get("k_estimated"):
                used[f"{m:.3f}"] = {"k": info["k"], "source": info["source"]}
                if "humid" in info.get("flags", []):
                    humid.append(f"{m:.3f}")
            elif info.get("k"):     # k exists but is estimated -> kept on shared K
                estimated.append(f"{m:.3f}" + (f" ({info['source']})" if info.get("source") else ""))
            else:
                missing.append(f"{m:.3f}" + (f" ({info['source']})" if info.get("source") else ""))
        kinetic_info = {"k_anchor": args.k_anchor, "resolved": used,
                        "estimated_shared_K": estimated, "no_k": missing}
        if humid:
            kinetic_info["humidity_warning"] = (
                "These masses have proton affinity near water (HCN/formaldehyde/"
                "H2S/acids/ammonia): a fixed k is unreliable — sensitivity is "
                "humidity/temperature dependent. Use a dedicated standard/humidity "
                f"model for: {humid}")

    # sample-vs-background diagnostic: flag channels that behave like instrument
    # background / contamination rather than analytes — higher in backgrounds than
    # samples (S/B < 1) and/or drifting monotonically across the run. Lets the
    # agent relabel/drop them (e.g. an `unknown m/z 331` that is really background)
    # instead of shipping a bare "unknown" channel. Needs sample_/background_ labels.
    background_report = None
    samp_labels = [l for l in ranges if l.startswith("sample")]
    bg_labels = [l for l in ranges if l.startswith("background")]
    if samp_labels and bg_labels:
        by_mass = {}
        for r in rows:
            by_mass.setdefault(r["mass"], {})[r["range"]] = r["raw"]["Average"]
        flagged = {}
        for m in masses:
            per = by_mass.get(m, {})
            s = [per[l] for l in samp_labels if l in per]
            bg = [per[l] for l in bg_labels if l in per]
            if not s or not bg:
                continue
            smean, bmean = sum(s) / len(s), sum(bg) / len(bg)
            sb = (smean / bmean) if bmean else float("inf")
            bg_series = [per[l] for l in sorted(bg_labels) if l in per]
            trend = (bg_series[-1] / bg_series[0]) if len(bg_series) >= 2 and bg_series[0] else None
            if sb < 0.9:  # not elevated in samples -> background-like
                flagged[f"{m:.3f}"] = {"label": labels.get(m, ""),
                                       "S_over_B": round(sb, 2),
                                       "bg_trend_last_over_first": round(trend, 2) if trend else None}
        background_report = {
            "metric": "mean Raw over sample_* vs background_* ranges (S/B); "
                      "bg_trend = last/first background range (>1 = rising across run)",
            "n_samples": len(samp_labels), "n_backgrounds": len(bg_labels),
            "background_like": flagged,
        }
        if flagged:
            background_report["warning"] = (
                f"{len(flagged)} channel(s) are higher in backgrounds than samples "
                "(S/B < 0.9) — likely instrument background/contamination, not breath "
                "analytes (real VOCs have S/B >> 1). Relabel these as 'background m/z ...' "
                "or drop them from an analyte panel. Scrutinise unidentified/high-m/z "
                "peaks first; reagent/cluster diagnostic ions flagging here is expected.")

    n_cycle_rows = len(ranges) if args.include_cycle_rows else 0
    _emit({"out": args.out, "n_rows": len(rows) + n_cycle_rows,
           "n_quant_rows": len(rows), "n_cycle_rows": n_cycle_rows,
           "n_peaks": len(masses), "n_ranges": len(ranges),
           "measured_apexes": {f"{m:.3f}": round(apexes[m], 4) for m in masses},
           "params": {k: params[k] for k in ("R", "K", "molar_volume", "primary_mz",
                                              "kinetic", "concentration_available",
                                              "humidity_corrected")},
           "kinetic": kinetic_info,
           "humidity": humidity_report,
           "background": background_report,
           "apex_warnings": warn, "note": note}, args.raw)




def cmd_viz(args):
    """Review app for an EXISTING peak list + time ranges. `viz` does NOT detect
    peaks or segments — build those with `peaks`/`segments`, curate them into a
    config, and pass it via --config (or --peaks-json/--ranges-json).

    Two modes:
      * serve (default): run a localhost server, open the browser, and LIVE-SAVE
        every edit to the --config file. When the expert clicks 'Done' it runs the
        full-precision analysis and writes the results CSV (--out). Blocks until
        Done or --timeout. Because it blocks on the browser, run it backgrounded.
      * --html review.html: write a standalone, portable HTML file instead (no
        server, no CSV; edits exported via the page's Download button)."""
    import viz
    with h5py.File(args.h5, "r") as f:
        peaks = _load_peaks(args, f)
        ranges_cfg = _load_ranges(args, f)
        if not peaks or not ranges_cfg:
            sys.exit("viz needs an explicit peak list AND time ranges — it does not "
                     "detect them. Pass --config with 'peaks' and 'ranges' (or "
                     "--peaks-json/--ranges-json). Build them with `ptr peaks` and "
                     "`ptr segments`, then curate into the config.")
        R = args.R if args.R is not None else 1200.0
        R_phys = args.R_phys if args.R_phys is not None else 2400.0
        # Large files take ~30-90 s to load and pre-compute traces BEFORE the server
        # starts. Announce it so a watching agent waits for "review app running at …"
        # (below) rather than polling the port — which refuses until this finishes.
        print("ptr: preparing the review (loading the file + computing traces; large "
              "files take ~30-90 s) — the URL is printed when it's ready…",
              file=sys.stderr, flush=True)
        data = viz.build_viz_data(
            f, peaks, ranges_cfg, R=R, R_phys=R_phys, primary_mz=args.primary_mz,
            K=args.K, molar_volume=args.molar_volume,
            checklist=_load_checklist(args))

    serve_mode = args.serve if args.serve is not None else (not args.html)
    if serve_mode:
        cfg_path = args.config or args.save_config
        if not cfg_path:
            sys.exit("serve mode needs a config path to save to: pass --config PATH "
                     "(the source) or --save-config PATH.")
        if not os.path.exists(cfg_path):
            with open(cfg_path, "w", encoding="utf-8") as fh:
                json.dump({"peaks": peaks, "ranges": ranges_cfg}, fh, indent=2)
        html = viz.render_html(data, config_path=cfg_path)
        run = lambda cfg: analyze_config_to_csv(args.h5, cfg, args.out, args.sep,
                                                args.include_cycle_rows)
        spec_fn = lambda lo, hi: interval_spectrum(args.h5, lo, hi)
        final, finished, summary = viz.serve(html, cfg_path, port=args.port,
                                             timeout=args.timeout,
                                             open_browser=not args.no_open,
                                             run_analysis=run, spectrum_fn=spec_fn)
        cfg = final if final is not None else json.load(open(cfg_path, encoding="utf-8"))
        if summary is None:
            summary = run(cfg)
        summary.update({
            "mode": "served", "config": cfg_path, "review_finished": finished,
            "note": ("Done: the expert's review was saved to the config and the "
                     "full-precision analysis was written to the CSV."
                     if finished else
                     "Review timed out; the analysis ran on the last auto-saved "
                     "config. Re-open with the same command to continue editing.")})
        _emit(summary, args.raw)
    else:
        html = viz.render_html(data)
        with open(args.html, "w", encoding="utf-8") as fh:
            fh.write(html)
        _emit({"out": args.html, "served": False, "n_peaks": len(data["peaks"]),
               "n_ranges": len(data["ranges"]), "n_cycles": data["meta"]["ncyc"],
               "concentration_available": data["meta"]["concentration_available"],
               "note": "Standalone portable review app written. Open in a browser to "
                       "sanity-check/tweak and Download config.json to hand back for "
                       "`ptr analyze`. For a live-saving session that also writes the "
                       "CSV on Done, drop --html and pass --config cfg.json."},
              args.raw)


def cmd_rates(args):
    """Look up / list proton-transfer rate constants."""
    tbl = ptrms.load_rate_constants()
    if not tbl:
        sys.exit("rate_constants.json not found in the skill's reference/ directory.")
    comps = tbl["compounds"]
    q = args.query
    if q:
        try:
            target = float(q)
            comps = [c for c in comps if abs(c["mz"] - target) < 0.3]
        except ValueError:
            ql = q.lower()
            comps = [c for c in comps
                     if ql in c["name"].lower() or ql in c["formula"].lower()
                     or any(ql in n.lower() for n in c.get("isomers", []))]
    _emit({"units": "1e-9 cm3/s", "n": len(comps),
           "source": tbl.get("_source", ""), "compounds": comps}, args.raw)


def cmd_calibrate(args):
    """Fit the concentration constant K against a reference Viewer CSV."""
    ref = _parse_viewer_csv(args.reference)
    ref_conc = {k: v["con"] for k, v in ref.items()}
    with h5py.File(args.h5, "r") as f:
        peaks = _load_peaks(args, f)
        # default: calibrate on whatever masses appear in the reference
        if not peaks:
            masses = sorted({mz for (mz, _) in ref_conc})
        else:
            masses = [float(p["mz"]) for p in peaks]
        ranges = _resolve_ranges(f, _load_ranges(args, f))
        if len(ranges) == 1 and "All" in ranges:
            # derive ranges from the reference's own labels via its Cycle rows
            ranges = _ranges_from_reference(args.reference)
        R = args.R if args.R is not None else 1200.0
        traces, _ = ptrms.extract_traces(f, masses, R=R)
        K, resid, n = ptrms.calibrate_K(f, traces, ref_conc, ranges,
                                        primary_mz=args.primary_mz, R_used=R)
        K_file = ptrms.derive_K(f, ptrms.extract_primary(f, args.primary_mz, R))
    _emit({"K_calibrated": K, "K_from_file": K_file,
           "calibration_points": n, "residual_median_pct": resid,
           "usage": f"pass --K {K} to analyze to match this reference"}, args.raw)


def _ranges_from_reference(path):
    """Recover {label:(lo,hi)} from a reference CSV's own Cycle variable rows."""
    out = {}
    with open(path, encoding="utf-8-sig") as fh:
        for r in csv.reader(fh, delimiter=";"):
            if len(r) < 6 or r[1].strip() != "Cycle":
                continue
            def n(x):
                return int(float(x.replace(",", ".")))
            out[r[2].strip()] = (n(r[4]), n(r[3]))  # (min, max)
    return out


def _write_csv(path, src, rows, labels, sep, ranges=None, include_cycle_rows=False):
    header = ["File", "Variable", "Range",
              "Max(Raw)", "Min(Raw)", "Average(Raw)", "Deviation(Raw)",
              "Max(Corrected)", "Min(Corrected)", "Average(Corrected)", "Deviation(Corrected)",
              "Max(Conc)", "Min(Conc)", "Average(Conc)", "Deviation(Conc)",
              "Max(Conc [ug])", "Min(Conc [ug])", "Average(Conc [ug])", "Deviation(Conc [ug])"]

    def fmt(v):
        s = f"{v:.6f}"
        return s.replace(".", ",") if sep == ";" else s

    fh = sys.stdout if path == "-" else open(path, "w", newline="", encoding="utf-8-sig")
    w = csv.writer(fh, delimiter=sep)
    w.writerow(header)
    for r in rows:
        m = r["mass"]
        lbl = labels.get(m, "")
        var = f"m{m:.3f}".replace(".", ",") + (f" ({lbl})" if lbl else "")
        row = [src, var, r["range"]]
        for q in ("raw", "cor", "con", "ug"):
            s = r[q]
            row += [fmt(s["Max"]), fmt(s["Min"]), fmt(s["Average"]), fmt(s["Deviation"])]
        w.writerow(row)
    if include_cycle_rows:
        for label, (lo, hi) in (ranges or {}).items():
            cycles = np.arange(lo, hi + 1, dtype=float)
            deviation = float(np.std(cycles, ddof=1)) if cycles.size > 1 else 0.0
            w.writerow([
                src, "Cycle", label, str(hi), str(lo), fmt(float(cycles.mean())),
                fmt(deviation), *("" for _ in range(12)),
            ])
    if fh is not sys.stdout:
        fh.close()


def interval_spectrum(h5_path, lo, hi, block=512):
    """Average mass spectrum over cycles [lo, hi] (1-based inclusive) as a list of
    ints (index = timebin), for the viz app's per-interval spectrum view. Streams
    in cycle blocks so memory stays bounded regardless of interval length."""
    with h5py.File(h5_path, "r") as f:
        inten = f["SPECdata/Intensities"]
        ncyc, nbin = inten.shape
        lo = max(1, int(lo)); hi = min(int(ncyc), int(hi))
        if hi < lo:
            lo, hi = hi, lo
        acc = np.zeros(nbin, dtype=np.float64)
        n = 0
        for i in range(lo - 1, hi, block):      # 0-based half-open
            j = min(i + block, hi)
            acc += np.asarray(inten[i:j, :], dtype=np.float64).sum(axis=0)
            n += (j - i)
        avg = acc / max(1, n)
    return [int(round(x)) for x in avg]


def analyze_config_to_csv(h5_path, config, out, sep=";", include_cycle_rows=True):
    """Run the full analyze pipeline from a viz/exported config dict -> results CSV.

    Honours `config['analyze']` settings (R, K, molar_volume, kinetic, k_anchor,
    humidity_*) when present. Used by `viz` after an interactive review and as the
    shared quantify path. Returns a small JSON summary."""
    an = config.get("analyze") or {}
    peaks = config["peaks"]
    ranges_cfg = config.get("ranges") or []
    with h5py.File(h5_path, "r") as f:
        masses = [float(p["mz"]) for p in peaks]
        labels = {float(p["mz"]): (p.get("label") or p.get("formula") or "") for p in peaks}
        ranges = _resolve_ranges(f, ranges_cfg)
        R = an.get("R") or 1200.0
        resolved = ptrms.resolve_k(peaks, ptrms.load_rate_constants())
        k_map = resolved if an.get("kinetic") else None
        humid_masses = {m for m, info in resolved.items() if "humid" in info.get("flags", [])}
        hum_ratio = (ptrms.water_cluster_ratio(f, R=R)
                     if (humid_masses and an.get("humidity_correct")) else None)
        # per-peak integration-window overrides: `window` is either a full-width
        # number (symmetric) or {"left":hwL,"right":hwR} half-widths (asymmetric)
        def _winlr(p):
            w = p["window"]
            if isinstance(w, dict):
                return (float(w["left"]), float(w["right"]))
            return (float(w) / 2.0, float(w) / 2.0)
        windows = {float(p["mz"]): _winlr(p) for p in peaks if p.get("window")}
        # per-interval windows: each interval integrates each isolated peak with an
        # apex/window re-centred on that interval's own spectrum (peaks drift). On
        # by default when real intervals exist; matches the viz per-interval review.
        per_range = ranges if (ranges_cfg and not an.get("whole_run_windows")) else None
        traces, _ = ptrms.extract_traces(f, masses, R=R, windows=windows or None,
                                         per_range=per_range)
        rows, params = ptrms.quantify(
            traces, f, ranges, K=an.get("K"), molar_volume=an.get("molar_volume"),
            R_used=R, k_map=k_map, k_anchor=an.get("k_anchor", ptrms.K_ANCHOR_DEFAULT),
            humid_masses=(humid_masses if an.get("humidity_correct") else None),
            humidity_ratio=hum_ratio, humidity_ref=an.get("humidity_ref"),
            humidity_p=an.get("humidity_p", 1.0))
    _write_csv(out, h5_path, rows, labels, sep, ranges=ranges,
               include_cycle_rows=include_cycle_rows)
    n_cycle = len(ranges) if include_cycle_rows else 0
    return {"out": out, "n_rows": len(rows) + n_cycle, "n_peaks": len(masses),
            "n_ranges": len(ranges), "K": params.get("K"),
            "molar_volume": params.get("molar_volume"),
            "kinetic": params.get("kinetic"),
            "concentration_available": params.get("concentration_available")}


def _parse_viewer_csv(path):
    def num(s):
        return float(s.replace(",", ".")) if s.strip() else float("nan")
    out = {}
    with open(path, encoding="utf-8-sig") as fh:
        rd = csv.reader(fh, delimiter=";")
        next(rd, None)
        for row in rd:
            if len(row) < 18 or row[1].strip() == "Cycle":
                continue
            mstr = row[1].split()[0].lstrip("m").replace(",", ".")
            try:
                mz = round(float(mstr), 3)
            except ValueError:
                continue
            out[(mz, row[2].strip())] = dict(
                raw=num(row[5]), cor=num(row[9]), con=num(row[13]), ug=num(row[17]))
    return out


def cmd_compare(args):
    mine, ref = _parse_viewer_csv(args.mine), _parse_viewer_csv(args.reference)
    errs = {"raw": [], "cor": [], "con": [], "ug": []}
    per_mass, n = {}, 0
    for key, rr in ref.items():
        if key not in mine:
            continue
        n += 1
        mm = mine[key]
        for q in errs:
            if rr[q] and np.isfinite(rr[q]) and np.isfinite(mm[q]):
                e = abs(100 * (mm[q] - rr[q]) / rr[q])
                errs[q].append(e)
                if q == "raw":
                    per_mass.setdefault(key[0], []).append(e)
    if n == 0:
        sys.exit("No overlapping (mass, range) rows between the two files.")
    summary = {"matched_rows": n}
    for q in ("raw", "cor", "con", "ug"):
        a = np.array(errs[q]) if errs[q] else np.array([np.nan])
        summary[q] = {"median_pct": round(float(np.nanmedian(a)), 2),
                      "mean_pct": round(float(np.nanmean(a)), 2),
                      "p90_pct": round(float(np.nanpercentile(a, 90)), 2),
                      "max_pct": round(float(np.nanmax(a)), 2)}
    if args.per_mass:
        summary["per_mass_raw_median_pct"] = {
            f"{m:.3f}": round(float(np.median(per_mass[m])), 2) for m in sorted(per_mass)}
    _emit(summary, args.raw)


def main():
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--pretty", dest="raw", action="store_false",
                        help="Pretty-print JSON (default compact)")

    p = argparse.ArgumentParser(prog="ptr", description=__doc__, parents=[common],
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)

    pi = sub.add_parser("inspect", parents=[common], help="File metadata & calibration (JSON)")
    pi.add_argument("h5")
    pi.set_defaults(func=cmd_inspect)

    pp = sub.add_parser("peaks", parents=[common], help="Detect peaks (JSON) for chemistry assignment")
    pp.add_argument("h5")
    pp.add_argument("--full", action="store_true",
                    help="Emit every candidate formula + isotope arrays per peak "
                         "(default is a compact top-candidate view)")
    pp.add_argument("--min-height", type=float, default=1e-3,
                    help="Threshold as fraction of tallest peak (default 1e-3)")
    pp.add_argument("--max-peaks", type=int, default=300)
    pp.add_argument("--mz-min", type=float, default=15.0)
    pp.add_argument("--mz-max", type=float, default=None)
    pp.set_defaults(func=cmd_peaks)

    ps = sub.add_parser("segments", parents=[common], help="Detect time segments (JSON) for labelling")
    ps.add_argument("h5")
    ps.add_argument("--min-duration", type=int, default=30, help="Min cycles per segment")
    ps.add_argument("--grad-thr", type=float, default=0.02,
                    help="Log-signal gradient threshold for stability")
    ps.add_argument("--high-ratio", type=float, default=3.0,
                    help="x-baseline above which a segment is 'high' (sample)")
    ps.add_argument("--merge-high-gap", type=int, default=0, metavar="CYCLES",
                    help="Merge consecutive high plateaus across an unclassified gap "
                         "of at most this many cycles (default: disabled)")
    ps.set_defaults(func=cmd_segments)

    pa = sub.add_parser("analyze", parents=[common], help="Run pipeline -> results CSV")
    pa.add_argument("h5")
    pa.add_argument("--peaks-json", help="Inline JSON: [{'mz':.., 'label':.., 'formula':..}]")
    pa.add_argument("--ranges-json",
                    help="Inline JSON: [{'label':.., 'start':.., 'end':.., 'unit':'cycle|second'}]")
    pa.add_argument("--config", help="JSON file with 'peaks'/'ranges' (alternative to inline)")
    pa.add_argument("--auto-peaks", action="store_true", help="Auto-detect peaks if none given")
    pa.add_argument("--auto-segments", action="store_true",
                    help="Auto-detect segments if no ranges given (generic labels)")
    pa.add_argument("--merge-high-gap", type=int, default=0, metavar="CYCLES",
                    help="With --auto-segments, merge consecutive high plateaus "
                         "across a short unclassified gap")
    pa.add_argument("--include-cycle-rows", action="store_true",
                    help="Append Viewer-style Cycle rows with each range's boundaries")
    pa.add_argument("--out", default="-", help="Output CSV path (default stdout)")
    pa.add_argument("--sep", default=";", help="Delimiter (default ';' with comma decimals)")
    pa.add_argument("--min-height", type=float, default=1e-3)
    pa.add_argument("--max-peaks", type=int, default=300)
    pa.add_argument("--mz-min", type=float, default=15.0)
    pa.add_argument("--mz-max", type=float, default=None)
    pa.add_argument("--no-per-interval", action="store_true",
                    help="Use one whole-run integration window per compound instead of "
                         "re-centring each peak's window on every interval's own spectrum "
                         "(per-interval is the default; peaks drift between intervals)")
    pa.add_argument("--R", type=float, help="Integration-window resolution (default 1200)")
    pa.add_argument("--R-phys", dest="R_phys", type=float,
                    help="Physical peak resolution for deconvolution (default 2400)")
    pa.add_argument("--K", type=float,
                    help="Concentration constant (Conc=Corrected*K/primary). "
                         "Default: derived from file; use `calibrate` to match a Viewer project.")
    pa.add_argument("--primary-mz", type=float, default=21.022,
                    help="Primary-ion m/z for normalisation (default 21.022, H3(18O)+)")
    pa.add_argument("--kinetic", action="store_true",
                    help="Apply per-compound rate-constant (k) correction for physically "
                         "resolved sensitivities (looks up k by peak 'k'/'formula'/m/z). "
                         "Diverges from a single-k reference but is more accurate.")
    pa.add_argument("--k-anchor", type=float, default=ptrms.K_ANCHOR_DEFAULT,
                    help="Rate constant (1e-9 cm3/s) the baseline K assumes (default 2.0)")
    pa.add_argument("--humidity-correct", action="store_true",
                    help="Humidity-correct near-thermoneutral compounds (HCN etc.) using "
                         "the per-cycle water-cluster ratio. Needs a calibrated --humidity-p.")
    pa.add_argument("--humidity-p", type=float, default=1.0,
                    help="Humidity exponent in [0,1]: 0=off, 1=equilibrium upper bound "
                         "(default 1.0). Calibrate from a standard at >=2 humidities.")
    pa.add_argument("--humidity-ref", type=float,
                    help="Reference water-cluster ratio to normalise to (default: run median)")
    pa.add_argument("--molar-volume", type=float,
                    help="Molar volume L/mol (else from drift temperature)")
    pa.set_defaults(func=cmd_analyze)

    pv = sub.add_parser("viz", parents=[common],
                        help="Review app for an existing peak list + ranges (live-save "
                             "to a config with --serve, or a standalone HTML with --out)")
    pv.add_argument("h5")
    pv.add_argument("--config", help="JSON file with 'peaks'/'ranges' (source; live-save target when serving)")
    pv.add_argument("--peaks-json", help="Inline peaks JSON (alternative to --config)")
    pv.add_argument("--ranges-json", help="Inline ranges JSON (alternative to --config)")
    pv.add_argument("--save-config", help="Config path to live-save to when serving without --config")
    pv.add_argument("--serve", dest="serve", action="store_true", default=None,
                    help="Serve on localhost, live-save edits, and run analysis on 'Done' (the default)")
    pv.add_argument("--html", help="Instead of serving, write a standalone portable HTML file here")
    pv.add_argument("--out", default="results.csv",
                    help="Results CSV written when the expert clicks 'Done' (default results.csv)")
    pv.add_argument("--sep", default=";", help="CSV delimiter (default ';' with comma decimals)")
    pv.add_argument("--include-cycle-rows", dest="include_cycle_rows",
                    action="store_true", default=True, help="Append Viewer-style Cycle rows (default on)")
    pv.add_argument("--no-cycle-rows", dest="include_cycle_rows", action="store_false")
    pv.add_argument("--port", type=int, default=8765, help="Server port (default 8765; scans upward if busy)")
    pv.add_argument("--timeout", type=int, default=1800, help="Seconds to wait for 'Done' (default 1800)")
    pv.add_argument("--no-open", action="store_true", help="Do not auto-open the browser")
    pv.add_argument("--R", type=float)
    pv.add_argument("--R-phys", dest="R_phys", type=float)
    pv.add_argument("--K", type=float, help="Initial concentration constant (default from file)")
    pv.add_argument("--primary-mz", type=float, default=21.022)
    pv.add_argument("--molar-volume", type=float)
    pv.set_defaults(func=cmd_viz)

    pr = sub.add_parser("rates", parents=[common],
                        help="Look up proton-transfer rate constants (k) by name/formula/mz")
    pr.add_argument("query", nargs="?", help="Substring of name/formula, or an m/z number")
    pr.set_defaults(func=cmd_rates)

    pk = sub.add_parser("calibrate", parents=[common],
                        help="Fit concentration constant K to a reference Viewer CSV")
    pk.add_argument("h5")
    pk.add_argument("reference", help="Reference PTR-MS Viewer CSV with known concentrations")
    pk.add_argument("--peaks-json", help="Restrict calibration to these peaks (else use reference's)")
    pk.add_argument("--ranges-json", help="Ranges (else recovered from the reference's Cycle rows)")
    pk.add_argument("--config")
    pk.add_argument("--auto-peaks", action="store_true")
    pk.add_argument("--auto-segments", action="store_true")
    pk.add_argument("--min-height", type=float, default=1e-3)
    pk.add_argument("--max-peaks", type=int, default=300)
    pk.add_argument("--mz-min", type=float, default=15.0)
    pk.add_argument("--mz-max", type=float, default=None)
    pk.add_argument("--primary-mz", type=float, default=21.022)
    pk.add_argument("--R", type=float)
    pk.set_defaults(func=cmd_calibrate)

    pc = sub.add_parser("compare", parents=[common], help="Compare results CSV vs reference Viewer CSV")
    pc.add_argument("mine")
    pc.add_argument("reference")
    pc.add_argument("--per-mass", action="store_true")
    pc.set_defaults(func=cmd_compare)

    args = p.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
