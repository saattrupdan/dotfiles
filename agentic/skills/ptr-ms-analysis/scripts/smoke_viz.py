#!/usr/bin/env python3
"""Browser regression test for the generated PTR-MS review page.

This deliberately uses the installed ``agent-browser`` CLI rather than a browser
framework.  The page is generated from deterministic synthetic data, served from
an in-process HTTP server, and exercised in headless Chrome through real DOM
interactions.  Keep this test small: it protects the identification contract
without making the package grow a frontend test dependency.
"""

from __future__ import annotations

import http.server
import json
import shutil
import socketserver
import subprocess
import sys
import threading
from typing import Any, Dict, Optional

import viz


SESSION = "ptr-ms-viz-regression"


def _candidate(formula: str, name: str, probability: float) -> Dict[str, Any]:
    """Return the smallest candidate record accepted by the review UI."""
    return {
        "formula": formula,
        "name": name,
        "ion_mz": 100.0,
        "delta_mDa": 0.0,
        "dbe": 1.0,
        "k": None,
        "k_estimated": True,
        "flags": [],
        "iso_pred": [0.01, 0.01],
        "iso_obs": None,
        "iso_used": False,
        "probability": probability,
    }


def _synthetic_data() -> Dict[str, Any]:
    """Build a stable, standalone review payload without an HDF5 fixture."""
    return {
        "meta": {
            "file": "synthetic-review.h5",
            "ncyc": 4,
            "dur": 1.0,
            "a": 1000.0,
            "b": 0.0,
            "R": 1500.0,
            "R_phys": 3100.0,
            "primary_mz": 19.022,
            "proton": 1.0073,
            "k_anchor": 1.7,
            "kinetic": True,
            "humidity_correct": True,
            "humidity_p": 0.6,
            "humidity_ref": 1.3,
            "whole_run_windows": False,
            "sources": {
                "R": "config.analyze", "R_phys": "config.analyze",
                "primary_mz": "config.analyze", "whole_run_windows": "config.analyze",
                "K": "config.analyze", "molar_volume": "config.analyze",
            },
            "K_source": "config.analyze",
            "K_file": 0.8,
            "K_file_source": "file acquisition calibration",
            "K_default": 1.0,
            "molar_volume": 24.5,
            "molar_volume_source": "config.analyze",
            "molar_volume_file": 24.0,
            "molar_volume_file_source": "file drift temperature",
            "primary_available": True,
            "humidity_ref_default": 1.0,
            "concentration_available": True,
        },
        "transmission": {"masses": [50.0, 200.0], "factors": [1.0, 1.0]},
        "per_cycle": {
            "primary": [100.0, 100.0, 100.0, 100.0],
            "humidity": [1.0, 1.0, 1.0, 1.0],
            "discriminator": [1.0, 1.0, 1.0, 1.0],
        },
        # The values are only for painting the deterministic canvas.  The review
        # assertions below concern the identification card and its interactions.
        "spectrum": [10] * 13000,
        "peaks": [
            {
                "id": 0,
                "mz": 100.0,
                "apex": 100.0,
                "label": "Unassigned sole candidate",
                "formula": "",
                "k": None,
                "k_estimated": False,
                "flags": [],
                "clustered": False,
                "win_l": 0.04,
                "win_r": 0.04,
                "win_manual": True,
                "trace": [10.0, 10.0, 20.0, 20.0],
                "candidates": [
                    _candidate("C2H6O", "Ethanol candidate", 1.0),
                ],
                "id_confidence": 1.0,
                "id_ambiguous": False,
                "overlap": None,
            },
            {
                "id": 1,
                "mz": 110.0,
                "apex": 110.0,
                "label": "Ambiguous mix",
                "formula": "",
                "k": None,
                "k_estimated": False,
                "flags": [],
                "clustered": False,
                "win_l": 0.04,
                "win_r": 0.04,
                "win_manual": True,
                "trace": [20.0, 20.0, 20.0, 20.0],
                "candidates": [
                    _candidate("C4H10O", "Candidate one", 0.72),
                    _candidate("C5H12", "Candidate two", 0.28),
                ],
                "id_confidence": 0.72,
                "id_ambiguous": True,
                "overlap": None,
            },
            {
                "id": 2,
                "mz": 120.0,
                "apex": 120.0,
                "label": "Curated solvent",
                "formula": "C3H8O",
                "k": None,
                "k_estimated": False,
                "flags": [],
                "clustered": False,
                "win_l": 0.04,
                "win_r": 0.04,
                "win_manual": True,
                "trace": [30.0, 30.0, 30.0, 30.0],
                "candidates": [
                    _candidate("C3H8O", "Library solvent", 0.65),
                    _candidate("C4H10", "Other generated candidate", 0.35),
                ],
                "id_confidence": 0.65,
                "id_ambiguous": True,
                "overlap": None,
            },
            {
                "id": 3,
                "mz": 130.0,
                "apex": 130.0,
                "label": "Cluster component A",
                "formula": "",
                "k": None,
                "k_estimated": False,
                "flags": [],
                "clustered": True,
                "win_l": 130.0 / (2.0 * 1200.0),
                "win_r": 130.0 / (2.0 * 1200.0),
                "win_manual": False,
                "trace": [40.0, 40.0, 40.0, 40.0],
                "candidates": [],
                "id_confidence": None,
                "id_ambiguous": False,
                "overlap": {"neighbor": 130.05, "sep_mDa": 50.0, "level": "deconvolved"},
            },
            {
                "id": 4,
                "mz": 130.05,
                "apex": 130.05,
                "label": "Cluster component B",
                "formula": "",
                "k": None,
                "k_estimated": False,
                "flags": [],
                "clustered": True,
                "win_l": 130.05 / (2.0 * 1200.0),
                "win_r": 130.05 / (2.0 * 1200.0),
                "win_manual": False,
                "trace": [35.0, 35.0, 35.0, 35.0],
                "candidates": [],
                "id_confidence": None,
                "id_ambiguous": False,
                "overlap": {"neighbor": 130.0, "sep_mDa": 50.0, "level": "deconvolved"},
            },
            {
                "id": 5,
                "mz": 140.0,
                "apex": 140.0,
                "label": "Isolated control",
                "formula": "",
                "k": None,
                "k_estimated": False,
                "flags": [],
                "clustered": False,
                "win_l": 140.0 / (2.0 * 1200.0),
                "win_r": 140.0 / (2.0 * 1200.0),
                "win_manual": False,
                "trace": [25.0, 25.0, 25.0, 25.0],
                "candidates": [],
                "id_confidence": None,
                "id_ambiguous": False,
                "overlap": None,
            },
        ],
        "ranges": [
            {"label": "sample_01", "start": 1, "end": 2, "class": "sample"},
            {"label": "sample_02", "start": 3, "end": 4, "class": "sample"},
        ],
        "config_base": {"unknown_top_level": {"keep": True},
                        "analyze": {"unknown_setting": "keep"}},
        "checklist": [],
        "rate_constants": [],
    }


