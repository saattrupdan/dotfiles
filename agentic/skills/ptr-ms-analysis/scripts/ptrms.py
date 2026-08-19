"""Generalizable PTR-MS reprocessing pipeline (open-source replacement for PTR-MS Viewer).

Everything instrument-specific is read from the HDF5 file itself:
  - mass calibration      <- CALdata/Mapping  (timebin = a*sqrt(m) + b)
  - transmission curve    <- PTR-Transmission
  - concentration factor  <- derived from pre-computed TRACEdata (Conc/Corrected)
  - molar volume Vm       <- drift temperature (AddTraces/PTR-Reaction)

User inputs (experiment-specific, not in the raw file):
  - target peak list (m/z of product ions to quantify)
  - time ranges (labelled cycle windows)
"""
import os
import json
import h5py
import numpy as np

PROTON = 1.007276
K_ANCHOR_DEFAULT = 2.0   # 1e-9 cm3/s: the single k a non-kinetic calibration assumes


# ---------- per-compound rate constants (kinetic sensitivity) ----------
def load_rate_constants(path=None):
    """Load the bundled proton-transfer rate-constant table (or None).

    Works both in-place (running from the skill dir, data at ../reference/) and
    when pip/pipx-installed (data shipped as the `ptrms_reference` data package)."""
    if path is None:
        inplace = os.path.join(os.path.dirname(__file__), "..", "reference",
                               "rate_constants.json")
        if os.path.exists(inplace):
            path = inplace
        else:
            try:
                from importlib.resources import files
                path = str(files("ptrms_reference") / "rate_constants.json")
            except Exception:
                path = inplace
    try:
        with open(path) as fh:
            return json.load(fh)
    except Exception:
        return None


def resolve_k(peaks, rate_table, mz_tol=0.03):
    """Determine each peak's rate constant k (in 1e-9 cm3/s units) and its source.

    Priority: an explicit `k` on the peak > exact `formula` match > a unique
    m/z match in the table. Returns {mz: {k, source, flags}}. `flags` carries
    'humid' (needs humidity handling) / 'frag' (fragments) from the table."""
    by_formula, by_mz = {}, {}
    if rate_table:
        for c in rate_table.get("compounds", []):
            by_formula[c["formula"].upper()] = c
            by_mz.setdefault(round(c["mz"], 1), []).append(c)
    out = {}
    for p in peaks:
        mz = float(p["mz"])
        k, src, flags, kest = None, None, [], False
        if p.get("k") is not None:
            k = float(p["k"])
            k = k / 1e-9 if k < 1e-6 else k   # accept SI or 1e-9 units
            src = "explicit"
            kest = bool(p.get("k_estimated", False))
        elif p.get("formula") and p["formula"].upper() in by_formula:
            c = by_formula[p["formula"].upper()]
            k, src, flags = c["k"], "formula:" + c["name"], c["flags"]
            kest = bool(c.get("k_estimated", False))
        else:
            cand = [c for c in by_mz.get(round(mz, 1), [])
                    if abs(c["mz"] - mz) < mz_tol]
            if len(cand) == 1:
                k, src, flags = cand[0]["k"], "mz:" + cand[0]["name"], cand[0]["flags"]
                kest = bool(cand[0].get("k_estimated", False))
            elif len(cand) > 1:
                src = "ambiguous:" + ",".join(c["name"] for c in cand)
        out[mz] = dict(k=k, source=src, flags=flags, k_estimated=kest)
    return out

# ---------- calibration read from file ----------
def load_mass_cal(f):
    (m1, tb1), (m2, tb2) = f["CALdata/Mapping"][:]
    a = (tb2 - tb1) / (np.sqrt(m2) - np.sqrt(m1))
    b = tb1 - a * np.sqrt(m1)
    return float(a), float(b)

def m_to_tb(m, a, b): return a * np.sqrt(m) + b
def tb_to_m(tb, a, b): return ((tb - b) / a) ** 2

