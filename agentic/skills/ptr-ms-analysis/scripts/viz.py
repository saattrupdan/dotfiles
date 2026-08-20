#!/usr/bin/env python3
"""Build / serve an interactive HTML review app for a PTR-MS analysis.

`ptr viz FILE.h5 ...` renders a browser app (from an EXISTING peak list + time
ranges — it does not detect anything) where an expert can:
  - pan/zoom the average mass spectrum, see the assigned peaks and their
    integration windows, and re-centre / add / remove / relabel peaks;
  - see the selected compound's per-cycle signal over time with the segments
    overlaid, and drag / add / rename segments;
  - change the concentration constant K, molar volume, the kinetic (per-compound
    rate-constant) correction, and the humidity correction;
  - watch Raw / Corrected / Conc / Conc[ug] recompute live.

The two views (mass spectrum, signal over time) share one large tabbed plot with
a draggable overview inset; the controls sit below it. With `--serve` the page
live-saves every edit into the --config file and the CLI blocks until the expert
clicks "Done"; with `--html` it writes a standalone, portable HTML file instead.
Most preview values are embedded and recompute offline. Live values use a
window-sum integration (exact for isolated peaks); overlapping peaks are flagged
— their authoritative values come from the deconvolution in `ptr analyze` when
Done is clicked. Changes to primary m/z, physical resolution, or whole-run window
mode require re-extraction and are marked stale until that authoritative rerun.
"""
from __future__ import annotations
import http.server
import json
import os
import socketserver
import subprocess
import sys
import threading
import webbrowser
import numpy as np

import ptrms
import formula_id


def _normalise_checklist(items):
    """Coerce the config's checklist into [{text, detail?}] for the UI.

    Accepts plain strings or {text, detail} objects; drops anything empty."""
    out = []
    for it in (items or []):
        if isinstance(it, str):
            if it.strip():
                out.append({"text": it.strip()})
        elif isinstance(it, dict) and (it.get("text") or "").strip():
            o = {"text": it["text"].strip()}
            if (it.get("detail") or "").strip():
                o["detail"] = it["detail"].strip()
            out.append(o)
    return out


def build_viz_data(f, peaks_cfg, ranges_cfg, R=1200.0, R_phys=2400.0,
                   primary_mz=21.022, K=None, molar_volume=None, checklist=None,
                   analysis_settings=None, config_base=None):
    """Assemble everything the HTML app needs into one JSON-able dict.

    peaks_cfg  : [{mz, label?, formula?, k?}]  (assigned peaks to quantify/tweak)
    ranges_cfg : [{label, start, end, unit, class?}]  (time segments)
    checklist  : [str | {text, detail?}]  (agent-authored review points to confirm)
    """
    analysis_settings = analysis_settings or {
        "R": R, "R_phys": R_phys, "primary_mz": primary_mz, "K": K,
        "molar_volume": molar_volume, "kinetic": False,
        "k_anchor": ptrms.K_ANCHOR_DEFAULT, "humidity_correct": False,
        "humidity_p": 1.0, "humidity_ref": None, "whole_run_windows": False,
        "sources": {},
    }
    R = analysis_settings["R"]
    R_phys = analysis_settings["R_phys"]
    primary_mz = analysis_settings["primary_mz"]
    K = analysis_settings["K"]
    molar_volume = analysis_settings["molar_volume"]
    a, b = ptrms.load_mass_cal(f)
    tm, tf = ptrms.load_transmission(f)
    inten = f["SPECdata/Intensities"]
    ncyc = int(inten.shape[0])
    avg = np.asarray(f["SPECdata/AverageSpec"][:], dtype=np.float64)
    dur = ptrms.spec_duration_s(f)

    primary = ptrms.extract_primary(f, primary_mz=primary_mz, R=R)
    humidity = ptrms.water_cluster_ratio(f, primary_mz=primary_mz, R=R)
    discriminator = ptrms.build_discriminator(f)
    file_molar_volume, file_molar_volume_source = ptrms.derive_molar_volume_info(f)
    if molar_volume is None:
        molar_volume = file_molar_volume
        molar_volume_source = file_molar_volume_source
    else:
        molar_volume_source = analysis_settings["sources"].get(
            "molar_volume", "configured")
    file_K = ptrms.derive_K(f, primary)
    if K is None:
        K = file_K
        K_source = "file acquisition calibration"
    else:
        K_source = analysis_settings["sources"].get("K", "configured")

    ranges = []
    for r in (ranges_cfg or []):
        unit = r.get("unit", "cycle")
        if unit == "second":
            lo = max(1, int(round(r["start"] / dur)) + 1)
            hi = min(ncyc, int(round(r["end"] / dur)) + 1)
        else:
            lo, hi = max(1, int(r["start"])), min(ncyc, int(r["end"]))
        cls = {"high": "sample", "low": "background"}.get(r.get("class"), r.get("class"))
        if cls not in ("sample", "background"):
            cls = "background" if str(r["label"]).lower().startswith("background") else "sample"
        ranges.append({"label": r["label"], "start": lo, "end": hi, "class": cls})

    masses = [float(p["mz"]) for p in peaks_cfg]
    # per-peak integration-window overrides: number (symmetric full width) or
    # {"left":hwL,"right":hwR} half-widths (asymmetric)
    def _winlr(p):
        w = p["window"]
        if isinstance(w, dict):
            return (float(w["left"]), float(w["right"]))
        return (float(w) / 2.0, float(w) / 2.0)
    windows = {float(p["mz"]): _winlr(p) for p in peaks_cfg if p.get("window")}
    # per-cycle Raw traces + apexes via the same pass analyze uses. These traces
    # are the EXACT analyze Raw (window-sum for isolated peaks, deconvolution for
    # overlapping ones) and drive all live recompute.
    apexes, raw_traces = {}, {}
    if masses:
        real_ranges = not (len(ranges) == 1 and ranges[0]["label"] == "All")
        per_range = ({r["label"]: (r["start"], r["end"]) for r in ranges}
                     if real_ranges and not analysis_settings["whole_run_windows"]
                     else None)
        traces, (a, b) = ptrms.extract_traces(
            f, masses, R=R, R_phys=R_phys, windows=windows or None,
            per_range=per_range)
        apexes = {m: ap for m, (_, ap) in traces.items()}
        raw_traces = {m: raw for m, (raw, _) in traces.items()}
    clustered = set()
    for g in (ptrms._cluster(masses) if masses else []):
        if len(g) > 1:
            clustered.update(g)

    resolved = ptrms.resolve_k(peaks_cfg, ptrms.load_rate_constants())

    # run mass scale (measured apex / assigned m/z) for formula candidate matching
    drift_vals = [apexes[m] / m for m in masses if apexes.get(m)]
    drift = float(np.median(drift_vals)) if drift_vals else 1.0
    sorted_mz = sorted(masses)

    def obs_ratios(apex):
        def wsum(center):
            wl, wr = ptrms.peak_window(center, a, b, R)
            lo, hi = max(0, wl), min(len(avg), wr)
            return float(avg[lo:hi].sum()) if hi > lo else 0.0
        i0 = wsum(apex)
        if i0 <= 0:
            return None
        return (wsum(apex + formula_id.DM1) / i0, wsum(apex + formula_id.DM2) / i0)

    def nearest_other(m):
        best = None
        for x in sorted_mz:
            if x == m:
                continue
            if best is None or abs(x - m) < abs(best - m):
                best = x
        return best

    peaks = []
    for idx, p in enumerate(peaks_cfg):
        m = float(p["mz"])
        info = resolved.get(m, {})
        apex = float(apexes.get(m, m))
        win_manual = p.get("window") is not None
        winL, winR = _winlr(p) if win_manual else (apex / (2.0 * R), apex / (2.0 * R))
        # scored formula candidates + isotope evidence for the review UI
        cands = formula_id.score_peak(apex, drift, obs_ratios=obs_ratios(apex))
        id_conf = cands[0]["probability"] if cands else None
        id_amb = bool(cands and (cands[0]["probability"] < 0.6 or
                      (len(cands) > 1 and cands[0]["probability"] - cands[1]["probability"] < 0.2)))
        overlap = None
        nb = nearest_other(m)
        if nb is not None:
            sep = abs(nb - m)
            if sep < m / R_phys * 1.5:
                overlap = {"neighbor": round(nb, 4), "sep_mDa": round(sep * 1000, 1), "level": "unresolved"}
            elif sep < 0.20:
                overlap = {"neighbor": round(nb, 4), "sep_mDa": round(sep * 1000, 1), "level": "deconvolved"}
        peaks.append({
            "id": idx,
            "mz": round(m, 4),
            "apex": round(apex, 4),
            "label": p.get("label") or p.get("formula") or f"m{m:.3f}",
            "formula": p.get("formula", ""),
            "k": p.get("k") if p.get("k") is not None else info.get("k"),
            "k_estimated": (bool(p.get("k_estimated")) if p.get("k") is not None
                            else bool(info.get("k_estimated"))),
            "flags": info.get("flags", []),
            "clustered": m in clustered,
            "win_l": round(winL, 5), "win_r": round(winR, 5),  # integration half-widths (m/z)
            "win_manual": win_manual,
            "candidates": cands,
            "id_confidence": id_conf,
            "id_ambiguous": id_amb,
            "overlap": overlap,
            "trace": [round(float(x), 1) for x in raw_traces[m]],
        })

    def _clean(arr):
        if arr is None:
            return None
        return [None if not np.isfinite(x) else round(float(x), 5) for x in arr]

    href_default = None
    if humidity is not None:
        good = np.isfinite(humidity) & (humidity > 0)
        if good.any():
            href_default = round(float(np.median(humidity[good])), 5)

    return {
        "meta": {
            "file": os.path.abspath(f.filename) if hasattr(f, "filename") else "",
            "ncyc": ncyc, "dur": dur, "a": a, "b": b,
            "R": R, "R_phys": R_phys, "primary_mz": primary_mz,
            "preview_initial": {
                "R": R, "R_phys": R_phys, "primary_mz": primary_mz,
                "whole_run_windows": analysis_settings["whole_run_windows"],
            },
            "proton": ptrms.PROTON, "k_anchor": analysis_settings["k_anchor"],
            "kinetic": analysis_settings["kinetic"],
            "humidity_correct": analysis_settings["humidity_correct"],
            "humidity_p": analysis_settings["humidity_p"],
            "humidity_ref": analysis_settings["humidity_ref"],
            "whole_run_windows": analysis_settings["whole_run_windows"],
            "K_default": None if K is None else round(float(K), 4),
            "K_source": K_source,
            "K_file": None if file_K is None else round(float(file_K), 4),
            "K_file_source": "file acquisition calibration",
            "molar_volume": round(float(molar_volume), 4),
            "molar_volume_source": molar_volume_source,
            "molar_volume_file": round(float(file_molar_volume), 4),
            "molar_volume_file_source": file_molar_volume_source,
            "humidity_ref_default": href_default,
            "sources": analysis_settings["sources"],
            "humidity_ref_source": (analysis_settings["sources"].get("humidity_ref")
                                    if analysis_settings["humidity_ref"] is not None
                                    else "run median"),
            "transmission_available": ptrms.has_transmission(f),
            "primary_available": primary is not None,
            "concentration_available": primary is not None and K is not None,
        },
        "config_base": config_base or {},
        "transmission": {"masses": [round(float(x), 4) for x in tm],
                         "factors": [round(float(x), 5) for x in tf]},
        "per_cycle": {
            "primary": _clean(primary),
            "humidity": _clean(humidity),
            "discriminator": _clean(discriminator),
        },
        # full average spectrum (index = timebin; m/z = tb2m(index)); used for the
        # pannable spectrum plot and to rescale Raw when a peak is re-centred.
        "spectrum": [int(round(x)) for x in avg],
        "peaks": peaks,
        "ranges": ranges,
        "checklist": _normalise_checklist(checklist),
        "rate_constants": [
            {"name": c["name"], "formula": c["formula"], "mz": c["mz"],
             "k": c["k"], "k_estimated": bool(c.get("k_estimated")), "flags": c["flags"]}
            for c in ((ptrms.load_rate_constants() or {}).get("compounds", []))
        ],
    }


def render_html(data, config_path=None):
    payload = json.dumps(data, separators=(",", ":"))
    return (_TEMPLATE
            .replace("/*__DATA__*/", payload)
            .replace("/*__CFGPATH__*/", json.dumps(config_path or "")))


def serve(html, config_path, port=8765, timeout=1800, open_browser=True,
          run_analysis=None, spectrum_fn=None):
    """Serve the review app on localhost so the page can live-save the config.

    The page POSTs the current config to /save on every edit (written to
    config_path) and POSTs to /done when the expert finishes. If ``run_analysis``
    is given (a callable ``cfg -> summary_dict``), on /done the server runs it in
    a background thread WHILE STAYING UP, so the page can poll /status and show a
    spinner until the results file is ready. Returns
    (final_config_or_None, finished_bool, summary_or_None); blocks until the
    analysis finishes (after Done) or until ``timeout`` with no Done.
    Uses only the stdlib — no extra dependencies, keeps the no-install promise."""
    done = threading.Event()          # expert clicked Done
    analysis_done = threading.Event()  # background analysis finished
    closed = threading.Event()         # page acked the result (can shut down)
    state = {"config": None, "status": "editing", "summary": None, "error": None}

    def write_config(cfg):
        if cfg is not None and config_path:
            with open(config_path, "w", encoding="utf-8") as fh:
                json.dump(cfg, fh, indent=2)

    def _run(cfg):
        try:
            state["summary"] = run_analysis(cfg) if run_analysis else None
            state["status"] = "done"
        except Exception as e:               # surface to the page, don't crash the server
            state["error"] = str(e)
            state["status"] = "error"
        finally:
            analysis_done.set()

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def _send(self, code, body=b"", ctype="text/plain"):
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            if body:
                self.wfile.write(body)

        def _json(self, obj):
            self._send(200, json.dumps(obj).encode("utf-8"), "application/json")

        def do_GET(self):
            if self.path in ("/", "/index.html"):
                self._send(200, html.encode("utf-8"), "text/html; charset=utf-8")
            elif self.path == "/status":
                out = (state["summary"] or {}).get("out") if state["summary"] else None
                self._json({"status": state["status"], "out": out,
                            "error": state["error"]})
            elif self.path.startswith("/spectrum"):
                if spectrum_fn is None:
                    self._send(404)
                    return
                from urllib.parse import urlparse, parse_qs
                q = parse_qs(urlparse(self.path).query)
                try:
                    lo = int(q.get("lo", ["1"])[0]); hi = int(q.get("hi", ["1"])[0])
                    spec = spectrum_fn(lo, hi)
                    self._send(200, json.dumps(spec).encode("utf-8"), "application/json")
                except Exception as e:
                    self._send(500, str(e).encode("utf-8"))
            else:
                self._send(404)

        def do_POST(self):
            n = int(self.headers.get("Content-Length", 0) or 0)
            raw = self.rfile.read(n) if n else b"{}"
            try:
                cfg = json.loads(raw.decode("utf-8"))
            except Exception:
                cfg = None
            if self.path == "/save":
                write_config(cfg)
                self._json({"ok": True})
            elif self.path == "/done":
                if cfg is not None:
                    state["config"] = cfg
                    write_config(cfg)
                if run_analysis is not None:
                    state["status"] = "running"
                    threading.Thread(target=_run, args=(cfg,), daemon=True).start()
                else:
                    state["status"] = "done"
                    analysis_done.set()
                self._json({"ok": True})
                done.set()
            elif self.path == "/open":           # open the results file in the OS default app
                out = (state["summary"] or {}).get("out") if state["summary"] else None
                ok = False
                if out and os.path.exists(out):
                    try:
                        if sys.platform == "darwin":
                            subprocess.Popen(["open", out])
                        elif os.name == "nt":
                            os.startfile(out)  # type: ignore[attr-defined]
                        else:
                            subprocess.Popen(["xdg-open", out])
                        ok = True
                    except Exception:
                        ok = False
                self._json({"ok": ok})
                closed.set()                     # user is done — let the server shut down
            elif self.path == "/ack":            # page displayed the result
                self._json({"ok": True})
                closed.set()
            else:
                self._send(404)

    httpd = None
    for p in range(port, port + 20):
        try:
            httpd = socketserver.ThreadingTCPServer(("127.0.0.1", p), Handler)
            port = p
            break
        except OSError:
            continue
    if httpd is None:
        raise OSError("no free port found for the review server")
    httpd.daemon_threads = True
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{port}/"
    print(f"ptr: review app running at {url}", file=sys.stderr)
    print("ptr: open it, adjust the analysis, then click 'Done' (changes auto-save "
          f"to {config_path}).", file=sys.stderr)
    if open_browser:
        try:
            webbrowser.open(url)
        except Exception:
            pass
    finished = done.wait(timeout)
    if finished:
        analysis_done.wait()      # let the background analysis complete
        # Stay up until the page acks (user clicked 'Open results' / closed the tab).
        # A generous cap so a user who reads the results for a few minutes before
        # clicking 'Open' still gets the file opened — the old 60 s window meant a
        # late click hit a dead server and nothing opened. The page acks on unload,
        # so a normal close still shuts us down promptly.
        closed.wait(600)
    httpd.shutdown()
    return state["config"], finished, state["summary"]