class _ReviewHandler(http.server.BaseHTTPRequestHandler):
    """Serve the generated page and deterministic whole/interval spectra."""

    html = ""
    spectrum = b"[]"
    interval_spectrum = b"[]"
    posts = []

    def log_message(self, *_args: Any) -> None:
        pass

    def do_POST(self) -> None:  # noqa: N802 - stdlib handler API
        length = int(self.headers.get("Content-Length", "0"))
        body = json.loads(self.rfile.read(length) or b"{}")
        self.posts.append((self.path, body))
        payload = b'{"ok":true}'
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self) -> None:  # noqa: N802 - stdlib handler API
        if self.path in ("/", "/index.html"):
            body, content_type = self.html.encode("utf-8"), "text/html; charset=utf-8"
        elif self.path.startswith("/spectrum"):
            body, content_type = self.interval_spectrum, "application/json"
        else:
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def _browser(session: str, *args: str, stdin: Optional[str] = None) -> str:
    """Run one agent-browser command and return its stdout."""
    completed = subprocess.run(
        ["agent-browser", "--session", session, *args],
        input=stdin,
        capture_output=True,
        text=True,
        check=False,
    )
    if completed.returncode:
        detail = (completed.stderr or completed.stdout).strip()
        raise AssertionError("agent-browser %s failed: %s" % (" ".join(args), detail))
    return completed.stdout.strip()


def _eval(session: str, expression: str) -> Dict[str, Any]:
    """Evaluate JSON.stringify(expression) in the actual browser page."""
    raw = _browser(
        session, "eval", "--stdin", stdin="JSON.stringify(" + expression + ")"
    )
    value: Any = json.loads(raw)
    if isinstance(value, str):
        value = json.loads(value)
    if not isinstance(value, dict):
        raise AssertionError("browser expression did not return an object")
    return value