def load_transmission(f):
    mf = f["PTR-Transmission/Masses_Factors"][:]
    tm, tf = mf[0, 0, :], mf[0, 1, :]
    keep = tm > 0
    tm, tf = tm[keep], tf[keep]
    o = np.argsort(tm)
    return tm[o], tf[o]

def derive_sensitivity_percycle(f, min_corrected=1000.0):
    """Per-cycle ppb-per-corrected-cps from the file's own pre-computed traces.

    The instrument's concentration model folds primary-ion normalisation into the
    Conc/Corrected ratio, so this ratio is constant across masses within a cycle
    but drifts over the run. Returning it per cycle tracks that drift. Returns a
    1-D array of length n_cycles, or None if the file has no pre-computed traces.
    """
    if "TRACEdata/TraceConcentration" not in f:
        return None
    cor = np.asarray(f["TRACEdata/TraceCorrected"][:], dtype=np.float64)
    con = np.asarray(f["TRACEdata/TraceConcentration"][:], dtype=np.float64)
    ncyc = cor.shape[0]
    s = np.full(ncyc, np.nan)
    for i in range(ncyc):
        c = cor[i]; k = con[i]
        m = (c > min_corrected) & np.isfinite(c) & np.isfinite(k) & (k > 0)
        if m.any():
            s[i] = np.median(k[m] / c[m])
    # fill any gaps with the global median
    good = np.isfinite(s)
    if not good.any():
        return None
    s[~good] = np.median(s[good])
    return s

def extract_primary(f, primary_mz=21.022, R=1200.0, block=400):
    """Per-cycle primary-ion (reagent-ion) signal used to normalise concentration.

    In H3O+ mode the primary ion is monitored via its H3(18O)+ isotope at m/z ~21
    (m/z 19 saturates the detector). Uses the pre-computed TraceRaw column nearest
    primary_mz when available (fast, and what the instrument/Viewer normalise to);
    otherwise integrates the peak from the raw spectra. Returns a length-n_cycles
    array, or None if it cannot be obtained."""
    if "TRACEdata/TraceRaw" in f and "TRACEdata/TraceInfo" in f:
        ti = f["TRACEdata/TraceInfo"][:]
        centers = np.array([float(ti[2, c]) for c in range(ti.shape[1])])
        j = int(np.argmin(np.abs(centers - primary_mz)))
        if abs(centers[j] - primary_mz) < 0.1:
            return np.asarray(f["TRACEdata/TraceRaw"][:, j], dtype=np.float64)
    try:
        (traces, _) = extract_traces(f, [primary_mz], R=R, block=block)
        return traces[primary_mz][0]
    except Exception:
        return None


def water_cluster_ratio(f, cluster_mz=37.028, primary_mz=21.022, R=1200.0):
    """Per-cycle humidity proxy X(t) = I(first water cluster) / I(primary isotope).

    The standard PTR-MS humidity measure is I(H3O+.H2O)/I(H3O+) = m/z 37 / m/z 19,
    but m/z 19 is usually saturated/blanked, so this uses the m/z 21 primary isotope
    as the denominator instead (a constant isotope factor cancels once the ratio is
    normalised to a reference). Returns a length-n_cycles array, or None."""
    def get(mz):
        if "TRACEdata/TraceRaw" in f and "TRACEdata/TraceInfo" in f:
            ti = f["TRACEdata/TraceInfo"][:]
            centers = np.array([float(ti[2, c]) for c in range(ti.shape[1])])
            j = int(np.argmin(np.abs(centers - mz)))
            if abs(centers[j] - mz) < 0.1:
                return np.asarray(f["TRACEdata/TraceRaw"][:, j], dtype=np.float64)
        try:
            return extract_traces(f, [mz], R=R)[0][mz][0]
        except Exception:
            return None
    c = get(cluster_mz)
    p = get(primary_mz)
    if c is None or p is None:
        return None
    x = np.full_like(p, np.nan)
    ok = p > 0
    x[ok] = c[ok] / p[ok]
    return x


