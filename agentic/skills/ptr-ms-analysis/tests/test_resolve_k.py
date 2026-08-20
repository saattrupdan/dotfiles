"""Focused regression tests for rate constants and chemical flags."""

import importlib
import io
import json
import sys
import tempfile
import unittest
from argparse import Namespace
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

import h5py
import numpy as np

sys.path.insert(0, str(Path(__file__).parents[1] / "scripts"))
analyze = importlib.import_module("analyze")
ptrms = importlib.import_module("ptrms")


RATE_TABLE = {
    "compounds": [
        {
            "name": "formula match",
            "formula": "C2H4",
            "mz": 100.0,
            "k": 1.4,
            "k_estimated": True,
            "flags": ["humid"],
        },
        {
            "name": "formula competitor",
            "formula": "C2H6",
            "mz": 100.01,
            "k": 2.0,
            "flags": ["frag"],
        },
        {
            "name": "unique mass match",
            "formula": "CH2O",
            "mz": 150.01,
            "k": 3.2,
            "flags": ["humid"],
        },
        {
            "name": "ambiguous one",
            "formula": "C3H6",
            "mz": 200.0,
            "k": 2.1,
            "flags": ["humid"],
        },
        {
            "name": "ambiguous two",
            "formula": "C3H8",
            "mz": 200.02,
            "k": 2.2,
            "flags": ["frag"],
        },
    ]
}


class ResolveKTest(unittest.TestCase):
    def test_explicit_k_inherits_formula_flags(self):
        result = ptrms.resolve_k(
            [{"mz": 100.0, "formula": "c2h4", "k": 2.75e-9, "k_estimated": True}],
            RATE_TABLE,
        )[100.0]

        self.assertAlmostEqual(result["k"], 2.75)
        self.assertEqual(result["source"], "explicit")
        self.assertTrue(result["k_estimated"])
        self.assertEqual(result["flags"], ["humid"])

    def test_explicit_k_inherits_unique_mz_flags(self):
        result = ptrms.resolve_k(
            [{"mz": 150.0, "formula": "unknown", "k": 2.75}], RATE_TABLE
        )[150.0]

        self.assertEqual(result["k"], 2.75)
        self.assertEqual(result["source"], "explicit")
        self.assertFalse(result["k_estimated"])
        self.assertEqual(result["flags"], ["humid"])

    def test_explicit_k_does_not_invent_flags_for_ambiguous_or_missing_match(self):
        peaks = [
            {"mz": 200.01, "k": 2.75},
            {"mz": 300.0, "formula": "unknown", "k": 2.75},
        ]

        result = ptrms.resolve_k(peaks, RATE_TABLE)

        for mz in (200.01, 300.0):
            self.assertEqual(result[mz]["k"], 2.75)
            self.assertEqual(result[mz]["source"], "explicit")
            self.assertEqual(result[mz]["flags"], [])

    def test_non_explicit_resolution_behavior_is_preserved(self):
        peaks = [
            {"mz": 100.0, "formula": "C2H4"},
            {"mz": 150.0},
            {"mz": 200.01},
        ]

        result = ptrms.resolve_k(peaks, RATE_TABLE)

        self.assertEqual(
            result[100.0],
            {
                "k": 1.4,
                "source": "formula:formula match",
                "flags": ["humid"],
                "k_estimated": True,
            },
        )
        self.assertEqual(result[150.0]["source"], "mz:unique mass match")
        self.assertEqual(result[150.0]["flags"], ["humid"])
        self.assertIsNone(result[200.01]["k"])
        self.assertEqual(
            result[200.01]["source"], "ambiguous:ambiguous one,ambiguous two"
        )
        self.assertEqual(result[200.01]["flags"], [])


class HumidityDiagnosticTest(unittest.TestCase):
    def test_config_with_explicit_k_reports_humidity_diagnostics(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            h5_path = tmp_path / "fixture.h5"
            config_path = tmp_path / "config.json"
            with h5py.File(h5_path, "w") as h5:
                h5.create_dataset("SPECdata/Intensities", data=np.ones((4, 2)))
            config_path.write_text(
                json.dumps(
                    {
                        "peaks": [
                            {
                                "mz": 29.0386,
                                "formula": "C2H4",
                                "label": "ethene",
                                "k": 2.75,
                                "k_estimated": False,
                            }
                        ],
                        "ranges": [
                            {"label": "sample_01", "start": 1, "end": 4}
                        ],
                        "analyze": {"kinetic": True},
                    }
                ),
                encoding="utf-8",
            )
            args = Namespace(
                h5=str(h5_path),
                config=str(config_path),
                peaks_json=None,
                ranges_json=None,
                auto_peaks=False,
                auto_segments=False,
                no_per_interval=None,
                R=None,
                R_phys=None,
                K=None,
                primary_mz=None,
                kinetic=None,
                k_anchor=None,
                humidity_correct=None,
                humidity_p=None,
                humidity_ref=None,
                molar_volume=None,
                include_cycle_rows=False,
                out=str(tmp_path / "results.csv"),
                sep=",",
                raw=True,
            )
            params = {
                "K": None,
                "molar_volume": 24.465,
                "R": 1200.0,
                "primary_mz": 21.022,
                "kinetic": True,
                "k_anchor": 2.0,
                "concentration_available": False,
                "transmission_available": True,
                "humidity_corrected": False,
                "humidity_ref": None,
                "humidity_p": None,
                "molar_volume_source": "fixture",
            }
            output = io.StringIO()
            with mock.patch.object(
                analyze.ptrms,
                "extract_traces",
                return_value=({29.0386: (np.ones(4), 29.0386)}, (1.0, 0.0)),
            ), mock.patch.object(
                analyze.ptrms,
                "water_cluster_ratio",
                return_value=np.array([0.1, 0.1, 0.2, 0.2]),
            ), mock.patch.object(
                analyze.ptrms, "quantify", return_value=([], params)
            ), mock.patch.object(analyze, "_write_csv"), redirect_stdout(output):
                analyze.cmd_analyze(args)

        payload = json.loads(output.getvalue())
        self.assertEqual(payload["humidity"]["humid_compounds"], ["29.039"])
        self.assertEqual(
            payload["kinetic"]["resolved"]["29.039"]["source"], "explicit"
        )
        self.assertIn("humidity_warning", payload["kinetic"])


if __name__ == "__main__":
    unittest.main()