def _assert(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def _assert_complete_posts(expected: Dict[str, Any], path: str, start: int) -> int:
    """Require every new request body to equal the browser's full config snapshot."""
    recent = [body for posted_path, body in _ReviewHandler.posts[start:] if posted_path == path]
    _assert(recent, "browser did not POST %s after the edit" % path)
    _assert(all(body == expected for body in recent),
            "%s body differs from the browser's complete buildConfig()" % path)
    return len(_ReviewHandler.posts)


def _assert_config_round_trip(config: Dict[str, Any]) -> None:
    """Check fields whose loss would make a saved review non-reproducible."""
    _assert(config["unknown_top_level"]["keep"], "unknown top-level field was dropped")
    _assert(config["analyze"]["unknown_setting"] == "keep",
            "unknown analyze field was dropped")
    _assert([peak["mz"] for peak in config["peaks"]]
            == [100, 110, 120, 130, 130.05, 140],
            "peaks did not round-trip")
    _assert([(item["label"], item["start"], item["end"])
              for item in config["ranges"]]
            == [("sample_01", 1, 2), ("sample_02", 3, 4)],
            "ranges did not round-trip")
    _assert(config["checklist"] == [], "checklist did not round-trip")


def _interval_spectrum() -> list[int]:
    """Return an interval spectrum whose shared maximum exposes re-centring bugs."""
    spectrum = [1] * 13000
    # m/z 130.0284 is inside both clustered search neighbourhoods and dominates
    # them. The isolated control has its own shifted maximum at m/z 140.0199.
    spectrum[11403] = 100
    spectrum[11833] = 80
    return spectrum


def main() -> int:
    if shutil.which("agent-browser") is None:
        raise SystemExit(
            "agent-browser is required; install it with: npm i -g agent-browser"
        )

    data = _synthetic_data()
    _ReviewHandler.html = viz.render_html(data)
    _ReviewHandler.spectrum = json.dumps(data["spectrum"]).encode("ascii")
    _ReviewHandler.interval_spectrum = json.dumps(_interval_spectrum()).encode("ascii")
    _ReviewHandler.posts = []
    server = socketserver.ThreadingTCPServer(("127.0.0.1", 0), _ReviewHandler)
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    session = "%s-%s" % (SESSION, threading.get_ident())

    try:
        port = server.server_address[1]
        _browser(session, "open", "http://127.0.0.1:%d/" % port)
        # The first-visit tour is useful to people but would make this regression
        # nondeterministic; mark it complete before reloading the generated page.
        _browser(session, "eval", "localStorage.setItem('ptrms-onboarded', '1')")
        _browser(session, "reload")
        _browser(session, "wait", "--load", "networkidle")
        # Discard any delayed request from the previous page/session before the
        # first controlled edit; every request below has a matching snapshot.
        _ReviewHandler.posts = []
        post_cursor = 0

        # Methods is live provenance, not static help: inspect curated non-default
        # settings, edit the controls, and verify both save and Done payloads.
        _browser(session, "eval", "document.querySelector('#methodBtn').click()")
        initial_methods = _eval(
            session,
            "({text:document.querySelector('#methodlive').innerText, kinetic:cfg.kinetic, "
            "R:cfg.R, Rphys:cfg.Rphys, primary:cfg.primarymz, humid:cfg.humid, "
            "humidChecked:document.querySelector('#humid').checked})",
        )
        _assert("R integration windows" in initial_methods["text"],
                "Methods omits R: %r" % initial_methods["text"][:200])
        _assert("Rphys" in initial_methods["text"], "Methods omits physical resolution")
        _assert("Kinetic correction: on" in initial_methods["text"], "kinetic state is stale")
        _assert("curated config" in initial_methods["text"], "configured source is missing")
        _assert(initial_methods["humid"] and initial_methods["humidChecked"],
                "humidity checkbox did not initialise from the effective config")
        _assert(initial_methods["R"] == 1500 and initial_methods["primary"] == 19.022,
                "curated Methods settings did not initialise the browser")
        _browser(
            session,
            "eval",
            "(() => { const set=(id,v)=>{const e=document.querySelector('#'+id);"
            "e.value=v; e.dispatchEvent(new Event('change',{bubbles:true}));}; "
            "set('R','1700'); set('Rphys','3300'); set('primarymz','20.022'); "
            "set('K','2.5'); set('Vm','25.5'); set('kanchor','2.2'); set('hump','0.8'); "
            "set('href','1.7'); document.querySelector('#kinetic').click(); "
            "document.querySelector('#humid').click(); document.querySelector('#wholewindows').click(); })()",
        )
        _browser(session, "wait", "1000")
        edited = _eval(
            session,
            "({text:document.querySelector('#methodlive').innerText, "
            "banner:document.querySelector('#stalebanner').innerText, "
            "config:buildConfig(), humidChecked:document.querySelector('#humid').checked, "
            "stale:staleSettings(), served:SERVED, protocol:location.protocol})",
        )
        _assert(edited["served"], "browser did not recognise the HTTP review server")
        _assert("Kinetic correction: off" in edited["text"], "Methods did not update kinetic state")
        _assert("browser edit" in edited["text"], "Methods did not update calibration provenance")
        _assert("PREVIEW STALE" in edited["text"] and "PREVIEW STALE" in edited["banner"],
                "re-extraction edits were not prominently marked stale")
        _assert("Done-only" in edited["text"] and "preview 19.022" in edited["text"]
                and "final 20.022" in edited["text"],
                "stale Methods wording did not distinguish preview and final values")
        _assert(edited["stale"] == {"primary": True, "Rphys": True, "windows": True},
                "stale settings did not track the edited re-extraction values")
        _assert("m/z 37 / m/z 20.022" in edited["text"],
                "Methods did not update humidity denominator")
        _assert(not edited["humidChecked"], "humidity checkbox did not update")
        _assert(edited["config"]["analyze"]["R_phys"] == 3300,
                "R_phys control was not exported")
        _assert(edited["config"]["analyze"]["primary_mz"] == 20.022,
                "primary m/z control was not exported")
        _assert(edited["config"]["analyze"]["whole_run_windows"],
                "window mode control was not exported")
        _assert_config_round_trip(edited["config"])
        post_cursor = _assert_complete_posts(edited["config"], "/save", post_cursor)
        # Reverting exactly to the immutable preview settings must clear every stale
        # marker and restore the original provenance, not leave a sticky warning.
        post_cursor = len(_ReviewHandler.posts)
        _browser(session, "eval", "(() => { const set=(id,v)=>{const e=document.querySelector('#'+id);"
                 "e.value=v; e.dispatchEvent(new Event('change',{bubbles:true}));}; "
                 "set('Rphys','3100'); set('primarymz','19.022'); "
                 "document.querySelector('#wholewindows').click(); })()")
        _browser(session, "wait", "1000")
        reverted = _eval(session, "({text:document.querySelector('#methodlive').innerText, "
                               "banner:document.querySelector('#stalebanner').innerText, "
                               "stale:staleSettings(), config:buildConfig()})")
        _assert(reverted["stale"] == {"primary": False, "Rphys": False, "windows": False},
                "reverting to preview settings left stale state behind")
        _assert(reverted["banner"] == "" and "PREVIEW STALE" not in reverted["text"],
                "reverting to preview settings left a stale warning behind")
        _assert("primary m/z: 19.022 (curated config)" in reverted["text"]
                and "Rphys" in reverted["text"],
                "reverting did not restore initial setting provenance")
        post_cursor = _assert_complete_posts(reverted["config"], "/save", post_cursor)
        # Leave the final Done payload edited, so the smoke covers the actual
        # authoritative rerun configuration after a stale->fresh transition.
        post_cursor = len(_ReviewHandler.posts)
        _browser(session, "eval", "(() => { const set=(id,v)=>{const e=document.querySelector('#'+id);"
                 "e.value=v; e.dispatchEvent(new Event('change',{bubbles:true}));}; "
                 "set('Rphys','3300'); set('primarymz','20.022'); "
                 "document.querySelector('#wholewindows').click(); })()")
        _browser(session, "wait", "1000")
        final_preview = _eval(session, "({config:buildConfig(), stale:staleSettings()})")
        _assert(final_preview["stale"] == {"primary": True, "Rphys": True, "windows": True},
                "final edited settings did not become stale again")
        _assert_config_round_trip(final_preview["config"])
        post_cursor = _assert_complete_posts(final_preview["config"], "/save", post_cursor)
        post_cursor = len(_ReviewHandler.posts)
        _browser(session, "eval", "document.querySelector('#K').value=''; document.querySelector('#K').dispatchEvent(new Event('change',{bubbles:true}))")
        _browser(session, "wait", "700")
        unavailable = _eval(session, "({methods:document.querySelector('#methodlive').innerText, "
                                 "note:document.querySelector('#calnote').innerText, config:buildConfig()})")
        _assert("Concentration is unavailable" in unavailable["methods"] and "unavailable" in unavailable["note"],
                "concentration availability did not update when K was cleared")
        _assert_config_round_trip(unavailable["config"])
        post_cursor = _assert_complete_posts(unavailable["config"], "/save", post_cursor)
        post_cursor = len(_ReviewHandler.posts)
        _browser(session, "eval", "document.querySelector('#K').value='2.5'; document.querySelector('#K').dispatchEvent(new Event('change',{bubbles:true}))")
        _browser(session, "wait", "700")
        filled = _eval(session, "({config:buildConfig()})")
        post_cursor = _assert_complete_posts(filled["config"], "/save", post_cursor)
        post_cursor = len(_ReviewHandler.posts)
        _browser(session, "eval", "document.querySelector('#resetK').click()")
        _browser(session, "wait", "700")
        reset = _eval(session, "({K:cfg.K,Vm:cfg.Vm,text:document.querySelector('#methodlive').innerText,"
                           "note:document.querySelector('#calnote').innerText,config:buildConfig()})")
        _assert(reset["K"] == 0.8 and reset["Vm"] == 24.0, "reset did not restore file-derived calibration")
        _assert_config_round_trip(reset["config"])
        post_cursor = _assert_complete_posts(reset["config"], "/save", post_cursor)
        _assert("file acquisition calibration" in reset["text"] and "file drift temperature" in reset["text"],
                "reset provenance is not file-derived")
        _browser(session, "eval", "document.querySelector('#methodClose').click()")
        # Switch from the initial intervals view to the actual identification card.
        _browser(
            session,
            "find",
            "role",
            "button",
            "click",
            "--name",
            "Mass spectrum",
            "--exact",
        )

        # Select the clustered component and load an interval whose shared maximum
        # sits between both model centres. The browser must not turn that maximum
        # into two displayed apexes, while the isolated control still follows it.
        _browser(session, "find", "nth", "3", ".plist li", "click")
        _browser(
            session,
            "eval",
            "(() => { const s=document.querySelector('#specrange'); s.value='0'; "
            "s.dispatchEvent(new Event('change')); })()",
        )
        _browser(session, "wait", "1000")
        clustered = _eval(
            session,
            "(() => { const ps=[peaks[3],peaks[4]]; "
            "const ws=ps.map(p => { const ax=dispApex(p), "
            "tb=windowTB(ax,p.winL,p.winR); "
            "return {centre:ax,left:tb2m(tb[0]),right:tb2m(tb[1])}; }); "
            "const intersection=Math.max(0,Math.min(ws[0].right,ws[1].right)-"
            "Math.max(ws[0].left,ws[1].left)); "
            "const union=Math.max(ws[0].right,ws[1].right)-"
            "Math.min(ws[0].left,ws[1].left); "
            "return {windows:ws, overlap:intersection/union, isolated:dispApex(peaks[5]), "
            "note:document.querySelector('#idpanel').innerText}; })()",
        )
        _assert(
            [item["centre"] for item in clustered["windows"]] == [130, 130.05],
            "clustered displayed centres moved onto the shared interval maximum",
        )
        _assert(
            clustered["overlap"] < 0.6,
            "clustered displayed windows became duplicate-like after interval loading",
        )
        _assert(
            clustered["isolated"] > 140.01,
            "isolated control did not re-centre on its interval maximum",
        )
        _assert(
            "fixed model centre" in clustered["note"]
            and "not a measured apex" in clustered["note"],
            "clustered-peak wording is missing from the identification card",
        )
        preview = _eval(session, "({whole:M.whole_run_windows, first:rawTrace(peaks[0])})")
        _assert(preview["whole"] is False and preview["first"]["2"] > preview["first"]["0"],
                "per-interval preview did not preserve interval-specific trace values")
        _browser(session, "find", "nth", "0", ".plist li", "click")

        sole = _eval(
            session,
            "{conf:document.querySelector('#idconf').innerText, "
            "panel:document.querySelector('#idpanel').innerText, "
            "candidateLabel:document.querySelector('#idpanel .p').innerText, "
            "provenance:document.querySelector('#idpanel').innerText}",
        )
        _assert(
            "not assigned" in sole["conf"].lower(),
            "sole candidate is not visibly unassigned",
        )
        _assert(
            "only candidate" in sole["candidateLabel"],
            "sole candidate lost its explicit state",
        )
        _assert(
            "100%" not in sole["conf"], "sole candidate is presented as 100% confidence"
        )
        _assert(
            "formula ranking cannot determine structural isomers" in sole["provenance"],
            "identification card omits the provenance/isomer limitation",
        )

        # Select the unassigned multi-candidate peak, then inspect relative shares.
        _browser(session, "find", "nth", "1", ".plist li", "click")
        multiple = _eval(
            session,
            "{conf:document.querySelector('#idconf').innerText, "
            "shares:Array.from(document.querySelectorAll('#idpanel .p')).map(x=>x.innerText), "
            "provenance:document.querySelector('#idpanel').innerText}",
        )
        _assert(
            "not assigned" in multiple["conf"].lower(),
            "multi-candidate peak is not visibly unassigned",
        )
        _assert(
            multiple["shares"] == ["72% share", "28% share"],
            "candidate percentages are not relative shares",
        )
        _assert(
            "100%" not in multiple["conf"],
            "multi-candidate card shows confidence wording",
        )
        _assert(
            "formula ranking cannot determine structural isomers"
            in multiple["provenance"],
            "multi-candidate card omits provenance text",
        )

        # This is a real click on the second rendered candidate row.  It must
        # update the assignment rather than merely changing source/data strings.
        post_cursor = len(_ReviewHandler.posts)
        _browser(
            session,
            "eval",
            "document.querySelectorAll('#idpanel .cand')[1].click()",
        )
        _browser(session, "wait", "700")
        assigned = _eval(
            session,
            "{conf:document.querySelector('#idconf').innerText, "
            "assignment:document.querySelector('#idpanel .idnote').innerText, "
            "config:buildConfig()}",
        )
        _assert_config_round_trip(assigned["config"])
        post_cursor = _assert_complete_posts(assigned["config"], "/save", post_cursor)
        _assert(
            "assigned" in assigned["conf"].lower(),
            "candidate click did not assign the formula",
        )
        _assert(
            "C5H12" in assigned["conf"], "clicked candidate formula was not retained"
        )

        # Finally, verify a curated assignment remains authoritative while its
        # label and formula are both visible in their respective UI locations.
        _browser(session, "find", "nth", "2", ".plist li", "click")
        curated = _eval(
            session,
            "{label:document.querySelector('.plist li.sel input.lbl').value, "
            "conf:document.querySelector('#idconf').innerText, "
            "chosen:document.querySelector('#idpanel .cand.chosen').innerText}",
        )
        _assert(curated["label"] == "Curated solvent", "curated label was overwritten")
        _assert(
            "assigned" in curated["conf"].lower() and "C3H8O" in curated["conf"],
            "curated formula is not authoritative",
        )
        _assert(
            "C3H8O" in curated["chosen"],
            "assigned formula is not marked in the candidate card",
        )

        done_cursor = len(_ReviewHandler.posts)
        _browser(session, "find", "role", "button", "click", "--name", "Done")
        _browser(session, "wait", "800")
        posted = _eval(session, "({config:buildConfig()})")
        _assert_config_round_trip(posted["config"])
        save_posts = [body for path, body in _ReviewHandler.posts if path == "/save"]
        _assert(save_posts and save_posts[-1] == posted["config"],
                "latest save body differs from the browser's complete buildConfig()")
        done_posts = [body for path, body in _ReviewHandler.posts[done_cursor:]
                      if path == "/done"]
        _assert(done_posts and all(body == posted["config"] for body in done_posts),
                "Done body differs from the browser's complete buildConfig()")
        print("viz browser identification/configuration regression: OK")
        return 0
    finally:
        _browser(session, "close")
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (AssertionError, json.JSONDecodeError) as exc:
        print("viz browser identification regression: FAIL: %s" % exc, file=sys.stderr)
        raise SystemExit(1)