def humidity_factor(ratio, ref, p):
    """Per-cycle correction for near-thermoneutral (humid-flagged) compounds.

    In the equilibrium limit the proton transfer is reversible and sensitivity
    scales as 1/[H2O], so signal must be multiplied by (X/X_ref)**p to normalise to
    a reference humidity X_ref. p in [0,1]: p=0 no correction (kinetic limit),
    p=1 full equilibrium (upper bound). Calibrate p from a standard at >=2
    humidities; without that it is approximate and only makes RELATIVE comparisons
    at differing humidity valid, not absolute values."""
    f = np.ones_like(ratio)
    good = np.isfinite(ratio) & (ratio > 0) & (ref > 0)
    f[good] = (ratio[good] / ref) ** p
    return f


def derive_K(f, primary, min_corrected=1000.0):
    """Concentration calibration constant K for Conc = Corrected * K / primary.

    Derived from the file's own pre-computed concentration so the default output
    reproduces the instrument's concentration. K = median over cycles of
    sensitivity(t) * primary(t), where sensitivity(t) = TraceConc/TraceCorrected.
    Returns None if the file has no pre-computed concentration data.

    NOTE: this is the *acquisition* calibration. A specific PTR-MS Viewer project
    may use a different absolute K (its own sensitivity setting); use `calibrate`
    against a reference, or pass K explicitly, to match that exactly."""
    s = derive_sensitivity_percycle(f, min_corrected=min_corrected)
    if s is None or primary is None:
        return None
    prod = s * primary
    good = np.isfinite(prod) & (primary > 0)
    if not good.any():
        return None
    return float(np.median(prod[good]))


def derive_molar_volume(f):
    """Vm [L/mol] at the drift-tube temperature (ideal-gas, 1013.25 mbar)."""
    try:
        data = f["AddTraces/PTR-Reaction/Data"]
        info = f["AddTraces/PTR-Reaction/Info"][0]
        names = [x.decode("latin-1").strip() for x in info]
        ti = names.index("T-Drift_Act")
        T_C = float(np.nanmean(data[:, ti]))
        return 22.414 * (T_C + 273.15) / 273.15
    except Exception:
        return 24.465  # 25 C fallback

# ---------- peak extraction ----------
def find_apex(avgspec, a, b, target_m, tol=0.15):
    tlo = max(0, int(m_to_tb(target_m - tol, a, b)))
    thi = min(len(avgspec), int(m_to_tb(target_m + tol, a, b)))
    if thi <= tlo:
        return target_m, tlo, thi
    apex_tb = tlo + int(np.argmax(avgspec[tlo:thi]))
    return tb_to_m(apex_tb, a, b), tlo, thi


def refine_apex_local(avgspec, a, b, apex0, tol=0.035):
    """Re-centre a peak on THIS spectrum's real maximum near a known apex.

    Peak positions drift between time intervals (mass-cal drift; a compound may be
    absent in a background). Given a canonical apex, return the local maximum
    within +-tol only if it is a genuine interior peak that clears the noise —
    otherwise None, meaning keep the canonical position (so a background where the
    compound is absent does NOT chase an unrelated neighbour). Mirrors the viz
    per-interval overlay exactly so the delivered CSV matches what was reviewed."""
    lo = max(0, int(np.floor(m_to_tb(apex0 - tol, a, b))))
    hi = min(len(avgspec) - 1, int(np.ceil(m_to_tb(apex0 + tol, a, b))))
    if hi - lo < 2:
        return None
    bi = lo + int(np.argmax(avgspec[lo:hi + 1]))
    bv = float(avgspec[bi])
    if bi <= lo or bi >= hi:            # max at an edge -> monotonic climb, no clear peak
        return None
    floor = max(float(avgspec[lo]), float(avgspec[hi]))
    if bv >= 3 and bv >= 1.25 * floor:
        return tb_to_m(bi, a, b)
    return None

def estimate_mass_scale(avgspec, a, b, target_masses, tol=0.15):
    """Robust global mass-scale correction (apex_m / nominal_m).

    A simple 2-point calibration drifts over a long run, leaving a near-constant
    relative offset between theoretical peak masses and measured apexes. We
    estimate that single factor from the median over all requested peaks (robust
    to peaks whose free apex-search jumps to a strong neighbour)."""
    ratios = []
    for m in target_masses:
        apex_m, _, _ = find_apex(avgspec, a, b, m, tol)
        ratios.append(apex_m / m)
    return float(np.median(ratios)) if ratios else 1.0