# ---------------------------------------------------------------------------
# Single-file app.  Vanilla JS + <canvas>; no external assets, works offline.
# Recompute mirrors ptrms.quantify():
#   Raw(t)      = Σ spectrum over the peak's window timebins  (per-cycle trace)
#   Corrected(t)= Raw(t) / Transmission(apex)
#   Conc(t)     = Corrected(t) * K / primary(t) * (k_anchor/k) * humidityFactor(t)
#   Conc[ug](t) = Conc(t) * (mz - proton) / Vm
# ---------------------------------------------------------------------------
_TEMPLATE = r"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PTR-MS analysis review</title>
<style>
  :root, :root[data-theme="dark"]{
    --bg:#0d1117; --panel:#161b22; --panel2:#0e131a; --line:#293240; --line2:#1e2530;
    --fg:#e8eef5; --mut:#8b98a8; --acc:#3b82f6; --acc2:#60a5fa; --prose:#c7d2de; --codefg:#9fb4c9;
    --hi:#f59e0b; --ok:#34d399;
    --hover:#182130; --sel:#16233a; --btn:#1c2430; --btnh:#212b39; --barbg:#1b2532;
    --headtop:#121821; --onacc:#04121f; --scrim:rgba(6,9,13,.55); --okbg:#10221a; --code:#0b1017;
    --shadow:0 1px 0 rgba(255,255,255,.02),0 6px 20px rgba(0,0,0,.28);
  }
  :root[data-theme="light"]{
    --bg:#f5f7fb; --panel:#ffffff; --panel2:#eef2f8; --line:#d6dee8; --line2:#e6ebf1;
    --fg:#1b2530; --mut:#5c6775; --acc:#2563eb; --acc2:#1d4ed8; --prose:#33404e; --codefg:#2f5573;
    --hi:#b45309; --ok:#047857;
    --hover:#eef3f9; --sel:#e2ecfb; --btn:#eef2f7; --btnh:#e2e8f1; --barbg:#e4e9f0;
    --headtop:#ffffff; --onacc:#ffffff; --scrim:rgba(30,41,59,.28); --okbg:#e7f6ee; --code:#eef2f8;
    --shadow:0 1px 0 rgba(255,255,255,.6),0 6px 18px rgba(30,41,59,.10);
  }
  /* system mode: no data-theme attribute -> follow the OS preference */
  @media (prefers-color-scheme: light){
    :root:not([data-theme]){
      --bg:#f5f7fb; --panel:#ffffff; --panel2:#eef2f8; --line:#d6dee8; --line2:#e6ebf1;
      --fg:#1b2530; --mut:#5c6775; --acc:#2563eb; --acc2:#1d4ed8; --prose:#33404e; --codefg:#2f5573;
      --hi:#b45309; --ok:#047857;
      --hover:#eef3f9; --sel:#e2ecfb; --btn:#eef2f7; --btnh:#e2e8f1; --barbg:#e4e9f0;
      --headtop:#ffffff; --onacc:#ffffff; --scrim:rgba(30,41,59,.28); --okbg:#e7f6ee; --code:#eef2f8;
      --shadow:0 1px 0 rgba(255,255,255,.6),0 6px 18px rgba(30,41,59,.10);
    }
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);
       font:13.5px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
  header{display:flex;align-items:baseline;gap:14px;padding:13px 22px;
         border-bottom:1px solid var(--line);background:linear-gradient(180deg,var(--headtop),var(--bg))}
  header h1{font-size:15px;margin:0;font-weight:650;letter-spacing:.2px}
  header .file{font-weight:550}
  header .meta{color:var(--mut);font-size:12px}
  .wrap{padding:16px 22px}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:12px;
        box-shadow:var(--shadow);overflow:hidden}
  .card h2{font-size:11px;text-transform:uppercase;letter-spacing:.07em;color:var(--mut);
           margin:0;padding:11px 15px;border-bottom:1px solid var(--line);
           display:flex;align-items:center;gap:10px;font-weight:700}
  .card h2 .sub{text-transform:none;letter-spacing:0;font-weight:400;color:var(--mut);font-size:11.5px}
  .card h2 .grow{flex:1}
  .pad{padding:14px 15px}
  canvas{width:100%;display:block;background:var(--panel2)}
  #plot{cursor:grab} #plot.grabbing{cursor:grabbing}
  .stale{margin:10px 14px 0;padding:10px 12px;border:2px solid #f59e0b;border-radius:8px;
    background:rgba(245,158,11,.14);color:var(--fg);font-size:12px;line-height:1.45}
  .stale b{color:var(--hi)}
  .plotfoot{padding:9px 15px;color:var(--mut);font-size:11.5px;border-top:1px solid var(--line);
            display:flex;gap:14px;align-items:center;flex-wrap:wrap}
  .legs{display:inline-flex;gap:16px;align-items:center;flex-wrap:wrap}
  .legend{display:inline-flex;align-items:center;gap:6px}
  .swatch{width:13px;height:3px;border-radius:2px;display:inline-block}
  .row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
  .row+.row{margin-top:10px}
  label.ctl{color:var(--mut);font-size:12px;display:inline-flex;gap:7px;align-items:center}
  /* professional inputs */
  input[type=text],input[type=number],select{
    background:var(--panel2);color:var(--fg);border:1px solid var(--line);border-radius:8px;
    padding:6px 9px;font-size:12.5px;outline:none;transition:border-color .12s,box-shadow .12s}
  input:focus,select:focus{border-color:var(--acc);box-shadow:0 0 0 3px rgba(59,130,246,.18)}
  input[type=text]{width:130px} input.mz{width:96px}
  input[type=number]{width:74px;text-align:right}
  input[type=number]::-webkit-inner-spin-button,input[type=number]::-webkit-outer-spin-button{-webkit-appearance:none;margin:0}
  input[type=number]{-moz-appearance:textfield}
  button{background:var(--btn);color:var(--fg);border:1px solid var(--line);border-radius:8px;
         padding:6px 13px;font-size:12.5px;cursor:pointer;transition:border-color .12s,background .12s}
  button:hover{border-color:var(--acc);background:var(--btnh)}
  button.primary{background:var(--acc);border-color:var(--acc);color:var(--onacc);font-weight:700;padding:8px 18px}
  button.primary:hover{background:var(--acc2)}
  button.ghost{background:transparent}
  .tabs{display:inline-flex;gap:3px;background:var(--panel2);border:1px solid var(--line);
        border-radius:9px;padding:3px}
  .tabs button{border:0;background:transparent;padding:5px 12px;border-radius:6px;color:var(--mut)}
  .tabs button.on{background:var(--acc);color:var(--onacc);font-weight:700}
  .tabs.big button{padding:6px 15px;font-size:12.5px;font-weight:600}
  table{width:100%;border-collapse:collapse;font-size:12px}
  th,td{text-align:right;padding:6px 9px;border-bottom:1px solid var(--line2);white-space:nowrap}
  th{color:var(--mut);font-weight:600;position:sticky;top:0;background:var(--panel);z-index:1}
  th:first-child,td:first-child,td.l,th.l{text-align:left}
  tbody tr{cursor:pointer} tbody tr:hover td{background:var(--hover)}
  tr.sel td{background:var(--sel)}
  .pill{font-size:10px;padding:1px 7px;border-radius:999px;border:1px solid var(--line);color:var(--mut)}
  .pill.humid{color:#7dd3fc;border-color:#155e75} .pill.clus{color:var(--hi);border-color:#78491a}
  .pill.frag{color:#c4b5fd;border-color:#4c3a78} .pill.hi{color:var(--hi);border-color:#78491a}
  .pill.ovl{color:#fca5a5;border-color:#7f1d1d}
  .warn{color:var(--hi)} .mut{color:var(--mut)}
  .scroll{max-height:260px;overflow:auto}
  small.k{color:var(--mut);font-size:11px}
  .readout{font-variant-numeric:tabular-nums}
  .iconbtn{padding:2px 8px;background:transparent;border-color:transparent;color:var(--mut)}
  .iconbtn:hover{color:#f87171;border-color:var(--line);background:transparent}
  .stat{font-size:11.5px;color:var(--ok)}
  /* identification candidates */
  .cand{display:flex;align-items:center;gap:10px;padding:6px 9px;border:1px solid var(--line2);
        border-radius:8px;margin-bottom:6px;cursor:pointer;background:var(--panel2)}
  .cand:hover{border-color:var(--acc)}
  .cand.chosen{border-color:var(--ok);background:var(--okbg)}
  .cand .f{font-weight:650;min-width:78px;font-variant-numeric:tabular-nums}
  .cand .cname{font-weight:600;color:var(--fg);flex:0 1 auto;min-width:0;
               overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .cand .meta{color:var(--mut);font-size:11px;min-width:150px}
  .cand .bar{flex:1;min-width:60px;height:8px;background:var(--barbg);border-radius:99px;overflow:hidden}
  .cand .bar>span{display:block;height:100%;background:var(--acc)}
  .cand .p{min-width:38px;text-align:right;font-variant-numeric:tabular-nums;font-weight:600}
  .cand .ev{color:var(--mut);font-size:11px;min-width:172px;text-align:right;font-variant-numeric:tabular-nums}
  .cand .ok{color:var(--ok)} .cand .bad{color:#f87171}
  .idnote{padding:7px 9px;margin-bottom:8px;border:1px solid var(--line2);border-radius:8px;
          color:var(--mut);font-size:11px;line-height:1.45}
  .idnote b{color:var(--fg)}
  .pill.assigned{color:var(--ok);border-color:var(--ok)}
  .pill.unassigned{color:var(--hi);border-color:#78491a}
  code{background:var(--code);border:1px solid var(--line);border-radius:5px;padding:1px 5px;
       font:11px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--codefg);word-break:break-all}
  /* Done overlay */
  #doneov{position:fixed;inset:0;background:rgba(6,9,13,.86);display:flex;align-items:center;
          justify-content:center;z-index:50;backdrop-filter:blur(3px)}
  .ovcard{background:var(--panel);border:1px solid var(--line);border-radius:16px;
          padding:34px 40px;max-width:480px;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,.5)}
  .ovcard h2{font-size:18px;margin:16px 0 6px;font-weight:650}
  .ovcard p{margin:6px 0}
  .spinner{width:46px;height:46px;margin:0 auto;border-radius:50%;
           border:4px solid #223142;border-top-color:var(--acc);animation:spin .8s linear infinite}
  @keyframes spin{to{transform:rotate(360deg)}}
  .bar{height:6px;background:#1b2532;border-radius:99px;overflow:hidden;margin:20px 0 8px}
  .barfill{height:100%;width:38%;border-radius:99px;
           background:linear-gradient(90deg,transparent,var(--acc),transparent);animation:slide 1.3s ease-in-out infinite}
  @keyframes slide{0%{margin-left:-40%}100%{margin-left:100%}}
  .check{width:54px;height:54px;margin:0 auto;border-radius:50%;background:rgba(52,211,153,.14);
         border:2px solid var(--ok);color:var(--ok);font-size:27px;line-height:52px;font-weight:700}
  .xmark{width:54px;height:54px;margin:0 auto;border-radius:50%;background:rgba(248,113,113,.14);
         border:2px solid #f87171;color:#f87171;font-size:27px;line-height:52px;font-weight:700}
  /* app layout: peaks sidebar + main */
  header .grow{flex:1}
  .hbtn{background:transparent;border:1px solid var(--line);color:var(--mut);border-radius:8px;
        padding:6px 11px;font-size:12.5px;cursor:pointer}
  .hbtn:hover{border-color:var(--acc);color:var(--fg)}
  .hbtn:disabled{opacity:.4;cursor:default}
  .hbtn.ic{padding:5px 9px;font-size:15px;line-height:1}
  .themewrap{position:relative;display:inline-flex}
  .menu{position:absolute;top:calc(100% + 6px);right:0;z-index:50;min-width:150px;
        background:var(--panel);border:1px solid var(--line);border-radius:10px;
        box-shadow:var(--shadow);padding:5px;display:flex;flex-direction:column;gap:2px}
  .menu button{display:flex;align-items:center;gap:8px;justify-content:flex-start;text-align:left;
        width:100%;background:transparent;border:0;border-radius:7px;padding:7px 10px;
        color:var(--fg);font-size:12.5px}
  .menu button:hover{background:var(--hover);border-color:transparent}
  .menu button.on{color:var(--acc2)} .menu button.on::after{content:"✓";margin-left:auto;color:var(--acc2)}
  .app{display:grid;grid-template-columns:320px minmax(0,1fr);gap:16px;padding:16px 22px;align-items:start;
       transition:grid-template-columns .28s cubic-bezier(.4,0,.2,1)}
  @media(max-width:900px){.app{grid-template-columns:1fr}}
  .sidebar{position:sticky;top:16px}
  .main>.card+.card{margin-top:16px}
  .hint{padding:9px 14px;color:var(--mut);font-size:11px;border-top:1px solid var(--line)}
  /* peak list — one row per peak; 'details' reveals extra columns to the right
     without moving the rows (same <li>, extra cells appended) */
  .plist{list-style:none;margin:0;padding:4px 0}
  .plist li{display:flex;flex-wrap:nowrap;align-items:center;gap:8px;padding:5px 12px;
            cursor:pointer;border-left:2px solid transparent}
  .plist li:hover{background:var(--hover)}
  .plist li.sel{background:var(--sel);border-left-color:var(--hi)}
  /* fixed-width compound-name column so it doesn't shrink when 'details' opens */
  .plist input.lbl{flex:0 0 auto;width:158px;border:1px solid transparent;background:transparent;
       color:var(--fg);padding:3px 6px;font-size:12.5px;border-radius:6px;font-family:inherit;
       overflow:hidden;text-overflow:ellipsis;outline:none;cursor:pointer}
  .plist input.lbl:not([readonly]){cursor:text}          /* selected row: editable -> text caret */
  .plist li.off input.lbl{opacity:.4;text-decoration:line-through}
  .plist input.lbl:not([readonly]):hover{border-color:var(--line)}
  .plist input.lbl:not([readonly]):focus{border-color:var(--acc);background:var(--panel2)}
  .plist .sp{flex:1 1 0;min-width:0}
  .plist .mini{font-size:10.5px;color:var(--mut);font-variant-numeric:tabular-nums}
  .plist .mz{flex:0 0 auto;min-width:52px;text-align:right}
  .plist .dot{width:7px;height:7px;border-radius:50%;flex:0 0 auto;background:#2b3644}
  .plist .dot.amb{background:var(--hi)} .plist .dot.ovl{background:#f87171}
  .plist .go{flex:0 0 auto;color:var(--mut);opacity:0;font-size:15px;line-height:1;transition:opacity .1s}
  .plist li:hover .go{opacity:.7} .plist li.sel .go{opacity:1;color:var(--hi)}
  /* detail columns (revealed by the 'details' toggle) */
  .plist .dc{flex:0 0 auto;font-size:10.5px;color:var(--mut);font-variant-numeric:tabular-nums}
  .plist .dc.dmda{min-width:58px;text-align:right} .plist .dc.dmda.warn{color:#f87171}
  .plist .dc.kv{min-width:50px;text-align:right}
  .plist .dc.win{min-width:92px;text-align:right}
  .plist .dc.pills{display:flex;gap:4px;flex:1 1 0;min-width:0;overflow:hidden}
  .plist .dc.del{cursor:pointer;color:var(--mut);background:none;border:0;font-size:12px;padding:2px 4px}
  .plist .dc.del:hover{color:#f87171}
  /* configuration slide-over */
  #cfgscrim{position:fixed;inset:0;background:var(--scrim);z-index:40;backdrop-filter:blur(2px)}
  #cfgpanel,#methodpanel{position:fixed;top:0;right:0;height:100%;background:var(--panel);
            border-left:1px solid var(--line);box-shadow:-14px 0 44px rgba(0,0,0,.45);z-index:41;
            padding:18px 22px;overflow:auto}
  #cfgpanel{width:370px} #methodpanel{width:520px;max-width:92vw}
  #cfgpanel h2,#methodpanel h2{font-size:14px;margin:0 0 4px;display:flex;align-items:center;gap:8px;font-weight:650}
  #cfgpanel .grp{border:1px solid var(--line2);border-radius:10px;padding:12px 14px;margin-top:14px}
  #cfgpanel .grp h3{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--mut);margin:0 0 10px}
  #cfgpanel input[type=text]{width:110px;text-align:right}
  #methodpanel h3{font-size:12.5px;margin:20px 0 5px;color:var(--acc2);font-weight:650}
  #methodpanel p{margin:9px 0;font-size:12.5px;line-height:1.6;color:var(--prose)}
  #methodpanel li{font-size:12.5px;line-height:1.55;color:var(--prose);margin:2px 0}
  #methodpanel b{color:var(--fg)} #methodpanel .lead{color:var(--mut)}
  [hidden]{display:none!important}
  /* intervals table: give the label plenty of room */
  #rngtbl{table-layout:fixed}
  #rngtbl th:first-child,#rngtbl td:first-child{width:56%}
  #rngtbl th:nth-child(2),#rngtbl td:nth-child(2){width:28%}
  #rngtbl input.lbl,#rngtbl select{width:100%}
  /* header count badge (checklist) */
  .badge{display:inline-block;min-width:16px;padding:0 5px;margin-left:2px;border-radius:999px;
         background:var(--acc);color:var(--onacc);font-size:10.5px;font-weight:700;
         text-align:center;line-height:16px;vertical-align:1px}
  .badge.done{background:var(--ok)}
  /* review checklist slide-over (shares the cfg/method scrim) */
  #checkpanel{position:fixed;top:0;right:0;height:100%;width:400px;max-width:92vw;background:var(--panel);
        border-left:1px solid var(--line);box-shadow:-14px 0 44px rgba(0,0,0,.45);z-index:41;
        padding:18px 22px;overflow:auto}
  #checkpanel h2{font-size:14px;margin:0 0 4px;display:flex;align-items:center;gap:8px;font-weight:650}
  .clprog{font-size:11.5px;color:var(--mut);margin:14px 0 6px}
  .cl{list-style:none;margin:0;padding:0}
  .cl li{display:flex;gap:11px;align-items:flex-start;padding:11px 12px;border:1px solid var(--line2);
         border-radius:10px;margin-bottom:8px;background:var(--panel2);cursor:pointer;transition:border-color .12s}
  .cl li:hover{border-color:var(--acc)}
  .cl li.done{opacity:.55}
  .cl li.done .cltext{text-decoration:line-through}
  .cl input[type=checkbox]{margin:2px 0 0;width:16px;height:16px;accent-color:var(--acc);cursor:pointer;flex:0 0 auto}
  .cl .cltext{font-size:12.5px;line-height:1.5;color:var(--fg)}
  .cl .cldetail{display:block;color:var(--mut);font-size:11.5px;margin-top:3px;line-height:1.5}
  /* onboarding tour: full-screen click-catcher + spotlight ring + popover */
  #tourblock{position:fixed;inset:0;z-index:60}
  #tourspot{position:fixed;z-index:61;border-radius:12px;pointer-events:none;
        box-shadow:0 0 0 3px var(--acc),0 0 0 9999px var(--scrim);
        transition:left .25s cubic-bezier(.4,0,.2,1),top .25s cubic-bezier(.4,0,.2,1),
                   width .25s cubic-bezier(.4,0,.2,1),height .25s cubic-bezier(.4,0,.2,1)}
  #tourpop{position:fixed;z-index:62;max-width:300px;background:var(--panel);border:1px solid var(--line);
        border-radius:12px;box-shadow:0 18px 50px rgba(0,0,0,.5);padding:15px 17px;
        transition:left .2s ease,top .2s ease}
  #tourpop h3{margin:0 0 6px;font-size:13.5px;font-weight:650}
  #tourpop p{margin:0;font-size:12.5px;line-height:1.55;color:var(--mut)}
  #tourpop .trow{display:flex;align-items:center;gap:8px;margin-top:15px}
  #tourpop .tstep{font-size:11px;color:var(--mut);font-variant-numeric:tabular-nums}
  #tourpop .grow{flex:1}
  #tourpop button{padding:5px 12px}
  /* spinner shown over the plot while an interval's mass spectrum is averaged */
  #specspin{position:absolute;top:46px;left:50%;transform:translateX(-50%);z-index:20;
        display:flex;align-items:center;gap:9px;padding:8px 14px;border-radius:10px;
        background:var(--panel);border:1px solid var(--line);box-shadow:0 8px 24px rgba(0,0,0,.28);
        font-size:12px;color:var(--mut)}
  .spin{width:15px;height:15px;border-radius:50%;border:2px solid var(--line);
        border-top-color:var(--acc);animation:spinrot .7s linear infinite}
  @keyframes spinrot{to{transform:rotate(360deg)}}
</style>
</head>
<body>
<header>
  <h1>PTR-MS review</h1>
  <span class="file" id="file"></span>
  <span class="meta" id="meta"></span>
  <span class="grow"></span>
  <span class="stat" id="savestat"></span>
  <button class="hbtn" id="undoBtn" title="Undo (⌘/Ctrl-Z)" disabled>↶ Undo</button>
  <span class="themewrap">
    <button class="hbtn ic" id="themeBtn" title="Theme" aria-haspopup="true">🌙</button>
    <div class="menu" id="thememenu" hidden>
      <button data-theme="light">☀️&nbsp; Light</button>
      <button data-theme="dark">🌙&nbsp; Dark</button>
      <button data-theme="system">🖥&nbsp; System</button>
    </div>
  </span>
  <button class="hbtn" id="checkBtn" title="Review checklist" hidden>📋 Checklist <span class="badge" id="checkbadge"></span></button>
  <button class="hbtn" id="methodBtn" title="How the analysis works">📖 Method</button>
  <button class="hbtn" id="cfgBtn" title="Configuration">⚙ Configuration</button>
  <button class="hbtn ic" id="tourBtn" title="Show the guided tour">❔</button>
  <span id="exportrow"></span>
</header>

<div class="app" id="app">
  <!-- peaks: the central control, always in view -->
  <aside class="sidebar">
    <div class="card">
      <h2>Peaks <span class="mut" id="pkcount" style="font-weight:400"></span>
        <span class="grow"></span>
        <button class="ghost" id="pkdetails">details</button></h2>
      <div class="scroll" id="peaksbody" style="max-height:calc(100vh - 190px);overflow-x:hidden"></div>
      <div class="hint">Click a peak to select &amp; zoom · ⌘/Ctrl-drag the mass spectrum to add · remove via ✕ in details</div>
    </div>
  </aside>

  <main class="main">
  <!-- one big tabbed plot; overview inset lives in its corner -->
  <div class="card" style="position:relative">
    <div id="stalebanner" class="stale" hidden role="alert"></div>
    <h2>
      <span class="tabs big" id="maintabs">
        <button data-tab="trace" class="on">Signal over time</button>
        <button data-tab="spec">Mass spectrum</button>
      </span>
      <span class="sub" id="plotsub">— the selected peak's intensity across the run (when it appears)</span>
      <label class="ctl" id="specrangewrap" style="margin-left:4px">average over
        <select id="specrange" style="width:auto"></select></label>
      <span class="grow"></span>
      <span class="tabs" id="qtabs" style="display:none">
        <button data-q="raw" class="on">Raw</button>
        <button data-q="cor">Corrected</button>
        <button data-q="con">Conc</button>
        <button data-q="ug">Conc µg</button>
      </span>
    </h2>
    <canvas id="plot" data-h="540"></canvas>
    <div id="specspin" hidden><span class="spin"></span><span id="specspinmsg">averaging interval…</span></div>
    <div class="plotfoot">
      <button class="ghost" id="zoomout">− zoom out</button>
      <button class="ghost" id="zoomin">+ zoom in</button>
      <button class="ghost" id="zoomreset">reset view</button>
      <span class="legs" id="leg-spec">
        <span class="legend"><span class="swatch" style="background:#60a5fa"></span>spectrum</span>
        <span class="legend"><span class="swatch" style="background:rgba(96,165,250,.28)"></span>integration window</span>
        <span class="legend"><span class="swatch" style="background:var(--hi)"></span>selected peak</span>
      </span>
      <span class="legs" id="leg-trace" style="display:none">
        <span class="legend" id="leg-trace-line"><span class="swatch" style="background:#3b82f6"></span><span id="tracelbl">Raw</span> of <span id="traceof" class="mut">—</span></span>
        <span class="legend" title="Per-cycle composite of the strong VOC traces, each normalised to its own baseline so no single ion dominates — about 1 during background and rising during a sample. The sample/background intervals are detected from this curve; it is a detector for when signal is present, not itself a concentration."><span class="swatch" style="background:#39424e"></span>composite VOC signal</span>
        <span class="legend"><span class="swatch" style="background:rgba(245,158,11,.35)"></span>sample</span>
        <span class="legend"><span class="swatch" style="background:rgba(100,116,139,.35)"></span>background</span>
      </span>
      <span class="grow"></span>
      <span class="mut" id="spechint">drag to pan · scroll to zoom · sideways-scroll to pan · click a peak to zoom · ⌘/Ctrl-drag to add a peak · double-click to move its centre · drag the overview</span>
      <span class="mut" id="tracehint" style="display:none">drag to pan · scroll to zoom · sideways-scroll to pan · drag an interval edge to resize · ⌘/Ctrl-drag to add · Del to remove selected</span>
    </div>
  </div>

  <!-- context card: identification (spectrum tab) -->
  <div class="card" id="idcard">
    <h2>Identification <span class="sub">— candidate formulas for the selected peak (click to assign)</span>
      <span class="grow"></span><span class="mut" id="idconf"></span></h2>
    <div class="pad" id="idpanel"><div class="mut">Select a peak to see candidate formulas, ranked by measured exact mass, isotope evidence, and chemistry plausibility.</div></div>
  </div>

  <!-- context card: intervals (signal-over-time tab); positions set by dragging in the plot -->
  <div class="card" id="intcard">
    <h2>Intervals <span class="sub">— name / classify; drag edges in the plot to set the range</span></h2>
    <div class="scroll">
      <table id="rngtbl"><thead><tr><th class="l">label</th><th class="l">class</th><th>cycles</th></tr></thead><tbody></tbody></table>
    </div>
    <div class="hint">⌘/Ctrl-drag the plot to add · click to select, then Del to remove</div>
  </div>
  </main>
</div>

<!-- Review checklist slide-over (hidden by default): agent-authored points to confirm -->
<div id="checkpanel" hidden>
  <h2>📋 Review checklist <span class="grow"></span><button class="hbtn" id="checkClose">✕</button></h2>
  <p class="mut" style="font-size:11.5px;margin:2px 0 0">Things the analysis flagged for you to confirm — beyond eyeballing the peaks and intervals. Tick them off as you go (saved in this browser).</p>
  <div id="checkbody"></div>
</div>

<!-- Configuration slide-over (hidden by default): settings not set via the plot -->
<div id="cfgscrim" hidden></div>
<div id="cfgpanel" hidden>
  <h2>Configuration <span class="grow"></span><button class="hbtn" id="cfgClose">✕</button></h2>
  <p class="mut" style="font-size:11.5px;margin:2px 0 0">Values that can't be set by interacting with the plot. R, K, molar volume, and correction controls update the preview; primary m/z, R<sub>phys</sub>, and window mode are applied to the raw file on Done.</p>
  <div class="grp">
    <h3>Concentration calibration</h3>
    <div class="row">
      <label class="ctl">K <input type="text" inputmode="decimal" id="K" step="0.1"></label>
      <label class="ctl">Vₘ <input type="text" inputmode="decimal" id="Vm" step="0.01"></label>
      <button class="ghost" id="resetK">reset to file</button>
    </div>
    <div class="row mut" id="calnote" style="font-size:11px"></div>
  </div>
  <div class="grp">
    <h3>Integration</h3>
    <div class="row">
      <label class="ctl">default window R <input type="text" inputmode="decimal" id="R" step="50"></label>
      <label class="ctl">R<sub>phys</sub> <input type="text" inputmode="decimal" id="Rphys" step="50"></label>
    </div>
    <div class="row">
      <label class="ctl">primary m/z <input type="text" inputmode="decimal" id="primarymz" step="0.001"></label>
      <label class="ctl"><input type="checkbox" id="wholewindows"> whole-run windows</label>
    </div>
    <p class="mut" style="font-size:11px;margin:8px 0 0">Per-peak windows are set by dragging the dashed handles in the spectrum.</p>
  </div>
  <div class="grp">
    <h3>Per-compound sensitivity (kinetic)</h3>
    <div class="row">
      <label class="ctl"><input type="checkbox" id="kinetic"> enable</label>
    </div>
    <div class="row">
      <label class="ctl">k-anchor <input type="text" inputmode="decimal" id="kanchor" step="0.1"></label>
    </div>
    <p class="mut" style="font-size:11px;margin:8px 0 0">Scales each compound by its own proton-transfer rate constant <b>k</b> for more physically accurate concentrations, instead of assuming one sensitivity for all. When enabled, it runs in a hybrid mode: a compound uses its own k only when that k is <b>measured</b>; where k is estimated or unknown it stays on the shared K (the <b>~</b> mark in the Identification card flags an estimated k).</p>
    <p class="mut" style="font-size:11px;margin:7px 0 0">Disabled, every compound shares the single constant K — one sensitivity for all, matching a standard reference export.</p>
  </div>
  <div class="grp">
    <h3>Humidity correction</h3>
    <div class="row">
      <label class="ctl"><input type="checkbox" id="humid"> enable</label>
    </div>
    <div class="row">
      <label class="ctl">p <input type="text" inputmode="decimal" id="hump" step="0.05"></label>
      <label class="ctl">X_ref <input type="text" inputmode="decimal" id="href" step="0.001"></label>
    </div>
  </div>
</div>

<!-- Method slide-over: what happens behind the scenes -->
<div id="methodpanel" hidden>
  <h2>Method <span class="grow"></span><button class="hbtn" id="methodClose">✕</button></h2>
  <div id="methodlive"></div>
  <p class="lead" style="font-size:11.5px">How this tool turns the raw IONICON <code>.h5</code> into the concentrations you review here. Everything instrument-specific is read from the file; you curate the chemistry.</p>

  <h3>1 · Mass calibration &amp; drift</h3>
  <p>The instrument stores a 2-point calibration in <code>CALdata/Mapping</code> giving <b>timebin = a·√(m/z) + b</b>. Over a long run the true masses drift slightly, so we estimate one global scale factor (the median of measured-apex ÷ theoretical-mass across all peaks, ≈1.0008 here) and remove it. Each isolated peak then gets a tight local apex search to snap onto its exact centre. Clustered peaks instead use scale-corrected theoretical model centres so they don't jump onto a neighbour.</p>

  <h3>2 · Peak detection &amp; identification</h3>
  <p>Peaks are local maxima of the average spectrum above a relative-height threshold. For each, candidate <b>molecular formulas</b> are enumerated offline (all plausible CHNOPS+halogen formulas within ~12 mDa) and ranked by three independent lines of evidence: exact-mass error, the measured-vs-predicted <b>¹³C (M+1) and heteroatom (M+2, e.g. S/Cl) isotope pattern</b>, and plausibility (integer ring+double-bond equivalents, the nitrogen rule, element ratios). Near-isobars are told apart by composition, not "nearest mass". Names and isomer labels come from the bundled PTR Library mapping when the formula is known; formula ranking cannot determine structural isomers.</p>

  <h3>3 · Integration (Raw)</h3>
  <p><b>Isolated peaks:</b> Raw is a plain <b>window-sum</b> of the measured intensities across the peak's m/z window — no peak shape assumed, so asymmetric or flat-topped peaks are handled as-is. You set that window by dragging the dashed handles (left and right independently). The default R window setting is recomputed in the preview; the delivered CSV re-extracts it at full precision.</p>
  <p><b>Clustered peaks</b> (within ~0.2 Da) are Gaussian/deconvolved fitted components at fixed model centres; a component may not form a visible local maximum in every selected interval, so its model centre is not a measured apex. Their amplitudes are separated by <b>linear Gaussian deconvolution</b> (σ from the instrument resolution), rescaled back to the window-sum scale. Peaks closer than the resolution are flagged <i>unresolved</i> — their Raw is unreliable even after deconvolution.</p>

  <h3>4 · Transmission → Corrected</h3>
  <p>Ion transmission varies with m/z; the file's transmission curve gives the factor at each apex. <b>Corrected = Raw / transmission(apex)</b>.</p>

  <h3>5 · Concentration</h3>
  <p>Primary-ion-normalised model: <b>Conc[ppb] = Corrected · K / I<sub>primary</sub>(t)</b>, where I<sub>primary</sub> is the configured reagent-ion signal (m/z 21.022 by default) per cycle and <b>K</b> is one sensitivity constant. K is the only quantity not fixed by the raw file — the default is the file's own acquisition calibration; set it in Configuration (or calibrate against a reference). <b>Conc[µg/m³] = Conc · (m − proton) / V<sub>m</sub></b>, with molar volume V<sub>m</sub> from the drift-tube temperature.</p>

  <h3>6 · Optional corrections</h3>
  <p><b>Per-compound k (kinetic):</b> scales each compound by its own proton-transfer rate constant (Conc ∝ 1/k) relative to an anchor — physically more accurate than one shared sensitivity. When enabled, this runs in a hybrid mode: a compound is scaled by its own k only when that k is a <i>measured</i> value; compounds whose k is only estimated (or unknown) stay on the shared K, since applying an uncertain k would add error rather than remove it. Estimated k's are marked with <b>~</b> in the Identification card. <b>Humidity:</b> low-proton-affinity compounds (HCN, formaldehyde, formic acid…) have humidity-dependent sensitivity; flagged <i>humid-sensitive</i>, and optionally normalised by the per-cycle water-cluster ratio X = I(m37)/I(primary) raised to a power p — off by default.</p>

  <h3>7 · Time intervals</h3>
  <p>The signal is split into stable plateaus by log-space gradient detection on a composite VOC signal (high = sample, low = background/setup). You rename, reclassify, resize (drag edges), add (⌘/Ctrl-drag) and remove (select + Del) intervals. For each interval the CSV reports Max / Min / Average / Std-dev of Raw, Corrected, Conc and Conc[µg] per compound.</p>

  <h3>8 · What the CSV contains</h3>
  <p>One block per interval (with its cycle range and sample/background class), and within each block one row per compound giving its m/z, formula and the four quantities (Raw, Corrected, Conc[ppb], Conc[µg/m³]) summarised as Max/Min/Average/Std-dev. Raw is in detector counts per second (cps); Corrected is transmission-normalised cps; Conc is the quantified mixing ratio. The header records the calibration (a, b, K, V<sub>m</sub>, resolution) and which optional corrections were on, so the run is reproducible.</p>

  <h3>Assumptions &amp; limitations</h3>
  <ul>
    <li><b>One peak shape / resolution</b> across the spectrum — deconvolution of overlaps assumes a Gaussian of width σ set from the resolving power; genuinely non-Gaussian or coalesced peaks aren't modelled.</li>
    <li><b>Single sensitivity K</b> unless per-compound kinetic mode is on; the shared-K assumption is only exact for compounds with similar reaction rate constants.</li>
    <li><b>No fragmentation correction</b> — each peak is treated as a parent ion. Compounds that fragment (flagged where known) spread signal across masses that this tool does not recombine.</li>
    <li><b>Humidity dependence</b> is an optional, empirical normalisation, not a full ion-chemistry model; leave it off unless you have reason to apply it.</li>
    <li><b>Transmission and mass calibration</b> come from the file — if the instrument's stored values are off, so are the derived numbers.</li>
    <li><b>Identification is a ranking, not proof</b>: candidate percentages are relative score/share, not calibrated identification confidence; unresolved overlaps are flagged and the expert makes the final call.</li>
  </ul>

  <h3>Live preview vs. the delivered CSV</h3>
  <p>Many preview values update instantly using embedded data and window-sums, so isolated-peak edits are exact within that preview. Re-centred / re-windowed peaks show a <b>≈</b> (rescaled by the average-spectrum window ratio). Changes to primary m/z, R<sub>phys</sub>, or whole-run window mode cannot be re-extracted from the embedded data, especially in standalone HTML: the plots and Methods card mark those values <b>stale</b> and do not claim live numerical recomputation. Click <b>Done</b> (or hand the downloaded config to <code>ptr analyze</code>) to re-extract at the final settings. The resulting CSV is always authoritative.</p>
</div>

<script>
const DATA = /*__DATA__*/;
const CFGPATH = /*__CFGPATH__*/;
const SERVED = location.protocol.indexOf("http") === 0;
const M = DATA.meta, PC = DATA.per_cycle, SPEC = DATA.spectrum;
const A = M.a, B = M.b, NCYC = M.ncyc, NBIN = SPEC.length;
const m2tb = m => A*Math.sqrt(m)+B;
const tb2m = tb => Math.pow((tb-B)/A, 2);

let peaks = DATA.peaks.map(p => { const dw=p.apex/(2*DATA.meta.R);
  const l=(p.win_l!=null?p.win_l:dw), r=(p.win_r!=null?p.win_r:dw);
  return {...p, use:true, _apex0:p.apex, winL:l, winR:r, _winL0:l, _winR0:r, winManual:!!p.win_manual}; });
let ranges = DATA.ranges.map((r,i) => ({...r, _id:i}));
let nextRangeId = ranges.length;
let selRange = null;   // selected interval id
let selId = peaks.length ? peaks[0].id : null;
let nextId = peaks.reduce((a,p)=>Math.max(a,p.id),-1)+1;
// default the time trace to the actual deliverable (concentration) when available
let quant = M.concentration_available ? "con" : "cor";
let showDetails = false;   // peaks sidebar: labels only until 'details'
let hoverRange = null;     // interval hovered in the trace (to show its label)
let hoverPeakId = null;    // peak whose window is hovered in the spectrum (highlight, mirror of hoverRange)
const QSHORT = {raw:"Raw",cor:"Corrected",con:"Conc",ug:"Conc µg"};
// Effective settings were resolved by the CLI. PREVIEW_INITIAL is immutable: it
// records the extraction settings represented by the embedded data. cfg is the
// live/final configuration sent to save and to the authoritative Done rerun.
const initial=M.preview_initial||{R:M.R,R_phys:M.R_phys,primary_mz:M.primary_mz,
  whole_run_windows:M.whole_run_windows===true};
const PREVIEW_INITIAL=Object.freeze({R:initial.R,Rphys:initial.R_phys,
  primarymz:initial.primary_mz,wholewindows:initial.whole_run_windows===true});
const cfg = { R:M.R, Rphys:M.R_phys, primarymz:M.primary_mz, K:M.K_default,
              Vm:M.molar_volume, kinetic:M.kinetic===true, kanchor:M.k_anchor,
              humid:M.humidity_correct===true, hump:M.humidity_p??1.0,
              href:M.humidity_ref??M.humidity_ref_default,
              wholewindows:M.whole_run_windows===true };
let kSource = M.K_source || (M.sources||{}).K || "file acquisition calibration";
let vmSource = M.molar_volume_source || (M.sources||{}).molar_volume || "file drift temperature";

// ---- theme (light / dark / system) — persisted in localStorage, defaults to system ----
function themePref(){ try{ return localStorage.getItem("ptrms-theme")||"system"; }catch(e){ return "system"; } }
function resolvedDark(){ const m=themePref();
  if(m==="dark") return true; if(m==="light") return false;
  return !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches); }
let TH={};
function computeTH(){ TH = resolvedDark() ? {
    grid:"#202834",gridln:"#161d27",axis:"#6b7684",disc:"#39424e",
    insetBg:"rgba(9,13,19,.92)",insetStroke:"#2b3644",insetLine:"#4a5a6d",insetText:"#7c8794",
    labelDim:"#93a2b3",labelHi:"#f7b955",spec:"#60a5fa",trace:"#3b82f6",
    cross:"rgba(148,163,184,.5)",crossBg:"rgba(9,13,19,.9)",crossText:"#c4cdd8"
  } : {
    grid:"#c3ccd8",gridln:"#e7ecf2",axis:"#5c6775",disc:"#c2ccd8",
    insetBg:"rgba(255,255,255,.94)",insetStroke:"#cdd6e1",insetLine:"#9aa7b6",insetText:"#5c6775",
    labelDim:"#5c6775",labelHi:"#b45309",spec:"#2563eb",trace:"#2563eb",
    cross:"rgba(100,116,139,.55)",crossBg:"rgba(255,255,255,.93)",crossText:"#3c4756"
  }; }
function applyTheme(draw){ const m=themePref();
  if(m==="system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme",m);
  // icon-only button reflects the EFFECTIVE appearance (sun when light, moon when dark)
  const b=document.getElementById("themeBtn"); if(b){ b.textContent=resolvedDark()?"🌙":"☀️";
    b.title="Theme: "+m+(m==="system"?" ("+(resolvedDark()?"dark":"light")+")":""); }
  const menu=document.getElementById("thememenu");
  if(menu) menu.querySelectorAll("button").forEach(el=>el.classList.toggle("on",el.dataset.theme===m));
  computeTH(); if(draw && typeof drawMain==="function") drawMain(); }
function setTheme(m){ try{ localStorage.setItem("ptrms-theme",m); }catch(e){} applyTheme(true); }
applyTheme(false);   // set attribute + palette before the first paint
if(window.matchMedia){ const mq=window.matchMedia("(prefers-color-scheme: dark)");
  const onc=()=>{ if(themePref()==="system") applyTheme(true); };
  mq.addEventListener?mq.addEventListener("change",onc):mq.addListener(onc); }

// ---- undo (peak/interval add/remove/move/resize/edit) ----
const undoStack = [];
function snapshot(){ return {
  peaks: peaks.map(p=>({...p})), ranges: ranges.map(r=>({...r})),
  selId, selRange, nextId, nextRangeId }; }
function pushUndo(){ undoStack.push(snapshot()); if(undoStack.length>60) undoStack.shift();
  const b=document.getElementById("undoBtn"); if(b) b.disabled=false; }
// what the undo just changed, so we can navigate the view there. Compares the
// current (pre-undo) peaks/ranges against the snapshot being restored and returns
// the first differing / added-back / removed item.
function undoFocus(curP,curR,newP,newR){
  const pk=(a,b)=>a.apex!==b.apex||a.winL!==b.winL||a.winR!==b.winR||a.label!==b.label||a.use!==b.use||a.formula!==b.formula||a.mz!==b.mz||a.k!==b.k;
  const rg=(a,b)=>a.start!==b.start||a.end!==b.end||a.label!==b.label||a.class!==b.class;
  for(const p of curP) if(!newP.some(q=>q.id===p.id)) return {kind:"peak",apex:p.apex,gone:true};   // undo of an added peak
  for(const p of newP){ const c=curP.find(q=>q.id===p.id);
    if(!c||pk(c,p)) return {kind:"peak",id:p.id,apex:p.apex}; }                                     // re-added or field changed
  for(const r of curR) if(!newR.some(q=>q._id===r._id)) return {kind:"range",start:r.start,end:r.end,gone:true};
  for(const r of newR){ const c=curR.find(q=>q._id===r._id);
    if(!c||rg(c,r)) return {kind:"range",id:r._id,start:r.start,end:r.end}; }
  return null; }
function undo(){ const s=undoStack.pop(); if(!s) return;
  const f=undoFocus(peaks,ranges,s.peaks,s.ranges);
  peaks=s.peaks.map(p=>({...p})); ranges=s.ranges.map(r=>({...r}));
  selId=s.selId; selRange=s.selRange; nextId=s.nextId; nextRangeId=s.nextRangeId;
  const b=document.getElementById("undoBtn"); if(b) b.disabled=undoStack.length===0;
  traceCache.key=null;
  if(f && f.kind==="peak"){ if(f.id!=null) selId=f.id;
    if(tab!=="spec") setTab("spec"); renderPeaks(); renderRanges();
    const p=peaks.find(x=>x.id===f.id);
    if(p) jumpToPeak(p); else animateTo(f.apex-0.6,f.apex+0.6,300); scheduleSave(); return; }
  if(f && f.kind==="range"){ if(f.id!=null) selRange=f.id;
    if(tab!=="trace") setTab("trace"); renderPeaks(); renderRanges();
    const pad=Math.max(8,(f.end-f.start)*0.6); animateTo(f.start-pad,f.end+pad,300); scheduleSave(); return; }
  renderPeaks(); renderRanges(); redraw(); }

// ---- math (mirrors ptrms.quantify) ----
function interpT(m){ const xs=DATA.transmission.masses, ys=DATA.transmission.factors;
  if(m<=xs[0])return ys[0]; if(m>=xs[xs.length-1])return ys[ys.length-1];
  let i=1; while(xs[i]<m)i++; const t=(m-xs[i-1])/(xs[i]-xs[i-1]); return ys[i-1]+t*(ys[i]-ys[i-1]); }
function stats(arr){ let n=arr.length,mn=Infinity,mx=-Infinity,s=0;
  for(const v of arr){ if(v<mn)mn=v; if(v>mx)mx=v; s+=v; }
  const av=s/n; let ss=0; for(const v of arr) ss+=(v-av)*(v-av);
  return {Max:mx,Min:mn,Average:av,Deviation:n>1?Math.sqrt(ss/(n-1)):0}; }
function windowTB(apex,hwL,hwR){ return [Math.floor(m2tb(apex-hwL)), Math.ceil(m2tb(apex+hwR))]; }
function winSum(apex,hwL,hwR){ const [wl,wr]=windowTB(apex,hwL,hwR);
  let s=0; const lo=Math.max(0,wl), hi=Math.min(NBIN,wr); for(let i=lo;i<hi;i++) s+=SPEC[i]; return s; }
function moved(p){ return (p.apex!==p._apex0) || (p.winL!==p._winL0) || (p.winR!==p._winR0); }
function rawTrace(p){ if(!p.trace) return null; const out=Float64Array.from(p.trace);
  if(moved(p)){ const base=winSum(p._apex0,p._winL0,p._winR0), cur=winSum(p.apex,p.winL,p.winR), f=base>0?cur/base:1;
    for(let i=0;i<out.length;i++) out[i]*=f; } return out; }
function computeTraces(p){ const raw=rawTrace(p); if(!raw) return null;
  const T=interpT(p.apex), cor=new Float64Array(NCYC), con=new Float64Array(NCYC), ug=new Float64Array(NCYC);
  const kfac=(cfg.kinetic && p.k && !p.k_estimated)?cfg.kanchor/p.k:1.0;
  const isHum=cfg.humid && (p.flags||[]).includes("humid") && cfg.href>0;
  const haveConc=!!(M.primary_available !== false && PC.primary && cfg.K!=null);
  for(let i=0;i<NCYC;i++){ cor[i]=raw[i]/T;
    if(haveConc && PC.primary && PC.primary[i]>0){ let hf=1.0;
      if(isHum && PC.humidity && PC.humidity[i]>0) hf=Math.pow(PC.humidity[i]/cfg.href,cfg.hump);
      con[i]=cor[i]*(cfg.K/PC.primary[i])*kfac*hf; ug[i]=con[i]*(p.mz-M.proton)/cfg.Vm;
    } else { con[i]=NaN; ug[i]=NaN; } }
  return {raw,cor,con,ug,T}; }
function nearestCompound(mz){ let best=null,bd=0.05;
  for(const c of DATA.rate_constants){ const d=Math.abs(c.mz-mz); if(d<bd){bd=d;best=c;} } return best; }
function selPeak(){ return peaks.find(p=>p.id===selId); }
function fmt(v){ if(v==null||!isFinite(v))return '—'; const a=Math.abs(v);
  if(a>=1000)return v.toFixed(0); if(a>=1)return v.toFixed(2); return v.toPrecision(3); }
function clampCyc(c){ return Math.max(1,Math.min(NCYC,c)); }

// ---- canvas helper (DPI-correct; reads a FIXED logical height from data-h) ----
function fit(c){ const w=c.clientWidth, h=+c.dataset.h; c.style.height=h+"px";
  c.width=Math.max(1,Math.round(w*devicePixelRatio)); c.height=Math.round(h*devicePixelRatio);
  const x=c.getContext("2d"); x.setTransform(devicePixelRatio,0,0,devicePixelRatio,0,0);
  x.clearRect(0,0,w,h); return [x,w,h]; }
function grid(x,w,h,padL,padB){ x.strokeStyle=TH.grid; x.lineWidth=1; x.strokeRect(padL,8,w-padL-10,h-8-padB);
  x.strokeStyle=TH.gridln; for(let i=1;i<4;i++){ const yy=8+(h-8-padB)*i/4;
    x.beginPath(); x.moveTo(padL,yy); x.lineTo(w-10,yy); x.stroke(); } }
// faded horizontal+vertical guide lines to the axes at the cursor, plus a "(x, y)"
// readout. Called at the end of each plot with that plot's axis inverse-maps.
function crosshair(x,w,h,padL,top,plotH,xStr,yStr){
  if(!cursor) return; const cx=cursor.x, cy=cursor.y;
  if(cx<padL||cx>w-10||cy<top||cy>top+plotH) return;
  x.save();
  x.strokeStyle=TH.cross; x.lineWidth=1; x.setLineDash([3,3]);
  x.beginPath(); x.moveTo(cx,top); x.lineTo(cx,top+plotH);
  x.moveTo(padL,cy); x.lineTo(w-10,cy); x.stroke(); x.setLineDash([]);
  const lbl="("+xStr+", "+yStr+")"; x.font="10px sans-serif";
  const tw=x.measureText(lbl).width+8;
  let bx=cx+9, by=cy-18; if(bx+tw>w-6) bx=cx-9-tw; if(by<top) by=cy+6;
  x.fillStyle=TH.crossBg; x.fillRect(bx,by,tw,15);
  x.strokeStyle=TH.cross; x.strokeRect(bx,by,tw,15);
  x.fillStyle=TH.crossText; x.fillText(lbl,bx+4,by+11);
  x.restore(); }

// ---- overview data (precomputed, decimated) ----
const INSET=(()=>{ const lo=Math.max(0,Math.floor(m2tb(5))), hi=NBIN-1, N=520;
  const step=Math.max(1,Math.floor((hi-lo)/N)), pts=[]; let mx=1;
  for(let i=lo;i<=hi;i+=step){ let m=0; const e=Math.min(i+step,hi+1);
    for(let j=i;j<e;j++) if(SPEC[j]>m)m=SPEC[j]; pts.push([tb2m(i),m]); if(m>mx)mx=m; }
  return {pts, lo:tb2m(lo), hi:tb2m(hi), max:mx}; })();
const TINSET=(()=>{ const disc=PC.discriminator; if(!disc) return null;
  const N=520, step=Math.max(1,Math.floor(NCYC/N)), pts=[]; let mx=1;
  for(let i=0;i<NCYC;i+=step){ let m=0; const e=Math.min(i+step,NCYC);
    for(let j=i;j<e;j++) if(disc[j]>m)m=disc[j]; pts.push([i+1,m]); if(m>mx)mx=m; }
  return {pts, lo:1, hi:NCYC, max:mx}; })();

// ---- shared plot state ----
const plotC=document.getElementById("plot");
let tab="trace";                        // "spec" | "trace" — intervals reviewed first, then peaks
let vSpec={lo:0,hi:1};                   // domain in m/z
let vTrace={lo:1,hi:NCYC};               // domain in cycles
let insetBox=null;                       // {x,y,w,h,d0,d1} set each draw for hit-testing
let cursor=null;                         // {x,y} in CSS px for the hover crosshair (null = off-plot)
let anim=null;                           // active view animation
function view(){ return tab==="spec"?vSpec:vTrace; }
function fullDomain(){ return tab==="spec"?[Math.max(1,INSET.lo),INSET.hi]:[1,NCYC]; }
function minWidth(){ return tab==="spec"?0.15:5; }
function initSpecView(){ const ms=peaks.map(p=>p.mz);
  if(ms.length){ vSpec.lo=Math.max(1,Math.min(...ms)-4); vSpec.hi=Math.max(...ms)+4; }
  else { vSpec.lo=10; vSpec.hi=Math.min(300, tb2m(NBIN-1)); } }
function clampView(){ const v=view(), [fl,fh]=fullDomain(), mw=minWidth();
  if(v.hi-v.lo<mw){ const c=(v.lo+v.hi)/2; v.lo=c-mw/2; v.hi=c+mw/2; }
  if(v.lo<fl){ v.hi+=fl-v.lo; v.lo=fl; }
  if(v.hi>fh){ v.lo-=v.hi-fh; v.hi=fh; if(v.lo<fl)v.lo=fl; } }
function drawMain(){ if(tab==="spec") drawSpec(); else drawTrace(); }
// coalesce view-only repaints (pan/zoom fire many events) to one per frame
let drawQueued=false;
function scheduleDraw(){ if(drawQueued) return; drawQueued=true;
  requestAnimationFrame(()=>{ drawQueued=false; drawMain(); }); }
// size the plot + the context card so the whole app fits the viewport (only cards scroll internally)
function relayout(){ if(!plotC.isConnected) return;
  const vh=window.innerHeight, canvasTop=plotC.getBoundingClientRect().top;
  const foot=document.querySelector(".plotfoot"), footH=foot?foot.offsetHeight:34;
  const hintH=(tab==="trace")?34:0;                 // intervals card shows a hint line, ID card doesn't
  const leftover=vh-canvasTop-footH-16/*gap*/-40/*ctx header*/-hintH-18/*bottom pad*/-2;
  let bodyH=Math.max(110,Math.min(300,Math.round(leftover*0.34)));
  let ph=Math.max(280,Math.min(560,leftover-bodyH));
  plotC.dataset.h=ph;
  document.querySelectorAll("#intcard .scroll").forEach(s=>s.style.maxHeight=bodyH+"px");
  const idp=document.getElementById("idpanel"); if(idp){ idp.style.maxHeight=bodyH+"px"; idp.style.overflowY="auto"; }
  drawMain(); }
window.addEventListener("resize",relayout);
// cache the selected peak's computed traces — recompute only when the data
// (peak/apex/K/…) changes, NOT when the view pans or zooms
const DISC_MAX = PC.discriminator ? PC.discriminator.reduce((a,v)=>v>a?v:a,1) : 1;
let traceCache={key:null,tr:null};
function currentTr(){ const p=selPeak(); if(!p) return null;
  const key=[selId,cfg.K,cfg.Vm,cfg.kinetic,cfg.kanchor,cfg.humid,cfg.hump,cfg.href,p.apex,p.mz,p.winL,p.winR,p.k,p.k_estimated].join("|");
  if(traceCache.key!==key) traceCache={key,tr:computeTraces(p)};
  return traceCache.tr; }

// smooth view animation (easeInOutQuad); cancels on any manual interaction
function animateTo(tlo,thi,ms){ const v=view();
  anim={v,slo:v.lo,shi:v.hi,tlo,thi,ms:ms||220,start:null}; requestAnimationFrame(animStep); }
function animStep(ts){ if(!anim) return; if(anim.start==null)anim.start=ts;
  let k=Math.min(1,(ts-anim.start)/anim.ms); const e=k<.5?2*k*k:1-Math.pow(-2*k+2,2)/2;
  anim.v.lo=anim.slo+(anim.tlo-anim.slo)*e; anim.v.hi=anim.shi+(anim.thi-anim.shi)*e;
  clampView(); drawMain(); if(k<1) requestAnimationFrame(animStep); else anim=null; }
function zoomBy(f){ const v=view(), c=(v.lo+v.hi)/2, hw=(v.hi-v.lo)*f/2; animateTo(c-hw,c+hw,170); }
function jumpToPeak(p){ const wmax=Math.max(p.winL||0,p.winR||0)||p.apex/(2*cfg.R);
  const hw=Math.min(1.2, Math.max(0.18, wmax*10)); animateTo(p.apex-hw, p.apex+hw, 300); }

// ---- overview inset (draggable) ----
function drawInset(x,w,h,ins,d0,d1,vlo,vhi){ if(!ins){ insetBox=null; return; }
  const iw=Math.min(240,w*0.34), ih=46, ix=w-iw-16, iy=14; insetBox={x:ix,y:iy,w:iw,h:ih,d0,d1};
  x.fillStyle=TH.insetBg; x.strokeStyle=TH.insetStroke; x.lineWidth=1;
  x.beginPath(); x.rect(ix,iy,iw,ih); x.fill(); x.stroke();
  const X=d=>ix+(d-d0)/(d1-d0)*iw, Y=v=>iy+ih-(v/ins.max)*(ih-6)-2;
  x.strokeStyle=TH.insetLine; x.lineWidth=1; x.beginPath();
  ins.pts.forEach((p,i)=>{ const px=X(p[0]),py=Y(p[1]); i?x.lineTo(px,py):x.moveTo(px,py); }); x.stroke();
  const rx=X(Math.max(d0,vlo)), rx2=X(Math.min(d1,vhi)), rw=Math.max(2,rx2-rx);
  x.fillStyle="rgba(245,158,11,.22)"; x.strokeStyle="#f59e0b";
  x.fillRect(rx,iy,rw,ih); x.strokeRect(rx,iy,rw,ih);
  x.fillStyle=TH.insetText; x.font="9px sans-serif"; x.fillText("overview · drag to move",ix+5,iy+11); }
function insetPanTo(px){ if(!insetBox) return; const {x:ix,w:iw,d0,d1}=insetBox;
  const d=d0+(Math.max(ix,Math.min(ix+iw,px))-ix)/iw*(d1-d0);
  const v=view(), half=(v.hi-v.lo)/2; v.lo=d-half; v.hi=d+half; clampView(); scheduleDraw(); }

// ---- spectrum view ----
let SHOWSPEC = SPEC;   // spectrum currently drawn (whole run or a chosen interval)
// Peak positions drift between intervals (mass-cal drift; a compound may be
// absent in a background). When an interval is shown, refine each isolated peak's
// apex to THAT interval's spectrum so the apex line + window sit on its real peak.
// Clustered fitted components remain at their fixed model centres. This is a DISPLAY
// overlay only — p.apex/p.winL/p.winR (saved to config, used by the delivered CSV)
// are untouched. null = whole run, no refinement.
let intervalApex = null;
function dispApex(p){ return (intervalApex && intervalApex[p.id]!=null) ? intervalApex[p.id] : p.apex; }
function refineIntervalApexes(spec){
  if(!spec || spec===SPEC){ intervalApex=null; return; }   // whole run -> canonical
  const out={};
  for(const p of peaks){
    out[p.id]=null;
    if(p.winManual || p.clustered) continue;    // respect manual and fitted cluster centres
    const tol=0.035;
    const lo=Math.max(0,Math.floor(m2tb(p.apex-tol))), hi=Math.min(spec.length-1,Math.ceil(m2tb(p.apex+tol)));
    if(hi-lo<2) continue;
    let bi=lo, bv=spec[lo];
    for(let i=lo;i<=hi;i++) if(spec[i]>bv){ bv=spec[i]; bi=i; }
    // only snap to a genuine interior maximum that rises above the window edges;
    // a monotonic climb (max at an edge) or a flat/near-zero region -> keep canonical
    const edge=(bi<=lo || bi>=hi);
    const floor=Math.max(spec[lo],spec[hi]);
    if(!edge && bv>=3 && bv>=1.25*floor) out[p.id]=tb2m(bi);
  }
  intervalApex=out;
}
function specMzAtX(px){ const w=plotC.clientWidth, padL=56, plotW=w-padL-10;
  return vSpec.lo+(px-padL)/plotW*(vSpec.hi-vSpec.lo); }
function specXAtMz(m){ const w=plotC.clientWidth, padL=56, plotW=w-padL-10;
  return padL+(m-vSpec.lo)/(vSpec.hi-vSpec.lo)*plotW; }
function drawSpec(){
  const [x,w,h]=fit(plotC), padL=56, padB=22; grid(x,w,h,padL,padB);
  const S=SHOWSPEC, lo=vSpec.lo, hi=vSpec.hi, plotW=w-padL-10, top=8, plotH=h-top-padB;
  const X=m=>padL+(m-lo)/(hi-lo)*plotW, Y=v=>(top+plotH)-(v/vmax)*plotH;
  let tbA=Math.max(0,Math.floor(m2tb(lo))), tbB=Math.min(S.length-1,Math.ceil(m2tb(hi)));
  var vmax=1; for(let i=tbA;i<=tbB;i++) if(S[i]>vmax)vmax=S[i];
  x.save(); x.beginPath(); x.rect(padL,top,plotW,plotH); x.clip();
  // integration windows for visible assigned peaks (per-peak half-width)
  for(const p of peaks){ if(!p.use||p.mz<lo-.5||p.mz>hi+.5) continue;
    const [wl,wr]=windowTB(dispApex(p),p.winL,p.winR), mL=tb2m(wl), mR=tb2m(wr);
    const hov=p.id!==selId && p.id===hoverPeakId;
    // the integration window is always a light-blue band (matches the legend); the
    // SELECTED peak's band is a touch stronger and additionally carries the amber
    // apex line + dashed edge handles that mark the selection.
    x.fillStyle=p.id===selId?"rgba(96,165,250,.30)":hov?"rgba(96,165,250,.22)":"rgba(96,165,250,.14)";
    const xa=X(Math.max(mL,lo)), xb=X(Math.min(mR,hi)); x.fillRect(xa,top,Math.max(1,xb-xa),plotH); }
  // ⌘/Ctrl-drag preview of a new peak
  if(drag && drag.mode==="newpeak"){ const a2=Math.min(drag.m0,drag.m1), b2=Math.max(drag.m0,drag.m1);
    x.fillStyle="rgba(96,165,250,.22)"; x.fillRect(X(a2),top,Math.max(1,X(b2)-X(a2)),plotH); }
  // spectrum (peak-preserving decimation)
  const step=Math.max(1,Math.floor((tbB-tbA)/(plotW*2||1)));
  x.strokeStyle=TH.spec; x.lineWidth=1.5; x.beginPath(); let started=false;
  for(let i=tbA;i<=tbB;i+=step){ let m=0; const e=Math.min(i+step,tbB+1);
    for(let j=i;j<e;j++) if(S[j]>m)m=S[j];
    const px=X(tb2m(i)), py=Y(m); started?x.lineTo(px,py):x.moveTo(px,py); started=true; }
  x.stroke();
  // apex / assigned markers + labels for visible peaks
  x.font="11px sans-serif";
  for(const p of peaks){ if(p.mz<lo||p.mz>hi) continue; const sel=p.id===selId, hov=!sel&&p.id===hoverPeakId;
    const ax=dispApex(p);
    x.strokeStyle=sel?"#f59e0b":hov?"rgba(96,165,250,.9)":"rgba(148,163,184,.5)"; x.lineWidth=sel||hov?1.6:1;
    x.beginPath(); x.moveTo(X(ax),top); x.lineTo(X(ax),top+plotH); x.stroke();
    if(sel||hov||hi-lo<30){ x.fillStyle=sel?TH.labelHi:TH.labelDim;
      x.fillText(p.label, Math.min(X(ax)+4,w-70), top+12+((p.id*7)%16)); } }
  // draggable integration-window handles on the SELECTED peak
  const sp=selPeak();
  if(sp && sp.use && sp.mz>=lo-1 && sp.mz<=hi+1){ const [wl,wr]=windowTB(dispApex(sp),sp.winL,sp.winR);
    for(const mm of [tb2m(wl),tb2m(wr)]){ const hx=X(mm);
      x.strokeStyle="#f59e0b"; x.lineWidth=1.4; x.setLineDash([4,3]);
      x.beginPath(); x.moveTo(hx,top); x.lineTo(hx,top+plotH); x.stroke(); x.setLineDash([]);
      x.fillStyle="#f59e0b"; x.fillRect(hx-3,top+plotH/2-7,6,14); } }
  x.restore();
  // axes labels
  x.fillStyle=TH.axis; x.font="10px sans-serif";
  x.fillText(lo.toFixed(hi-lo<5?3:1),padL,h-6); x.fillText(hi.toFixed(hi-lo<5?3:1),w-46,h-6);
  x.fillText("m/z",(padL+w)/2,h-6); x.fillText(vmax.toPrecision(3),6,16); x.fillText("cps",6,top+plotH);
  drawInset(x,w,h,INSET,INSET.lo,INSET.hi,vSpec.lo,vSpec.hi);
  if(cursor){ const mz=lo+(cursor.x-padL)/plotW*(hi-lo), cps=(top+plotH-cursor.y)/plotH*vmax;
    crosshair(x,w,h,padL,top,plotH, mz.toFixed(hi-lo<5?4:3), Math.max(0,cps).toPrecision(3)); }
}

// peaks a click/hover falls on in the spectrum — the peak analogue of "which interval
// contains this cycle" (integration window, widened to a min ±7px around the apex so
// narrow peaks stay clickable). Returned nearest-apex-first so overlaps can be cycled.
function peakHitsAt(x){ const lo=vSpec.lo,hi=vSpec.hi, out=[];
  for(const p of peaks){ if(p.mz<lo-.5||p.mz>hi+.5) continue;
    const ax=specXAtMz(dispApex(p)); let xa=ax-7, xb=ax+7;
    if(p.use){ const [wl,wr]=windowTB(dispApex(p),p.winL,p.winR);
      xa=Math.min(xa,specXAtMz(tb2m(wl))); xb=Math.max(xb,specXAtMz(tb2m(wr))); }
    if(x>=xa && x<=xb) out.push(p); }
  out.sort((a,b)=>Math.abs(specXAtMz(dispApex(a))-x)-Math.abs(specXAtMz(dispApex(b))-x));
  return out; }

// ---- time trace view ----
function traceX(w){ const padL=46, plotW=w-padL-10;
  return c=>padL+((c-vTrace.lo)/(vTrace.hi-vTrace.lo))*plotW; }
function cycleAtX(px){ const w=plotC.clientWidth, padL=46, plotW=w-padL-10;
  return Math.round(vTrace.lo+((px-padL)/plotW)*(vTrace.hi-vTrace.lo)); }
function drawTrace(){
  const [x,w,h]=fit(plotC), padL=46, padB=22; grid(x,w,h,padL,padB);
  const X=traceX(w), p=selPeak(), top=8, plotH=h-top-padB;
  // visible cycle window + peak-preserving decimation (~2 samples per pixel)
  const c0=Math.max(1,Math.floor(vTrace.lo)), c1=Math.min(NCYC,Math.ceil(vTrace.hi));
  const step=Math.max(1,Math.floor((c1-c0)/((w-56)*2||1)));
  x.save(); x.beginPath(); x.rect(padL,top,w-padL-10,plotH); x.clip();
  const disc=PC.discriminator;
  if(disc){ x.strokeStyle=TH.disc; x.lineWidth=1; x.beginPath(); let st=false;
    for(let i=c0-1;i<c1;i+=step){ let m=0; const e=Math.min(i+step,c1); for(let j=i;j<e;j++) if(disc[j]>m)m=disc[j];
      const px=X(i+1),py=(top+plotH)-(m/DISC_MAX)*plotH; st?x.lineTo(px,py):x.moveTo(px,py); st=true; } x.stroke(); }
  ranges.forEach(r=>{ const sel=r._id===selRange, hov=!sel && r._id===hoverRange;
    x.fillStyle=sel?(r.class==="sample"?"rgba(245,158,11,.28)":"rgba(148,163,184,.30)")
              :hov?(r.class==="sample"?"rgba(245,158,11,.22)":"rgba(148,163,184,.24)")
                  :(r.class==="sample"?"rgba(245,158,11,.14)":"rgba(100,116,139,.16)");
    x.fillRect(X(r.start),top,X(r.end)-X(r.start),plotH);
    if(sel){
      // selected interval: dashed amber edges + centre grab-handles, matching the peak windows
      x.strokeStyle="#f59e0b"; x.lineWidth=1.4; x.setLineDash([4,3]);
      x.beginPath(); x.moveTo(X(r.start),top); x.lineTo(X(r.start),top+plotH);
      x.moveTo(X(r.end),top); x.lineTo(X(r.end),top+plotH); x.stroke(); x.setLineDash([]);
      x.fillStyle="#f59e0b";
      x.fillRect(X(r.start)-3,top+plotH/2-7,6,14); x.fillRect(X(r.end)-3,top+plotH/2-7,6,14);
    } else {
      x.strokeStyle=hov?(r.class==="sample"?"rgba(245,158,11,.85)":"rgba(148,163,184,.8)")
                       :(r.class==="sample"?"rgba(245,158,11,.6)":"rgba(148,163,184,.5)");
      x.lineWidth=hov?1.5:1;
      x.beginPath(); x.moveTo(X(r.start),top); x.lineTo(X(r.start),top+plotH);
      x.moveTo(X(r.end),top); x.lineTo(X(r.end),top+plotH); x.stroke();
    } });
  // ⌘/Ctrl-drag preview of a new segment
  if(drag && drag.mode==="newseg" && drag.c1!=null){ const s=Math.min(drag.c0,drag.c1), en=Math.max(drag.c0,drag.c1);
    x.fillStyle="rgba(245,158,11,.22)"; x.fillRect(X(s),top,X(en)-X(s),plotH); }
  const tr=p?currentTr():null; let yLo=null,yHi=null;
  if(tr){ const arr=tr[quant]; plotC._arr=arr;
    let vmax=-Infinity,vmin=Infinity; for(const v of arr) if(isFinite(v)){ if(v>vmax)vmax=v; if(v<vmin)vmin=v; }
    if(!isFinite(vmax)){vmax=1;vmin=0;} if(vmax===vmin)vmax=vmin+1;
    yLo=vmin; yHi=vmax;
    const Y=v=>(top+plotH)-((v-vmin)/(vmax-vmin))*plotH;
    x.strokeStyle=TH.trace; x.lineWidth=1.7; x.beginPath(); let st=false;
    for(let i=c0-1;i<c1;i+=step){ let m=-Infinity,any=false; const e=Math.min(i+step,c1);
      for(let j=i;j<e;j++){ const v=arr[j]; if(isFinite(v)){ any=true; if(v>m)m=v; } }
      if(!any){ st=false; continue; } const px=X(i+1),py=Y(m); st?x.lineTo(px,py):x.moveTo(px,py); st=true; } x.stroke();
    x.restore();
    x.fillStyle=TH.axis; x.font="10px sans-serif"; x.fillText(vmax.toPrecision(3),4,16);
    x.fillText(vmin.toPrecision(3),4,top+plotH);
  } else x.restore();
  // interval labels: only the hovered / selected one, to keep the plot uncluttered
  x.save(); x.beginPath(); x.rect(padL,top,w-padL-10,plotH); x.clip();
  x.font="11px sans-serif";
  ranges.forEach(r=>{ if(r._id!==hoverRange && r._id!==selRange) return;
    const lx=Math.max(padL+3,X(r.start)+3);
    x.fillStyle=r.class==="sample"?TH.labelHi:TH.labelDim;
    x.fillText(r.label, lx, top+13); });
  x.restore();
  x.fillStyle=TH.axis; x.font="10px sans-serif";
  x.fillText(""+Math.round(vTrace.lo),46,h-6); x.fillText(""+Math.round(vTrace.hi),w-40,h-6);
  x.fillText("cycle",(padL+w)/2,h-6);
  if(cursor){ const plotW=w-padL-10, cyc=Math.round(vTrace.lo+(cursor.x-padL)/plotW*(vTrace.hi-vTrace.lo));
    const yStr=(yLo!=null)?(yLo+(top+plotH-cursor.y)/plotH*(yHi-yLo)).toPrecision(3):"—";
    crosshair(x,w,h,padL,top,plotH, ""+cyc, yStr); }
  insetBox=null;   // no overview inset on the trace plot (it obscured the signal)
}

// ---- unified pointer handling (pan / zoom / select / segments / inset) ----
let drag=null;
function overInset(x,y){ return insetBox && x>=insetBox.x && x<=insetBox.x+insetBox.w
  && y>=insetBox.y && y<=insetBox.y+insetBox.h; }
function winEdgeAt(x){ if(tab!=="spec") return null; const sp=selPeak(); if(!sp||!sp.use) return null;
  const [wl,wr]=windowTB(dispApex(sp),sp.winL,sp.winR);
  if(Math.abs(x-specXAtMz(tb2m(wl)))<6) return {p:sp,side:'lo'};
  if(Math.abs(x-specXAtMz(tb2m(wr)))<6) return {p:sp,side:'hi'}; return null; }
// interval edges are only grabbable on the SELECTED interval (like the peak
// windows) — so clicking near a non-selected interval no longer grabs/selects it
function traceEdgeAt(x){ if(tab!=="trace"||selRange==null) return null;
  const w=plotC.clientWidth, X=traceX(w), r=ranges.find(rr=>rr._id===selRange); if(!r) return null;
  if(Math.abs(X(r.start)-x)<6) return {r,side:'start'};
  if(Math.abs(X(r.end)-x)<6) return {r,side:'end'}; return null; }
function nearEdge(x){ if(tab==="trace") return !!traceEdgeAt(x); return !!winEdgeAt(x); }
function setCur(c){ plotC.style.cursor=c; }
plotC.addEventListener("mousedown",e=>{ anim=null; const x=e.offsetX, y=e.offsetY;
  if(overInset(x,y)){ drag={mode:"inset"}; setCur("grabbing"); insetPanTo(x); return; }
  if(tab==="trace"){
    if(e.metaKey||e.ctrlKey){ e.preventDefault(); drag={mode:'newseg',c0:clampCyc(cycleAtX(x)),c1:clampCyc(cycleAtX(x))}; setCur("crosshair"); drawTrace(); return; }
    const te=traceEdgeAt(x); if(te){ drag={mode:'edge',r:te.r,side:te.side,x,moved:false}; setCur("ew-resize"); return; }
    drag={mode:'pan',trace:true,moved:false,x,lo:vTrace.lo,hi:vTrace.hi}; setCur("grabbing"); return; }
  // spectrum: ⌘/Ctrl-drag adds a new peak spanning the drag (window = drag width)
  if(e.metaKey||e.ctrlKey){ e.preventDefault(); const m=specMzAtX(x); drag={mode:'newpeak',m0:m,m1:m}; setCur("crosshair"); scheduleDraw(); return; }
  // drag a window edge of the selected peak (highest priority)
  const we=winEdgeAt(x); if(we){ pushUndo(); drag={mode:'win',p:we.p,side:we.side}; setCur("ew-resize"); return; }
  // otherwise pan, but a click (no move) selects + zooms to the nearest peak
  drag={mode:'pan',spec:true,moved:false,x,lo:vSpec.lo,hi:vSpec.hi}; setCur("grabbing"); });
plotC.addEventListener("mousemove",e=>{ const x=e.offsetX, y=e.offsetY;
  cursor={x,y}; scheduleDraw();   // move the hover crosshair (coalesced to one repaint/frame)
  if(drag){
    if(drag.mode==="inset"){ insetPanTo(x); return; }
    if(drag.mode==="edge"){ if(!drag.moved && Math.abs(x-drag.x)>3){ pushUndo(); drag.moved=true; }
      if(drag.moved){ const c=clampCyc(cycleAtX(x)); drag.r[drag.side]=c;
        if(drag.r.start>drag.r.end){const t=drag.r.start;drag.r.start=drag.r.end;drag.r.end=t;} drawTrace(); } return; }
    if(drag.mode==="newseg"){ drag.c1=clampCyc(cycleAtX(x)); drawTrace(); return; }
    if(drag.mode==="newpeak"){ drag.m1=specMzAtX(x); scheduleDraw(); return; }
    if(drag.mode==="win"){ const p=drag.p, mz=specMzAtX(x), ax=dispApex(p);
      if(drag.side==='lo') p.winL=Math.max(0.003, ax-mz); else p.winR=Math.max(0.003, mz-ax);
      p.winManual=true; scheduleDraw(); return; }
    if(drag.mode==="pan"){ if(Math.abs(x-drag.x)>3)drag.moved=true;
      const v=view(), padL=tab==="spec"?56:46, plotW=plotC.clientWidth-padL-10;
      const dd=(x-drag.x)/plotW*(drag.hi-drag.lo); v.lo=drag.lo-dd; v.hi=drag.hi-dd; clampView(); scheduleDraw(); return; } }
  // idle hover: cursor + hover highlight (interval on the trace, peak window on the spectrum)
  if(tab==="trace"){ const c=clampCyc(cycleAtX(x));
    const hv=ranges.find(r=>c>=r.start && c<=r.end), hid=hv?hv._id:null;
    if(hid!==hoverRange){ hoverRange=hid; drawMain(); }
    setCur(nearEdge(x)?"ew-resize":"grab");
  } else { const hit=peakHitsAt(x)[0], hid=hit?hit.id:null;
    if(hid!==hoverPeakId){ hoverPeakId=hid; drawMain(); }
    setCur(nearEdge(x)?"ew-resize":(hid!=null?"pointer":"grab")); } });
plotC.addEventListener("mouseleave",()=>{ cursor=null;   // hide the crosshair off-plot
  if(!drag){ setCur("grab");
    if(tab==="trace"){ hoverRange=null; }
    else hoverPeakId=null; }
  drawMain(); });
window.addEventListener("mouseup",e=>{ if(!drag) return; setCur("grab");
  const d=drag; drag=null;
  if(d.mode==="pan" && d.spec && !d.moved){          // click a peak's window -> select (+zoom); click empty -> deselect
    const hits=(e.target===plotC)?peakHitsAt(d.x):[];
    if(hits.length){ const cur=hits.findIndex(p=>p.id===selId), nx=hits[(cur+1)%hits.length]; // cycle overlapping peaks
      selId=nx.id; renderPeaks(); jumpToPeak(nx); }
    else { selId=null; renderPeaks(); drawMain(); } return; }
  if(d.mode==="pan" && d.trace && !d.moved){ const c=clampCyc(cycleAtX(d.x));   // click inside an interval -> select; click empty -> deselect
    const hits=ranges.filter(r=>c>=r.start && c<=r.end);
    if(hits.length){ const cur=hits.findIndex(r=>r._id===selRange); selRange=hits[(cur+1)%hits.length]._id; } // cycle overlapping intervals
    else selRange=null;
    renderRanges(); drawMain(); return; }
  if(d.mode==="newpeak"){ const lo=Math.min(d.m0,d.m1), hi=Math.max(d.m0,d.m1);
    if(hi-lo>0.004){ pushUndo(); const apex=+((lo+hi)/2).toFixed(4), hw=(hi-lo)/2, c=nearestCompound(apex);
      peaks.push({id:nextId++,mz:apex,apex:apex,_apex0:apex,label:c?c.name:("m"+apex.toFixed(3)),
        formula:c?c.formula:"",k:c?c.k:null,k_estimated:c?!!c.k_estimated:false,flags:c?c.flags:[],clustered:false,trace:null,use:true,
        winL:hw,winR:hw,_winL0:hw,_winR0:hw,winManual:true});
      selId=nextId-1; renderPeaks(); }
    else drawMain();
    return; }
  if(d.mode==="newseg"){ const s=Math.min(d.c0,d.c1), en=Math.max(d.c0,d.c1);
    if(en-s>=5){ pushUndo(); const nr={label:"sample_"+String(ranges.filter(r=>r.class==='sample').length+1).padStart(2,'0'),
      class:"sample",start:s,end:en,_id:nextRangeId++}; ranges.push(nr); selRange=nr._id;
      renderRanges(); refreshSpecRange(); redraw(); } else drawMain();
    return; }
  if(d.mode==="win"){ renderPeaks(); redraw(); return; }
  if(d.mode==="edge"){ if(!d.moved){ selRange=d.r._id; renderRanges(); drawMain(); } else redraw(); return; } });
plotC.addEventListener("dblclick",e=>{ if(tab!=="spec") return; const p=selPeak(); if(!p) return;
  pushUndo(); p.apex=+specMzAtX(e.offsetX).toFixed(4);
  if(!p.winManual){ const hw=p.apex/(2*cfg.R); p.winL=hw; p.winR=hw; } renderPeaks(); redraw(); });
plotC.addEventListener("wheel",e=>{ e.preventDefault(); anim=null; const v=view();
  // horizontal scroll (trackpad two-finger sideways, or Shift+wheel) pans; vertical wheel zooms
  const padL=tab==="spec"?56:46, plotW=Math.max(1,plotC.clientWidth-padL-10);
  const dx=(Math.abs(e.deltaX)>Math.abs(e.deltaY))?e.deltaX:(e.shiftKey?e.deltaY:0);
  if(dx){ const d=dx/plotW*(v.hi-v.lo); v.lo+=d; v.hi+=d; clampView(); scheduleDraw(); return; }
  const dom = tab==="spec"?specMzAtX(e.offsetX):cycleAtX(e.offsetX);
  const f=Math.exp(e.deltaY*0.0016);          // smooth, proportional zoom
  v.lo=dom-(dom-v.lo)*f; v.hi=dom+(v.hi-dom)*f; clampView(); scheduleDraw(); },{passive:false});
// suppress the context menu on the plot so Ctrl-drag (add) works cleanly on macOS
plotC.addEventListener("contextmenu",e=>e.preventDefault());

// ---- peaks (sidebar) ----
// another used peak that identifies as the same compound (same formula, or same
// name when no formula) — a compound should appear at one m/z, so this flags a mistake
function dupPeak(p){ const f=(p.formula||'').toUpperCase(), nm=(p.label||'').toLowerCase();
  if(!f && !nm) return null;
  return peaks.find(q=>q!==p && q.use && (f?((q.formula||'').toUpperCase()===f)
                                           :((q.label||'').toLowerCase()===nm))) || null; }
function peakPills(p){
  const dup=dupPeak(p);
  return (p.flags||[]).map(fl=>`<span class="pill ${fl}" title="${fl==='humid'?'proton affinity near water — a fixed k is humidity/temperature dependent':(fl==='frag'?'fragments off the parent ion':'')}">${fl==='humid'?'humid-sensitive':fl}</span>`).join(' ')+
    (dup?`<span class="pill ovl" title="same compound also assigned to m/z ${dup.mz.toFixed(3)}">⚠ duplicate</span>`:'')+
    (p.id_ambiguous?`<span class="pill hi" title="ambiguous identification; top candidate relative score/share">? ${Math.round((p.id_confidence||0)*100)}% share</span>`:'')+
    (p.overlap&&p.overlap.level==='unresolved'?'<span class="pill hi" title="unresolved overlap">⚠ overlap</span>':
      (p.clustered?'<span class="pill clus" title="Gaussian/deconvolved fitted component at a fixed model centre; may not form a visible local maximum in every interval">overlap</span>':''))+
    (!p.trace?'<span class="pill">re-run</span>':'')+
    (p.trace&&moved(p)?'<span class="pill hi" title="approximate — re-run analyze for the exact value">≈</span>':'');
}
function deletePeak(p){ if(!p) return; pushUndo(); peaks=peaks.filter(q=>q!==p);
  if(selId===p.id) selId=peaks[0]?.id??null; renderPeaks(); redraw(); }
function deleteRange(id){ const idx=ranges.findIndex(r=>r._id===id); if(idx<0) return;
  pushUndo(); if(selRange===id) selRange=null; ranges.splice(idx,1);
  hoverRange=null; renderRanges(); redraw(); }
function selectPeak(p){
  if(tab==="trace" && selId===p.id){ selId=null; renderPeaks(); drawMain(); return; } // click again to deselect
  const changed=selId!==p.id; selId=p.id;
  if(changed) renderPeaks();                          // don't re-render on re-click, so a label stays editable
  if(tab==="spec") jumpToPeak(p); else drawMain(); }
function renderPeaks(){ const box=document.getElementById("peaksbody"); if(!box) return;
  const cnt=document.getElementById("pkcount"); if(cnt) cnt.textContent=peaks.length?("· "+peaks.length):"";
  const dt=document.getElementById("pkdetails"); if(dt) dt.textContent=showDetails?"hide details":"details";
  box.innerHTML="";
  const esc=s=>(s||'').replace(/"/g,'&quot;');
  const ul=document.createElement("ul"); ul.className="plist"+(showDetails?" det":"");
  for(const p of peaks){ const li=document.createElement("li");
    li.className=(p.id===selId?"sel ":"")+(p.use?"":"off");
    const dup=dupPeak(p);
    const dot=dup?`<span class="dot ovl" title="duplicate: same compound also at m/z ${dup.mz.toFixed(3)}"></span>`:
              (p.id_ambiguous?'<span class="dot amb" title="ambiguous identification"></span>':
              (p.overlap?'<span class="dot ovl" title="spectral overlap"></span>':'<span class="dot"></span>'));
    const ro = p.id===selId ? "" : "readonly";   // only the selected row is editable (text caret); others show the finger cursor
    let h=`<input type="checkbox" data-a="use" ${p.use?"checked":""}>`+dot+
      `<input type="text" class="lbl" data-a="label" ${ro} value="${esc(p.label)}">`;
    if(showDetails){ const cand=nearestCompound(p.mz), dmda=cand?((p.mz-cand.mz)*1000):null;
      h+=`<span class="mini mz">${p.mz.toFixed(3)}</span>`+
        `<span class="dc dmda ${dmda!=null&&Math.abs(dmda)>10?'warn':''}" title="mass error vs nearest known compound">${dmda!=null?((dmda>=0?'+':'')+dmda.toFixed(1)+' mDa'):'—'}</span>`+
        `<span class="dc kv" title="proton-transfer rate constant (~ = estimated)">${p.k?('k '+(+p.k).toFixed(2)+(p.k_estimated?'~':'')):'k —'}</span>`+
        `<span class="dc win" title="integration half-widths — drag the dashed handles in the spectrum">−${p.winL.toFixed(3)}/+${p.winR.toFixed(3)}${p.winManual?'*':''}</span>`+
        `<span class="dc pills">${peakPills(p)}</span>`+
        `<button class="dc del" data-a="del" title="remove peak">✕</button>`;
    } else { h+=`<span class="sp"></span><span class="mini mz">${p.mz.toFixed(3)}</span><span class="go">›</span>`; }
    li.innerHTML=h;
    li.onclick=ev=>{ if(ev.target.dataset.a) return; selectPeak(p); };
    li.querySelector("[data-a=use]").onchange=e=>{ pushUndo(); p.use=e.target.checked; renderPeaks(); redraw(); };
    const lbl=li.querySelector("[data-a=label]");
    lbl.onclick=()=>selectPeak(p);                                   // clicking the label selects (no re-render if already selected)
    lbl.onchange=()=>{ pushUndo(); p.label=lbl.value; renderPeaks(); redraw(); };
    const del=li.querySelector("[data-a=del]"); if(del) del.onclick=e=>{ e.stopPropagation(); deletePeak(p); };
    ul.appendChild(li); }
  box.appendChild(ul);
  const sp=selPeak(); const tof=document.getElementById("traceof");
  if(tof) tof.textContent = sp? sp.label+" (m/z "+sp.mz.toFixed(3)+")":"—";
  // the per-compound trace legend entry only makes sense once a compound is chosen
  const ll=document.getElementById("leg-trace-line"); if(ll) ll.style.display=sp?"":"none";
  renderId(); }

// ---- identification: scored candidates + isotope evidence for the selected peak ----
function pct(x){ return (x*100).toFixed(1)+"%"; }
function evText(c){ if(!c.iso_obs) return '<span class="mut">no isotope data</span>';
  const cls=(o,p)=> o < p*0.5 ? "bad" : (Math.abs(o-p)<Math.max(0.01,p*0.5)?"ok":"");
  return `M+1 <span class="${cls(c.iso_obs[0],c.iso_pred[0])}">${pct(c.iso_obs[0])}</span>/${pct(c.iso_pred[0])} · `+
         `M+2 <span class="${cls(c.iso_obs[1],c.iso_pred[1])}">${pct(c.iso_obs[1])}</span>/${pct(c.iso_pred[1])}`; }
function renderId(){ const el=document.getElementById("idpanel"), conf=document.getElementById("idconf"), p=selPeak();
  const esc=s=>(s||'').replace(/[&<>\"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[c]));
  const assigned=!!(p&&p.formula);
  const status=assigned
    ? `<span class="pill assigned">assigned</span> ${esc(p.formula)}`
    : '<span class="pill unassigned">not assigned</span>';
  const provenance='<div class="idnote"><b>Evidence:</b> candidates are inferred from measured exact mass, isotope evidence, and chemistry plausibility. Names and isomer labels come from the bundled PTR Library mapping; formula ranking cannot determine structural isomers.</div>';
  const clusterNote=p&&p.clustered
    ? '<div class="idnote warn"><b>Clustered peak:</b> Gaussian/deconvolved fitted component at a fixed model centre. It may not form a visible local maximum in every selected interval; this model centre is not a measured apex.</div>'
    : '';
  if(!el) return;
  if(!p){ el.innerHTML='<div class="mut">Select a peak to see candidate formulas, ranked by measured exact mass, isotope evidence, and chemistry plausibility.</div>';
    if(conf) conf.textContent=""; return; }
  if(!p.candidates||!p.candidates.length){
    if(conf) conf.innerHTML=status+' <span class="mut">· no generated formula candidates</span>';
    const esc=s=>(s||'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
    // no enumerated candidate (a reagent/inorganic ion, a manually-added peak, or a
    // mass outside the organic window) — still surface the current assignment rather
    // than a bare "nothing here", so every peak shows its identity.
    if(p.formula||p.label){
      el.innerHTML=provenance+clusterNote+'<div class="cand chosen"><span class="f">'+esc(p.formula||p.label)+'</span>'+
        ((p.formula&&p.label&&p.label!==p.formula)?'<span class="cname">'+esc(p.label)+'</span>':'')+
        '<span class="meta">'+(assigned?'current formula assignment':'label only; not formula-assigned')+'</span></div>'+
        '<div class="idnote" style="margin-top:8px">No enumerated formula candidates for this m/z — it looks like a reagent/inorganic ion, a manually-added peak, or a mass outside the organic window. The existing '+(assigned?'formula assignment':'label')+' is kept as-is.</div>';
    } else {
      el.innerHTML=provenance+clusterNote+'<div class="mut">No candidate formulas for this peak (a reagent/inorganic ion, added manually, or outside the mass window).</div>';
    }
    return; }
  if(conf) conf.innerHTML=status+` <span class="mut">· ${p.candidates.length===1
    ? 'only generated formula candidate — not a confidence estimate'
    : 'relative candidate score/share (not identification confidence)'}</span>`+
    (p.id_ambiguous?' <span class="pill hi">ambiguous</span>':'');
  el.innerHTML=provenance+clusterNote+'<div class="idnote"><b>Assignment:</b> '+(assigned?'formula assigned — click another candidate to replace it.':'not assigned — click a candidate row to assign its formula.')+'</div>';
  p.candidates.forEach(c=>{ const row=document.createElement("div");
    const chosen=!!(p.formula&&c.formula===p.formula);
    row.className="cand"+(chosen?" chosen":"");
    const kb=c.k?(" · k="+(+c.k).toFixed(1)+(c.k_estimated?"~":"")):"";
    row.innerHTML=`<span class="f">${c.formula}</span>`+
      (c.name?`<span class="cname" title="compound name">${c.name}</span>`:``)+
      `<span class="meta">Δ${c.delta_mDa>=0?'+':''}${c.delta_mDa} mDa · DBE ${c.dbe}${kb}</span>`+
      (p.candidates.length===1?'':`<span class="bar"><span style="width:${Math.round(c.probability*100)}%"></span></span>`)+
      `<span class="p">${p.candidates.length===1?'only candidate':Math.round(c.probability*100)+'% share'}</span>`+
      `<span class="ev">${evText(c)}</span>`;
    row.onclick=()=>assignCandidate(p,c); el.appendChild(row); });
  if(p.overlap){ const n=document.createElement("div"); n.className="idnote warn"; n.style.marginTop="8px";
    n.textContent=(p.overlap.level==="unresolved"
      ? "⚠ Unresolved overlap with m/z "+p.overlap.neighbor+" ("+p.overlap.sep_mDa+" mDa) — closer than the instrument resolution, so this peak's Raw is unreliable even after deconvolution."
      : "Overlaps m/z "+p.overlap.neighbor+" ("+p.overlap.sep_mDa+" mDa) — Raw comes from Gaussian deconvolution (extra uncertainty).");
    el.appendChild(n); } }
function assignCandidate(p,c){
  // guard against assigning the same compound to two peaks (a compound = one m/z)
  const cf=(c.formula||'').toUpperCase(), cn=(c.name||'').toLowerCase();
  const clash=peaks.find(q=>q!==p && q.use && (cf?((q.formula||'').toUpperCase()===cf)
                                                 :(cn&&(q.label||'').toLowerCase()===cn)));
  if(clash && !confirm((c.name||c.formula)+" is already assigned to m/z "+clash.mz.toFixed(3)+
      ".\nAssign it here too? (a compound normally appears at only one m/z)")) return;
  pushUndo(); p.formula=c.formula; p.label=c.name||c.formula;
  if(c.k) p.k=c.k; p.k_estimated=!!c.k_estimated; if(c.flags) p.flags=c.flags; renderPeaks(); redraw(); }
let _lastScrolledRange=null;
function renderRanges(){ const tb=document.querySelector("#rngtbl tbody"); if(!tb) return; tb.innerHTML="";
  let selTr=null;
  ranges.forEach((r)=>{ const tr=document.createElement("tr");
    if(r._id===selRange){ tr.className="sel"; selTr=tr; }
    tr.innerHTML=`<td class="l"><input type="text" class="lbl" data-a="label" value="${(r.label||'').replace(/"/g,'&quot;')}"></td>`+
      `<td class="l"><select data-a="class"><option value="sample" ${r.class==='sample'?'selected':''}>sample</option>`+
        `<option value="background" ${r.class==='background'?'selected':''}>background</option></select></td>`+
      `<td class="mini" title="drag the interval edges in the plot to change">${r.start}–${r.end}</td>`;
    tr.onclick=ev=>{ if(ev.target.dataset.a) return; selRange=r._id; renderRanges(); jumpToInterval(r); };
    tr.querySelectorAll("[data-a]").forEach(el=>{ const act=el.dataset.a;
      el.onchange=()=>{ pushUndo(); r[act]=el.value;
        if(act==="class"){ renderRanges(); refreshSpecRange(); } redraw(); }; });
    tb.appendChild(tr); }); refreshSpecRange();
  // when the selection changes, scroll that row into view in the Intervals card
  if(selTr && selRange!==_lastScrolledRange){ selTr.scrollIntoView({block:"nearest",behavior:"smooth"}); }
  _lastScrolledRange=selRange; }
function jumpToInterval(r){ const pad=Math.max(8,(r.end-r.start)*0.6);
  if(tab!=="trace") setTab("trace"); animateTo(r.start-pad, r.end+pad, 300); }

// ---- config / save ----
function buildConfig(){ return {
  ...DATA.config_base,
  peaks: peaks.filter(p=>p.use).map(p=>{ const o={mz:p.mz,label:p.label};
    if(p.formula)o.formula=p.formula; if(p.k){o.k=p.k; o.k_estimated=!!p.k_estimated;}
    if(p.winManual){ if(Math.abs(p.winL-p.winR)<1e-6) o.window=+(p.winL*2).toFixed(5);
      else o.window={left:+p.winL.toFixed(5),right:+p.winR.toFixed(5)}; } return o; }),
  ranges: ranges.map(r=>({label:r.label,start:r.start,end:r.end,unit:"cycle"})),
  analyze:{ ...((DATA.config_base||{}).analyze||{}), R:cfg.R, R_phys:cfg.Rphys,
    K:cfg.K, molar_volume:cfg.Vm, primary_mz:cfg.primarymz,
    kinetic:cfg.kinetic, k_anchor:cfg.kanchor, humidity_correct:cfg.humid,
    humidity_p:cfg.hump, humidity_ref:cfg.href,
    whole_run_windows:cfg.wholewindows },
  // preserve the agent-authored review checklist so live-save doesn't strip it
  checklist:(DATA.checklist||[]).map(it=>it.detail?{text:it.text,detail:it.detail}:it.text)
}; }
let saveTimer=null;
function scheduleSave(){ if(!SERVED) return; setStat("saving…");
  clearTimeout(saveTimer); saveTimer=setTimeout(()=>{ fetch("/save",{method:"POST",
    headers:{"Content-Type":"application/json"},body:JSON.stringify(buildConfig())})
    .then(()=>setStat("saved ✓")).catch(()=>setStat("save failed")); },500); }
function setStat(s){ const el=document.getElementById("savestat"); if(el) el.textContent=s; }
function submitDone(){
  const ov=document.createElement("div"); ov.id="doneov";
  ov.innerHTML='<div class="ovcard"><div class="spinner"></div>'+
    '<h2 id="ovtitle">Running the analysis…</h2>'+
    '<p class="mut" id="ovmsg">Re-integrating the raw spectra at full precision and writing the results CSV. '+
    'This usually takes under a minute.</p>'+
    '<div class="bar"><div class="barfill"></div></div>'+
    '<p class="mut" id="ovtime" style="font-size:12px">0s elapsed</p></div>';
  document.body.appendChild(ov);
  const t0=performance.now();
  const timer=setInterval(()=>{ const el=document.getElementById("ovtime");
    if(el) el.textContent=((performance.now()-t0)/1000).toFixed(0)+"s elapsed"; },500);
  const finish=(html)=>{ clearInterval(timer); clearInterval(poll);
    document.querySelector("#doneov .ovcard").innerHTML=html; };
  const ackNow=()=>{ try{ if(navigator.sendBeacon) navigator.sendBeacon("/ack"); }catch(e){} };
  const poll=setInterval(()=>{ fetch("/status").then(r=>r.json()).then(st=>{
    if(st.status==="done"){
      const openBtn=st.out?'<button class="primary" id="openclose" style="margin:16px 0 6px">Open results &amp; close tab</button>':'';
      finish('<div class="check">✓</div><h2>Results ready</h2>'+
        '<p class="mut">The full-precision analysis is complete'+
        (st.out?' and was written to<br><code>'+st.out+'</code>':'')+'.</p>'+
        openBtn+
        '<p class="mut" style="font-size:12px">'+(st.out?'…or just ':'You can ')+'close this tab when you’re done.</p>');
      const ob=document.getElementById("openclose");
      if(ob) ob.onclick=()=>{ ob.disabled=true; ob.textContent="Opening…";
        // open the file first and wait for the server's confirmation; only report
        // success once it actually launched. Browsers block window.close() on a tab
        // they opened (not script-opened), so we don't depend on it — we tell the
        // user they can close the tab, and try close() as a best-effort convenience.
        fetch("/open",{method:"POST"}).then(r=>r.json()).catch(()=>({ok:false})).then(res=>{
          if(res&&res.ok){ ob.textContent="Opened ✓ — you can close this tab";
            setTimeout(()=>{ try{window.close()}catch(e){} },300); }
          else { ob.disabled=false; ob.textContent="Couldn’t open automatically — open it from: ";
            const code=document.createElement("code"); code.textContent=st.out||""; ob.after(code); } }); };
      // if the user just closes the tab (never clicks Open), let the CLI finish.
      window.addEventListener("pagehide",ackNow); window.addEventListener("beforeunload",ackNow);
    }
    else if(st.status==="error"){ finish('<div class="xmark">!</div><h2>Analysis failed</h2>'+
      '<p class="mut">'+(st.error||"Unknown error")+'</p>'+
      '<p class="mut" style="font-size:12px">Your edits were saved to the config; re-run from the terminal.</p>');
      ackNow(); }
  }).catch(()=>{}); },600);
  fetch("/done",{method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify(buildConfig())}).catch(()=>{});
}
function download(name,text){ const bl=new Blob([text],{type:"application/json"});
  const u=URL.createObjectURL(bl), a=document.createElement("a"); a.href=u; a.download=name; a.click(); URL.revokeObjectURL(u); }
function updateCalNote(){
  const el=document.getElementById("calnote"); if(!el) return;
  const available=!!(M.primary_available !== false && PC.primary && cfg.K!=null);
  el.innerHTML=available
    ? `K = ${fmt(cfg.K)} (${kSource}); Conc uses the primary-ion-normalised model.`
    : `No primary-ion / K available — Conc columns are unavailable for this file or until K is entered.`;
}
function redraw(){ updateMethods(); updateCalNote(); drawMain(); scheduleSave(); }

// ---- per-interval mass spectrum (served: fetched on demand; standalone: whole run only) ----
const specCache={};
function refreshSpecRange(){ const sel=document.getElementById("specrange"); if(!sel) return;
  const prev=sel.value; sel.innerHTML="";
  const add=(v,t)=>{ const o=document.createElement("option"); o.value=v; o.textContent=t; sel.appendChild(o); };
  add("all","whole run");
  if(SERVED){ ranges.forEach((r,i)=>add(""+i, r.label+" ("+r.start+"–"+r.end+")")); }
  else { const o=document.createElement("option"); o.value="_"; o.disabled=true;
    o.textContent="per-interval needs live mode"; sel.appendChild(o); }
  if([...sel.options].some(o=>o.value===prev)) sel.value=prev;
  else sel.value="all";   // start on the whole-run average, then switch to an interval to check drift
}
// spinner shown over the plot while an interval is averaged server-side
let _specTok=0, _spinTimer=null;
function showSpin(on,msg){ const el=document.getElementById("specspin"); if(!el) return;
  if(on){ const m=document.getElementById("specspinmsg"); if(m&&msg) m.textContent=msg; el.hidden=false; }
  else el.hidden=true; }
function setSpecRange(val){
  const tok=++_specTok; if(_spinTimer){ clearTimeout(_spinTimer); _spinTimer=null; } showSpin(false);
  const useWhole=()=>{ SHOWSPEC=SPEC; refineIntervalApexes(SHOWSPEC); drawSpec(); };
  if(val==="all"||val===""||val==null){ useWhole(); return; }
  const r=ranges[+val]; if(!r){ useWhole(); return; }
  const key=r.start+"_"+r.end;
  if(specCache[key]){ SHOWSPEC=specCache[key]; refineIntervalApexes(SHOWSPEC); drawSpec(); return; }
  // keep the currently-shown spectrum until the interval average loads, so the
  // peaks jump only once (straight to the real value) instead of via whole-run.
  // Only flash a spinner if the averaging actually takes a moment (>180ms).
  _spinTimer=setTimeout(()=>{ if(tok===_specTok) showSpin(true,"averaging "+(r.label||"interval")+"…"); },180);
  fetch("/spectrum?lo="+r.start+"&hi="+r.end).then(x=>x.json()).then(arr=>{
    specCache[key]=arr;
    if(tok===_specTok && document.getElementById("specrange").value===val){
      SHOWSPEC=arr; refineIntervalApexes(SHOWSPEC); drawSpec(); }
  }).catch(()=>{}).finally(()=>{ if(tok===_specTok){ if(_spinTimer){ clearTimeout(_spinTimer); _spinTimer=null; } showSpin(false); } }); }
// (re)load the spectrum for whatever interval is selected — called when the
// mass-spectrum tab is opened, so interval edits made on the trace tab are
// picked up in one batch rather than recomputing on every edit
function ensureSpecLoaded(){ const sel=document.getElementById("specrange"); if(sel) setSpecRange(sel.value); }
document.getElementById("specrange").onchange=e=>setSpecRange(e.target.value);

// ---- tab switching ----
function setTab(t){ tab=t; anim=null; hoverRange=null; hoverPeakId=null;
  document.querySelectorAll("#maintabs button").forEach(b=>b.classList.toggle("on",b.dataset.tab===t));
  const spec=t==="spec";
  document.getElementById("qtabs").style.display=spec?"none":"";
  document.getElementById("plotsub").textContent=spec
    ? "— intensity vs m/z (which compounds are present)"
    : "— the selected peak's intensity across the run (when it appears)";
  document.getElementById("leg-spec").style.display=spec?"":"none";
  document.getElementById("leg-trace").style.display=spec?"none":"";
  document.getElementById("spechint").style.display=spec?"":"none";
  document.getElementById("tracehint").style.display=spec?"none":"";
  document.getElementById("specrangewrap").style.display=spec?"":"none";
  document.getElementById("idcard").style.display=spec?"":"none";     // ID is spectrum-only
  document.getElementById("intcard").style.display=spec?"none":"";    // intervals are trace-only
  plotC.style.cursor="grab";
  // opening the spectrum tab: (re)average the selected interval so per-interval
  // peak positions are current after any interval edits; hide the spinner on leave
  if(spec){ if(typeof ensureSpecLoaded==="function") ensureSpecLoaded(); }
  else if(typeof showSpin==="function"){ if(_spinTimer){ clearTimeout(_spinTimer); _spinTimer=null; } showSpin(false); }
  relayout(); }
document.querySelectorAll("#maintabs button").forEach(b=>b.onclick=()=>setTab(b.dataset.tab));

// ---- controls ----
function setv(id,v){ const el=document.getElementById(id); if(el) el.value=v??""; }
setv("R",cfg.R); setv("Rphys",cfg.Rphys); setv("primarymz",cfg.primarymz);
setv("K",cfg.K); setv("Vm",cfg.Vm); setv("kanchor",cfg.kanchor); setv("hump",cfg.hump); setv("href",cfg.href);
document.getElementById("wholewindows").checked=cfg.wholewindows;
document.getElementById("kinetic").checked=cfg.kinetic;
document.getElementById("humid").checked=cfg.humid;
// Strict numeric parse: null = blank, NaN = not a valid number, else the number.
// parseFloat is too lenient ("19.0372s" -> 19.0372), so require the WHOLE string to be
// a decimal (optional sign, digits, optional fraction, optional exponent) before Number().
const NUMRE=/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
function parseNum(raw){ const s=String(raw).trim();
  if(s==="") return null;
  if(!NUMRE.test(s)) return NaN;
  const v=Number(s); return isFinite(v)?v:NaN; }
document.getElementById("R").onchange=e=>{ const v=parseNum(e.target.value);
  if(v===null||Number.isNaN(v)||v<=0){ e.target.value=cfg.R; return; }   // R must be a positive number
  pushUndo(); cfg.R=v; e.target.value=v;
  peaks.forEach(p=>{ if(!p.winManual){ const hw=p.apex/(2*cfg.R); p.winL=hw; p.winR=hw; } }); renderPeaks(); redraw(); };
// numeric config inputs: reject non-numbers (restore the last good value). allowEmpty -> blank means null.
function bind(id,key,allowEmpty){ const el=document.getElementById(id);
  el.onchange=()=>{ const v=parseNum(el.value);
    if(v===null){ if(allowEmpty){ cfg[key]=null; if(key==="K") kSource="browser edit"; redraw(); } else { el.value=(cfg[key]??""); } return; }
    if(Number.isNaN(v)){ el.value=(cfg[key]??""); return; }   // not a number -> discard, keep prior value
    cfg[key]=v; el.value=v;
    if(key==="K") kSource="browser edit";
    if(key==="Vm") vmSource="browser edit";
    redraw(); }; }
bind("K","K",true); bind("Vm","Vm",false); bind("Rphys","Rphys",false);
bind("primarymz","primarymz",false); bind("kanchor","kanchor",false);
bind("hump","hump",false); bind("href","href",true);
document.getElementById("kinetic").onchange=e=>{cfg.kinetic=e.target.checked;redraw();};
document.getElementById("humid").onchange=e=>{cfg.humid=e.target.checked;redraw();};
document.getElementById("wholewindows").onchange=e=>{cfg.wholewindows=e.target.checked;redraw();};
document.getElementById("resetK").onclick=()=>{ cfg.K=M.K_file??M.K_default; cfg.Vm=M.molar_volume_file??M.molar_volume;
  kSource=M.K_file_source||"file acquisition calibration";
  vmSource=M.molar_volume_file_source||"file drift temperature";
  setv("K",cfg.K); setv("Vm",cfg.Vm); redraw(); };
function staleSettings(){ return {
  primary:cfg.primarymz!==PREVIEW_INITIAL.primarymz,
  Rphys:cfg.Rphys!==PREVIEW_INITIAL.Rphys,
  windows:cfg.wholewindows!==PREVIEW_INITIAL.wholewindows
}; }
function staleRows(stale){ const rows=[];
  if(stale.primary) rows.push(`<b>primary m/z</b>: preview ${PREVIEW_INITIAL.primarymz} -> final ${cfg.primarymz}`);
  if(stale.Rphys) rows.push(`<b>R<sub>phys</sub></b>: preview ${PREVIEW_INITIAL.Rphys} -> final ${cfg.Rphys}`);
  if(stale.windows){ const p=PREVIEW_INITIAL.wholewindows?"whole-run":"per-interval";
    const f=cfg.wholewindows?"whole-run":"per-interval";
    rows.push(`<b>window mode</b>: preview ${p} -> final ${f}`); }
  return rows; }
function staleHtml(stale){ const rows=staleRows(stale); if(!rows.length) return "";
  return `<div class="stale"><b>PREVIEW STALE — Done-only re-extraction required.</b>
    Embedded plot data still represents the preview extraction. ${rows.join("; ")}.<br>
    The edited values apply in the authoritative Done rerun (or <code>ptr analyze</code>);
    they are not numerically recomputed in this page.</div>`; }
function updateStaleness(){ const stale=staleSettings(), rows=staleRows(stale);
  const banner=document.getElementById("stalebanner"); if(!banner) return;
  banner.hidden=!rows.length;
  banner.innerHTML=rows.length
    ? `<b>PREVIEW STALE — authoritative Done rerun required.</b> ${rows.join("; ")}. `+
      `Plots retain the embedded preview extraction; final values apply only after Done.`
    : ""; }
function updateMethods(){
  const live=document.getElementById("methodlive"); if(!live) return;
  Array.from(methodPanel.children).forEach(el=>{
    if(el!==live && el.tagName!=="H2") el.hidden=true;
  });
  const stale=staleSettings(); updateStaleness();
  const source=v=>v==="config.analyze"?"curated config":v==="cli"?"CLI override":v||"legacy default";
  const settingSource=(key,v)=>stale[key]?"browser edit":source(v);
  const src=M.sources||{};
  const rSource=source(src.R), rPhysSource=settingSource("Rphys",src.R_phys);
  const primarySource=settingSource("primary",src.primary_mz);
  const windowSource=settingSource("windows",src.whole_run_windows);
  const effectiveKSource=source(kSource||src.K);
  const effectiveVmSource=source(vmSource||src.molar_volume);
  const hrefSource=M.humidity_ref!=null?(M.humidity_ref_source||source(src.humidity_ref)):"run median";
  const trans=M.transmission_available?"the file's available transmission curve":"unit fallback (no transmission curve in the file)";
  const concentrationAvailable=!!(M.primary_available !== false && PC.primary && cfg.K!=null);
  M.concentration_available=concentrationAvailable;
  const conc=concentrationAvailable?"available":"unavailable (primary-ion signal or K is missing)";
  const kinetic=cfg.kinetic?"on":"off";
  const windows=cfg.wholewindows?"one whole-run window per compound":"isolated per-interval windows";
  live.innerHTML=staleHtml(stale)+`
    <h3>Effective settings</h3>
    <p><b>R integration windows:</b> R = ${cfg.R} (${rSource}); manual peak windows override the default.
    <b>R<sub>phys</sub> Gaussian/deconvolution resolution:</b> ${cfg.Rphys} (${rPhysSource}).</p>
    <p><b>K:</b> ${fmt(cfg.K)} (${effectiveKSource}); <b>molar volume:</b> ${fmt(cfg.Vm)} L/mol (${effectiveVmSource});
    <b>primary m/z:</b> ${cfg.primarymz} (${primarySource}).</p>
    <p><b>Kinetic correction:</b> ${kinetic}; k_anchor = ${cfg.kanchor} x 10<sup>-9</sup> cm³/s.
    Rate priority is explicit peak k, then formula match, then a unique m/z library match;
    estimated or unknown rates stay on shared K.</p>
    <p><b>Humidity correction:</b> ${cfg.humid?"on":"off"}; p = ${cfg.hump};
    water-cluster ratio is m/z 37 / m/z ${cfg.primarymz}; reference =
    ${cfg.href==null?"run median":cfg.href} (${hrefSource}).</p>
    <p><b>Windows:</b> ${windows} (${windowSource}); manual windows remain manual. Clustered components use fixed-centre
    Gaussian/deconvolution models, not interval apexes. Transmission uses ${trans}.
    Concentration is <b>${conc}</b>.</p>
    <h3>Authoritative export</h3>
    <p>Browser values are a preview. Live-safe controls update embedded data, but settings marked stale above need raw HDF5 re-extraction. <b>Done</b> performs the authoritative full-precision
    analyze rerun, including Gaussian deconvolution, and writes the CSV.</p>`;
}
document.querySelectorAll("#qtabs button").forEach(b=>b.onclick=()=>{ quant=b.dataset.q;
  document.querySelectorAll("#qtabs button").forEach(x=>x.classList.remove("on")); b.classList.add("on");
  document.getElementById("tracelbl").textContent=QSHORT[quant]; if(tab==="trace") drawTrace(); });
document.getElementById("zoomout").onclick=()=>zoomBy(1.6);
document.getElementById("zoomin").onclick=()=>zoomBy(1/1.6);
document.getElementById("zoomreset").onclick=()=>{
  if(tab==="spec"){ const p=selPeak();                       // reset = back to the selected compound's zoomed view
    if(p) jumpToPeak(p); else { initSpecView(); animateTo(vSpec.lo,vSpec.hi,180); } }
  else animateTo(1,NCYC,180); };
// peaks: details toggle — widen the sidebar instead of side-scrolling
document.getElementById("pkdetails").onclick=()=>{ showDetails=!showDetails;
  const app=document.getElementById("app");
  if(app) app.style.gridTemplateColumns=showDetails?"620px minmax(0,1fr)":"320px minmax(0,1fr)";
  const c=document.getElementById("peaksbody"); if(c){ c.style.maxHeight="calc(100vh - 190px)"; c.style.overflowX="hidden"; }
  renderPeaks();
  // the plot canvas reflows as the sidebar animates — keep it re-fitting for the duration
  const t0=Date.now(); (function follow(){ drawMain(); if(Date.now()-t0<340) requestAnimationFrame(follow); })(); };
// configuration / method slide-overs (shared scrim)
const cfgPanel=document.getElementById("cfgpanel"), methodPanel=document.getElementById("methodpanel"),
      checkPanel=document.getElementById("checkpanel"), scrim=document.getElementById("cfgscrim");
function closePanels(){ cfgPanel.hidden=true; methodPanel.hidden=true; checkPanel.hidden=true; scrim.hidden=true; }
function openPanel(p){ closePanels(); p.hidden=false; scrim.hidden=false; }
document.getElementById("cfgBtn").onclick=()=>openPanel(cfgPanel);
document.getElementById("cfgClose").onclick=closePanels;
document.getElementById("methodBtn").onclick=()=>openPanel(methodPanel);
document.getElementById("methodClose").onclick=closePanels;
document.getElementById("checkBtn").onclick=()=>openPanel(checkPanel);
document.getElementById("checkClose").onclick=closePanels;
// theme dropdown: click the icon to open, pick a mode, click-away/Esc to close
const themeMenu=document.getElementById("thememenu");
document.getElementById("themeBtn").onclick=e=>{ e.stopPropagation(); themeMenu.hidden=!themeMenu.hidden; };
themeMenu.querySelectorAll("button").forEach(el=>el.onclick=()=>{ setTheme(el.dataset.theme); themeMenu.hidden=true; });
document.addEventListener("click",e=>{ if(!themeMenu.hidden && !e.target.closest(".themewrap")) themeMenu.hidden=true; });
scrim.onclick=closePanels;
updateMethods();
// undo
const undoBtn=document.getElementById("undoBtn");
undoBtn.onclick=()=>undo();
document.addEventListener("keydown",e=>{
  const t=e.target, typing=t&&(t.tagName==="INPUT"||t.tagName==="TEXTAREA"||t.tagName==="SELECT");
  if(e.key==="Escape"){ if(tourArr){ endTour(); return; } closePanels(); if(themeMenu) themeMenu.hidden=true; return; }
  if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==="z"){ e.preventDefault(); undo(); return; }
  // ↑/↓ move the peak selection to the previous/next compound in the sidebar
  if(!typing && (e.key==="ArrowDown"||e.key==="ArrowUp") && peaks.length){
    e.preventDefault();
    const i=peaks.findIndex(p=>p.id===selId);
    const ni = i<0 ? (e.key==="ArrowDown"?0:peaks.length-1)
      : (e.key==="ArrowDown"?Math.min(peaks.length-1,i+1):Math.max(0,i-1));
    const np=peaks[ni]; if(np){ selectPeak(np);
      const box=document.getElementById("peaksbody");
      const li=box&&box.querySelectorAll("li")[ni]; if(li) li.scrollIntoView({block:"nearest"}); }
    return; }
  // Backspace/Del removes the SELECTED INTERVAL on the signal-over-time tab only
  // (peaks are removed via the ✕ in the peaks sidebar 'details' view, not the keyboard)
  if(!typing && (e.key==="Backspace"||e.key==="Delete") && tab==="trace" && selRange!=null){
    e.preventDefault(); deleteRange(selRange); }
});

// ---- review checklist (agent-authored, carried in the config) ----
const CHECK=(DATA.checklist||[]).map((it,i)=>({text:it.text,detail:it.detail||"",i}));
function clKey(i){ return "ptrms-clk:"+M.file+":"+i; }
function clDone(i){ try{ return localStorage.getItem(clKey(i))==="1"; }catch(e){ return false; } }
function setClDone(i,v){ try{ v?localStorage.setItem(clKey(i),"1"):localStorage.removeItem(clKey(i)); }catch(e){} }
function updateCheckBadge(){ let d=0; CHECK.forEach(it=>{ if(clDone(it.i)) d++; });
  const n=CHECK.length, badge=document.getElementById("checkbadge");
  if(badge){ const rem=n-d; badge.textContent=rem>0?String(rem):"✓"; badge.classList.toggle("done",rem===0); }
  const prog=document.getElementById("clprog"); if(prog) prog.textContent=d+" of "+n+" checked"; }
function renderChecklist(){ const body=document.getElementById("checkbody"); if(!body) return;
  body.innerHTML="";
  if(!CHECK.length){ body.innerHTML="<p class='mut' style='margin-top:14px'>No specific review notes for this run — check the peaks and intervals and you're good.</p>"; return; }
  const prog=document.createElement("p"); prog.className="clprog"; prog.id="clprog"; body.appendChild(prog);
  const ul=document.createElement("ul"); ul.className="cl";
  CHECK.forEach(it=>{ const li=document.createElement("li"); const done=clDone(it.i);
    if(done) li.classList.add("done");
    li.innerHTML="<input type=checkbox"+(done?" checked":"")+"><span><span class='cltext'></span>"+
      (it.detail?"<span class='cldetail'></span>":"")+"</span>";
    li.querySelector(".cltext").textContent=it.text;
    if(it.detail) li.querySelector(".cldetail").textContent=it.detail;
    const cb=li.querySelector("input");
    const toggle=v=>{ cb.checked=v; setClDone(it.i,v); li.classList.toggle("done",v); updateCheckBadge(); };
    cb.onclick=e=>{ e.stopPropagation(); toggle(cb.checked); };
    li.onclick=e=>{ if(e.target!==cb) toggle(!cb.checked); };
    ul.appendChild(li); });
  body.appendChild(ul); updateCheckBadge(); }
function maybeAutoChecklist(){ if(!CHECK.length) return; let seen=false;
  try{ seen=sessionStorage.getItem("ptrms-cl:"+M.file)==="1"; }catch(e){}
  if(seen) return; try{ sessionStorage.setItem("ptrms-cl:"+M.file,"1"); }catch(e){}
  openPanel(checkPanel); }

// ---- onboarding tour (coach-marks; skip/finish persisted in localStorage) ----
const TOURKEY="ptrms-onboarded";
let tourArr=null, tourIx=0;
function tourSteps(){ const s=[];
  if(CHECK.length) s.push({sel:"#checkBtn",place:"bottom",title:"Your review checklist",
    body:"Specific points I need you to confirm for this run live here — start with these; they’re what most needs a human eye."});
  // the workflow runs left-to-right: first get the intervals right, then the peaks
  s.push({sel:"#maintabs",place:"bottom",tab:"trace",title:"Step 1 — the intervals",
    body:"Start here, on Signal over time. Each shaded band is a sample or background interval. Getting these right comes first, because every compound is quantified per interval."});
  s.push({sel:"#intcard",place:"top",tab:"trace",title:"Adjust the intervals",
    body:"Check the sample/background split. Drag an interval’s edges to resize, ⌘/Ctrl-drag to add one, select and press Del to remove. Editing here recomputes the peak positions for that interval."});
  s.push({sel:".sidebar .card",place:"right",tab:"trace",title:"Plot a compound over time",
    body:"Every compound we detected is listed here. Click one to plot its signal over time — handy for sanity-checking that the intervals line up with when each compound actually rises and falls."});
  s.push({sel:"#maintabs",place:"bottom",tab:"spec",title:"Step 2 — the peaks",
    body:"Now switch to Mass spectrum to review each compound. Drag to pan, scroll to zoom."});
  s.push({sel:".sidebar .card",place:"right",tab:"spec",title:"Peaks",
    body:"Every compound we detected. Click one to select it and zoom to its mass peak; the shaded band is the m/z window that’s integrated for it."});
  s.push({sel:"#specrangewrap",place:"bottom",tab:"spec",title:"Review peaks per interval",
    body:"“Average over” picks which spectrum you’re looking at — it starts on the whole run. Isolated peaks can move a little between intervals, so their apex line and window re-centre on the local maximum; clustered Gaussian/deconvolved components stay at fixed model centres (not measured apexes)."});
  s.push({sel:"#idcard",place:"top",tab:"spec",title:"Identification",
    body:"Candidate formulas for the selected peak, ranked by exact mass and isotope pattern. Click one to assign it."});
  s.push({sel:"#cfgBtn",place:"bottom",title:"Settings",
    body:"Concentration constant K, molar volume, and the optional kinetic and humidity corrections."});
  s.push({sel:"#methodBtn",place:"bottom",title:"How it works",
    body:"A full plain-language write-up of how every number here is computed."});
  s.push({sel:"#exportrow",place:"bottom",title:"Finish up",
    body:"When everything looks right, click Done — the full-precision analysis re-runs and writes your results CSV."});
  return s; }
function buildTourDom(){ if(document.getElementById("tourblock")) return;
  const b=document.createElement("div"); b.id="tourblock";
  const sp=document.createElement("div"); sp.id="tourspot"; sp.hidden=true;
  const po=document.createElement("div"); po.id="tourpop"; po.hidden=true;
  b.onclick=e=>e.stopPropagation();
  document.body.append(b,sp,po); }
function positionTour(){ const step=tourArr[tourIx];
  if(step.tab && tab!==step.tab) setTab(step.tab);   // some steps live on a specific tab
  const el=document.querySelector(step.sel);
  if(!el){ if(tourIx<tourArr.length-1){ tourIx++; positionTour(); } else endTour(); return; }
  el.scrollIntoView({block:"nearest",behavior:"smooth"});
  const r=el.getBoundingClientRect(), pad=6;
  const spot=document.getElementById("tourspot"), pop=document.getElementById("tourpop");
  spot.hidden=false; spot.style.left=(r.left-pad)+"px"; spot.style.top=(r.top-pad)+"px";
  spot.style.width=(r.width+2*pad)+"px"; spot.style.height=(r.height+2*pad)+"px";
  pop.hidden=false;
  pop.innerHTML="<h3></h3><p></p><div class='trow'><span class='tstep'></span><span class='grow'></span>"+
    "<button class='ghost' id='tskip'>Skip</button><button class='ghost' id='tback'>Back</button>"+
    "<button class='primary' id='tnext'></button></div>";
  pop.querySelector("h3").textContent=step.title;
  pop.querySelector("p").textContent=step.body;
  pop.querySelector(".tstep").textContent=(tourIx+1)+" / "+tourArr.length;
  const back=pop.querySelector("#tback"); back.style.display=tourIx?"":"none";
  const next=pop.querySelector("#tnext"); next.textContent=(tourIx===tourArr.length-1)?"Done":"Next";
  pop.querySelector("#tskip").onclick=endTour;
  back.onclick=()=>{ if(tourIx){ tourIx--; positionTour(); } };
  next.onclick=nextTour;
  const pw=pop.offsetWidth, ph=pop.offsetHeight, gap=12, vw=innerWidth, vh=innerHeight;
  const clampL=x=>Math.max(10,Math.min(vw-pw-10,x)), clampT=y=>Math.max(10,Math.min(vh-ph-10,y));
  let left,top, place=step.place||"bottom";
  if(place==="right" && r.right+gap+pw<vw){ left=r.right+gap; top=r.top; }
  else if(place==="left" && r.left-gap-pw>0){ left=r.left-gap-pw; top=r.top; }
  else if(place==="top" && r.top-gap-ph>0){ left=r.left; top=r.top-gap-ph; }
  else { top=r.bottom+gap; if(top+ph>vh) top=r.top-gap-ph; left=r.left; }
  pop.style.left=clampL(left)+"px"; pop.style.top=clampT(top)+"px"; }
function nextTour(){ if(!tourArr) return;
  if(tourIx>=tourArr.length-1){ endTour(); return; } tourIx++; positionTour(); }
function startTour(){ closePanels(); buildTourDom(); tourArr=tourSteps(); tourIx=0;
  document.getElementById("tourblock").hidden=false; positionTour(); }
function endTour(){ try{ localStorage.setItem(TOURKEY,"1"); }catch(e){}
  tourArr=null; const b=document.getElementById("tourblock"), sp=document.getElementById("tourspot"),
    po=document.getElementById("tourpop");
  if(b) b.hidden=true; if(sp) sp.hidden=true; if(po) po.hidden=true; }
window.addEventListener("resize",()=>{ if(tourArr) positionTour(); });
document.getElementById("tourBtn").onclick=()=>startTour();

// ---- init ----
document.getElementById("file").textContent=M.file.split("/").pop();
document.getElementById("meta").textContent=
  `${NCYC.toLocaleString()} cycles · ${(NCYC*M.dur/60).toFixed(1)} min · ${peaks.length} peaks · ${ranges.length} intervals`;
// reflect the default quant in the trace sub-tabs + legend
document.querySelectorAll("#qtabs button").forEach(b=>b.classList.toggle("on",b.dataset.q===quant));
document.getElementById("tracelbl").textContent=QSHORT[quant];
updateCalNote();
const erow=document.getElementById("exportrow");
if(SERVED){ const b=document.createElement("button"); b.className="primary"; b.textContent="Done";
  b.onclick=submitDone; erow.appendChild(b); setStat("saved ✓");
  b.title="Changes save automatically"+(CFGPATH?` to ${CFGPATH}`:"")+
    ". Click to run the full-precision analysis and export the CSV.";
} else { const b=document.createElement("button"); b.className="primary"; b.textContent="Download config";
  b.onclick=()=>download("config.json",JSON.stringify(buildConfig(),null,2)); erow.appendChild(b);
  b.title="Hand this config back to the agent; it re-runs the analysis at full precision."; }
initSpecView(); clampView(); renderPeaks(); renderRanges();
// initial mass-spectrum view: zoomed onto the first compound rather than the whole range
// (same zoom as clicking the compound in the peak list — jumpToPeak's half-width)
if(peaks.length){ const p0=peaks[0], wmax=Math.max(p0.winL||0,p0.winR||0)||p0.apex/(2*cfg.R);
  const hw=Math.min(1.2,Math.max(0.18,wmax*10)); vSpec.lo=p0.apex-hw; vSpec.hi=p0.apex+hw; clampView(); }
setTab("trace");  // start on the intervals view — confirm segments first, then review peaks per interval
// review checklist: reveal the header button + render, then decide first-run behaviour
if(CHECK.length){ const cb=document.getElementById("checkBtn"); if(cb) cb.hidden=false; }
renderChecklist();
let _onboarded=true; try{ _onboarded=!!localStorage.getItem(TOURKEY); }catch(e){}
if(!_onboarded) setTimeout(startTour,650);          // first visit: guided tour
else maybeAutoChecklist();                          // returning user: surface the checklist once
</script>
</body>
</html>
"""