def peak_window(apex_m, a, b, R):
    hw = apex_m / (2 * R)
    wl = int(np.floor(m_to_tb(apex_m - hw, a, b)))
    wr = int(np.ceil(m_to_tb(apex_m + hw, a, b)))
    return wl, wr

def peak_window_lr(apex_m, a, b, hwL, hwR):
    """Integration window from explicit left/right half-widths in m/z (per-peak,
    possibly asymmetric — the window need not be centred on the apex)."""
    wl = int(np.floor(m_to_tb(apex_m - hwL, a, b)))
    wr = int(np.ceil(m_to_tb(apex_m + hwR, a, b)))
    return wl, wr

def _hw_for(m, apex_m, R, windows):
    """(left, right) half-widths in m/z for a peak: an explicit per-peak override
    (a scalar for symmetric, or a (left,right) pair), else R-derived symmetric."""
    if windows and m in windows and windows[m]:
        w = windows[m]
        if isinstance(w, (tuple, list)):
            return float(w[0]), float(w[1])
        return float(w), float(w)
    hw = apex_m / (2 * R)
    return hw, hw

def _cluster(masses, gap=0.20):
    """Group masses whose neighbours are closer than `gap` (needs deconvolution)."""
    ms = sorted(masses)
    groups, cur = [], [ms[0]]
    for m in ms[1:]:
        if m - cur[-1] < gap:
            cur.append(m)
        else:
            groups.append(cur); cur = [m]
    groups.append(cur)
    return groups

def _sigma_tb(mu_m, a, R_phys):
    """Gaussian sigma in timebins for a peak at mu_m given physical resolution."""
    sigma_m = mu_m / (2.3548 * R_phys)
    dtb_dm = a / (2 * np.sqrt(mu_m))     # d(timebin)/d(m)
    return sigma_m * dtb_dm

def deconvolve_cluster(f, centers_m, a, b, R=1200.0, R_phys=2400.0, block=400,
                       windows=None):
    """Separate overlapping peaks by vectorised linear least-squares Gaussian
    unmixing. Returns dict center_m -> raw_trace (scaled to match the window-sum
    definition so isolated and deconvolved peaks share one Raw scale)."""
    inten = f["SPECdata/Intensities"]
    ncyc = inten.shape[0]
    centers_tb = np.array([m_to_tb(m, a, b) for m in centers_m])
    sig_tb = np.array([_sigma_tb(m, a, R_phys) for m in centers_m])
    tlo = int(np.floor(centers_tb.min() - 6 * sig_tb.max()))
    thi = int(np.ceil(centers_tb.max() + 6 * sig_tb.max()))
    x = np.arange(tlo, thi)
    # design matrix G (n_tb x K), unit-height Gaussians
    G = np.exp(-0.5 * ((x[:, None] - centers_tb[None, :]) / sig_tb[None, :]) ** 2)
    P = G @ np.linalg.inv(G.T @ G)        # n_tb x K : A = Y @ P
    # normalisation: window-sum of each peak's own unit Gaussian (matches isolated)
    norm = np.zeros(len(centers_m))
    for k, m in enumerate(centers_m):
        hwL, hwR = _hw_for(m, m, R, windows)
        wl, wr = peak_window_lr(m, a, b, hwL, hwR)
        xx = np.arange(wl, wr)
        norm[k] = np.exp(-0.5 * ((xx - centers_tb[k]) / sig_tb[k]) ** 2).sum()

    traces = np.empty((ncyc, len(centers_m)))
    for i in range(0, ncyc, block):
        j = min(i + block, ncyc)
        Y = inten[i:j, tlo:thi]
        A = Y @ P                          # (j-i) x K amplitudes
        np.clip(A, 0, None, out=A)
        traces[i:j, :] = A * norm[None, :]
    return {m: traces[:, k] for k, m in enumerate(centers_m)}

def extract_traces(f, target_masses, R=1200.0, R_phys=2400.0, block=400,
                   refine_tol=0.02, cluster_gap=0.20, windows=None,
                   per_range=None, range_refine_tol=0.035):
    """Return dict m -> (raw_trace[ncycles], apex_m). One streaming pass.

    Peak centring is two-stage: (1) a robust global mass-scale correction aligns
    theoretical masses to measured apexes; (2) a tight local apex search
    (+-refine_tol) around the corrected position snaps to the exact peak without
    jumping to a close neighbour. This lets closely-spaced peaks be resolved.

    windows: optional {target_mass: half_width_m} to override the R-derived
    integration window for specific peaks (from an expert's viz adjustment).

    per_range: optional {label: (lo, hi)} (1-based inclusive cycles). When given,
    each interval's cycles are re-integrated with each isolated peak's apex/window
    RE-CENTRED on that interval's own average spectrum (peaks drift between
    intervals). apex_m in the return stays the whole-run value (transmission moves
    <0.1% over the drift); only the per-cycle window changes. Clustered peaks keep
    their whole-run deconvolved trace."""
    a, b = load_mass_cal(f)
    inten = f["SPECdata/Intensities"]
    ncyc = inten.shape[0]
    avg = f["SPECdata/AverageSpec"][:]
    nbin = avg.shape[0]

    scale = estimate_mass_scale(avg, a, b, target_masses)

    # isolated peaks -> window-sum; clustered peaks -> Gaussian deconvolution
    groups = _cluster(target_masses, gap=cluster_gap)
    isolated = [g[0] for g in groups if len(g) == 1]
    clusters = [g for g in groups if len(g) > 1]

    # Isolated peaks: free apex search corrects any residual per-peak offset.
    # Search the UNION of the nominal and scale-corrected positions, not just a
    # tight window around the scaled one. The global scale is fit mostly from
    # low/mid-mass peaks and, being multiplicative, over-extrapolates at high m/z
    # (e.g. a +0.076% scale = +0.25 Da at m/z 331) — so a tight search around the
    # scaled position lands off a high-mass peak. It is also wrong when the config
    # mass is already the measured apex (unknowns), where no correction is due.
    # Spanning both positions recovers the true apex in every case; isolated peaks
    # are >= cluster_gap from any configured neighbour, so the widened search is
    # safe and simply snaps to the strongest local maximum.
    # Clustered peaks: use the robust scale-corrected theoretical position, since
    # a free apex search would drift onto the dominant neighbour.
    apexes = {}
    for m in isolated:
        lo = min(m, m * scale) - refine_tol
        hi = max(m, m * scale) + refine_tol
        apex_m, _, _ = find_apex(avg, a, b, 0.5 * (lo + hi), tol=0.5 * (hi - lo))
        apexes[m] = apex_m
    for g in clusters:
        for m in g:
            apexes[m] = m * scale

    # per-range average-spectrum accumulators, filled during the isolated pass so
    # interval re-centring costs no extra read of the whole run
    want_ranges = {lbl: (int(lo), int(hi)) for lbl, (lo, hi) in (per_range or {}).items()
                   if int(hi) >= int(lo)}
    rsum = {lbl: np.zeros(nbin, dtype=np.float64) for lbl in want_ranges}
    rcnt = {lbl: 0 for lbl in want_ranges}

    traces = {}
    if isolated:
        win_tb = {m: peak_window_lr(apexes[m], a, b, *_hw_for(m, apexes[m], R, windows))
                  for m in isolated}
        buf = {m: np.empty(ncyc) for m in isolated}
        for i in range(0, ncyc, block):
            j = min(i + block, ncyc)
            chunk = inten[i:j, :]
            for m in isolated:
                wl, wr = win_tb[m]
                buf[m][i:j] = chunk[:, wl:wr].sum(axis=1)
            for lbl, (lo, hi) in want_ranges.items():   # cycles are 1-based inclusive
                c0, c1 = max(i, lo - 1), min(j, hi)
                if c1 > c0:
                    rsum[lbl] += chunk[c0 - i:c1 - i, :].sum(axis=0)
                    rcnt[lbl] += c1 - c0
        for m in isolated:
            traces[m] = buf[m]
        # second pass over ONLY each interval's cycles: re-centre each isolated
        # peak on that interval's average spectrum and overwrite those cycles
        for lbl, (lo, hi) in want_ranges.items():
            if not rcnt[lbl]:
                continue
            avg_r = rsum[lbl] / rcnt[lbl]
            rwin = {}
            for m in isolated:
                if windows and m in windows:
                    continue                       # hand-placed window: keep it everywhere (matches viz winManual)
                ap = refine_apex_local(avg_r, a, b, apexes[m], tol=range_refine_tol)
                if ap is None:
                    continue                       # no clear interval peak -> keep whole-run window
                rwin[m] = peak_window_lr(ap, a, b, *_hw_for(m, ap, R, windows))
            if not rwin:
                continue
            for i in range(lo - 1, hi, block):
                j = min(i + block, hi)
                chunk = inten[i:j, :]
                for m, (wl, wr) in rwin.items():
                    traces[m][i:j] = chunk[:, wl:wr].sum(axis=1)
    for g in clusters:
        apex_hw = {apexes[m]: _hw_for(m, apexes[m], R, windows) for m in g}
        dec = deconvolve_cluster(f, [apexes[m] for m in g], a, b,
                                 R=R, R_phys=R_phys, block=block, windows=apex_hw)
        for m, apex_m in zip(g, [apexes[m] for m in g]):
            traces[m] = dec[apex_m]

    return {m: (traces[m], apexes[m]) for m in target_masses}, (a, b)

# ---------- automatic segmentation ----------
def build_discriminator(f, mz_lo=40.0, mz_hi=200.0, block=400):
    """Per-cycle composite VOC signal, ~1 at background and high during samples.

    Fast path uses the pre-computed TraceRaw (normalising each strong VOC trace to
    its own baseline so no single peak dominates). Fallback streams the raw spectra
    and sums a VOC m/z band. Returns a 1-D array length n_cycles."""
    if "TRACEdata/TraceRaw" in f and "TRACEdata/TraceInfo" in f:
        ti = f["TRACEdata/TraceInfo"][:]
        centers = np.array([float(ti[2, c]) for c in range(ti.shape[1])])
        band = np.where((centers >= mz_lo) & (centers <= mz_hi))[0]
        R = np.asarray(f["TRACEdata/TraceRaw"][:, band], dtype=np.float64)
        med = np.median(R, axis=0)
        pos = med[med > 0]
        if pos.size:
            strong = med > np.percentile(pos, 70)
            if strong.any():
                Rs = R[:, strong] / med[strong]
                return Rs.mean(axis=1)
    # fallback: total ion current in a VOC timebin band, streamed
    a, b = load_mass_cal(f)
    inten = f["SPECdata/Intensities"]
    ncyc = inten.shape[0]
    tlo = max(0, int(m_to_tb(mz_lo, a, b)))
    thi = min(inten.shape[1], int(m_to_tb(mz_hi, a, b)))
    tic = np.empty(ncyc)
    for i in range(0, ncyc, block):
        j = min(i + block, ncyc)
        tic[i:j] = inten[i:j, tlo:thi].sum(axis=1)
    base = np.median(tic[tic > 0]) or 1.0
    return tic / base


def detect_segments(f, discriminator=None, min_duration=30, trim=8,
                    grad_thr=0.02, smooth=9, high_ratio=3.0):
    """Detect stable measurement plateaus (candidate time ranges).

    Works in log space so the large sample/background dynamic range is handled by
    relative changes. A cycle is 'stable' where the smoothed log-signal gradient is
    small; runs of stable cycles longer than min_duration (edge-trimmed) become
    segments. Each is classified 'high' (elevated / sample) or 'low' (background or
    setup) relative to the run baseline. The caller assigns meaningful labels.

    Returns list of dicts: start_cycle/end_cycle (1-based inclusive),
    start_s/end_s, n_cycles, level (x baseline), class."""
    D = build_discriminator(f) if discriminator is None else discriminator
    ncyc = len(D)
    dur = spec_duration_s(f)
    L = np.log10(np.clip(D, 1e-3, None))
    if smooth > 1:
        L = np.convolve(L, np.ones(smooth) / smooth, mode="same")
    g = np.abs(np.gradient(L))
    stable = g < grad_thr
    baseline = np.percentile(D, 20) or 1.0

    segs = []
    i = 0
    while i < ncyc:
        if not stable[i]:
            i += 1
            continue
        j = i
        while j < ncyc and stable[j]:
            j += 1
        if j - i >= min_duration:
            lo, hi = i + trim, j - trim          # 0-based, trimmed
            if hi - lo >= 15:
                level = float(D[lo:hi].mean() / baseline)
                segs.append(dict(
                    start_cycle=lo + 1, end_cycle=hi, n_cycles=hi - lo,
                    start_s=round(lo * dur, 1), end_s=round((hi - 1) * dur, 1),
                    level=round(level, 2),
                    **{"class": "high" if level >= high_ratio else "low"}))
        i = j
    return segs


def merge_adjacent_high_segments(segments, max_gap_cycles=60):
    """Merge consecutive high plateaus separated only by a short transition.

    Plateau detection can split one physical sample when its signal briefly changes
    level.  Merge only adjacent entries that are both classified ``high`` and whose
    unclassified gap is no longer than ``max_gap_cycles``.  A detected low plateau
    therefore always remains a boundary.
    """
    if max_gap_cycles <= 0:
        return [dict(segment) for segment in segments]

    merged = []
    for segment in segments:
        current = dict(segment)
        current.setdefault("merged_segments", 1)
        current.setdefault("merged_gaps", [])
        if merged:
            previous = merged[-1]
            gap = current["start_cycle"] - previous["end_cycle"] - 1
            if (
                previous.get("class") == "high"
                and current.get("class") == "high"
                and 0 <= gap <= max_gap_cycles
            ):
                previous_cycles = previous["n_cycles"]
                current_cycles = current["n_cycles"]
                stable_cycles = previous_cycles + current_cycles
                previous["end_cycle"] = current["end_cycle"]
                previous["end_s"] = current["end_s"]
                previous["n_cycles"] = (
                    previous["end_cycle"] - previous["start_cycle"] + 1
                )
                previous["level"] = round(
                    (
                        previous["level"] * previous_cycles
                        + current["level"] * current_cycles
                    )
                    / stable_cycles,
                    2,
                )
                previous["merged_segments"] += current["merged_segments"]
                previous["merged_gaps"].append(gap)
                previous["merged_gaps"].extend(current["merged_gaps"])
                continue
        merged.append(current)
    return merged


def spec_duration_s(f):
    try:
        return float(f.attrs["Single Spec Duration (ms)"][0]) / 1000.0
    except Exception:
        return 1.0


# ---------- quantification ----------
def stats(x):
    return dict(Max=float(x.max()), Min=float(x.min()),
                Average=float(x.mean()), Deviation=float(x.std(ddof=1)))

def quantify(traces, f, ranges, K=None, primary=None, primary_mz=21.022,
             molar_volume=None, R_used=1200.0, k_map=None,
             k_anchor=K_ANCHOR_DEFAULT, humid_masses=None,
             humidity_ratio=None, humidity_ref=None, humidity_p=1.0):
    """Turn raw traces into Corrected / Conc / Conc[ug] and per-range statistics.

    Concentration uses the standard primary-ion-normalised model
        Conc[ppb] = Corrected * K / I_primary(t) * (k_anchor / k_compound)
    The last factor is the optional per-compound kinetic correction: without it
    (k_map None) every compound shares one effective rate constant and the output
    reproduces a single-sensitivity reference; with it, each compound is scaled by
    its own proton-transfer rate constant, which is physically more accurate.

    K:       None -> derived from the file's own pre-computed concentration; else
             a float (from `calibrate` / a standard).
    primary: per-cycle primary-ion signal; extracted from the file if None.
    k_map:   {mz: {'k': value_in_1e-9, ...}} from resolve_k(); None disables the
             kinetic correction.
    k_anchor: the single rate constant (1e-9 units) the baseline K assumes.
    """
    tm, tf = load_transmission(f)
    if primary is None:
        primary = extract_primary(f, primary_mz=primary_mz, R=R_used)
    if molar_volume is None:
        molar_volume = derive_molar_volume(f)
    if K is None:
        K = derive_K(f, primary)

    # guard the divide; where primary is missing/zero, concentration is undefined
    if primary is not None and K is not None:
        pos = primary > 0
        norm = np.zeros_like(primary)
        norm[pos] = K / primary[pos]
    else:
        norm = None

    # humidity correction (per-cycle) for near-thermoneutral compounds
    humid_masses = set(humid_masses or [])
    humid_applied = False
    hfac = None
    if humid_masses and humidity_ratio is not None:
        if humidity_ref is None:
            good = np.isfinite(humidity_ratio) & (humidity_ratio > 0)
            humidity_ref = float(np.median(humidity_ratio[good])) if good.any() else None
        if humidity_ref:
            hfac = humidity_factor(humidity_ratio, humidity_ref, humidity_p)
            humid_applied = True

    rows = []
    for m, (raw, apex_m) in traces.items():
        T = float(np.interp(apex_m, tm, tf))
        cor = raw / T
        kfac = 1.0
        # hybrid kinetic: only scale by a compound's own k when that k is a
        # measured value; compounds with an estimated k stay on the shared K.
        if k_map and k_map.get(m, {}).get("k") and not k_map[m].get("k_estimated"):
            kfac = k_anchor / float(k_map[m]["k"])
        if norm is not None:
            con = cor * norm * kfac
            if hfac is not None and m in humid_masses:
                con = con * hfac
            ug = con * (m - PROTON) / molar_volume
        else:
            con = np.full_like(cor, np.nan)
            ug = con
        for label, (lo, hi) in ranges.items():
            s = slice(lo - 1, hi)  # 1-based inclusive cycle window
            rows.append(dict(mass=m, apex=apex_m, range=label, transmission=T,
                             raw=stats(raw[s]), cor=stats(cor[s]),
                             con=stats(con[s]), ug=stats(ug[s])))
    return rows, dict(K=K, molar_volume=molar_volume, R=R_used,
                      primary_mz=primary_mz, kinetic=k_map is not None,
                      k_anchor=k_anchor, concentration_available=norm is not None,
                      humidity_corrected=humid_applied, humidity_ref=humidity_ref,
                      humidity_p=humidity_p if humid_applied else None)


def calibrate_K(f, traces, ref_rows, ranges, primary=None, primary_mz=21.022,
                R_used=1200.0):
    """Fit the concentration constant K so output matches a reference.

    ref_rows: {(round(mz,3), range_label): reference_conc_ppb}. Returns
    (K, residual_median_pct, n_points). K is the median of
    ref_conc * I_primary / Corrected over all matched reference points."""
    tm, tf = load_transmission(f)
    if primary is None:
        primary = extract_primary(f, primary_mz=primary_mz, R=R_used)
    ks, mine_cor = [], {}
    for m, (raw, apex_m) in traces.items():
        T = float(np.interp(apex_m, tm, tf))
        cor = raw / T
        for label, (lo, hi) in ranges.items():
            mine_cor[(round(m, 3), label)] = (cor[lo - 1:hi].mean(),
                                              primary[lo - 1:hi].mean())
    for key, ref_c in ref_rows.items():
        if key in mine_cor and ref_c:
            c, p = mine_cor[key]
            if c > 0 and p > 0:
                ks.append(ref_c * p / c)
    if not ks:
        return None, None, 0
    K = float(np.median(ks))
    resid = [abs(100 * (K - k) / k) for k in ks]
    return K, float(np.median(resid)), len(ks)
