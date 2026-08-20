"""Regression tests for effective resolutions in automatic peak selection."""

import json
import sys
import tempfile
import unittest
from argparse import Namespace
from pathlib import Path
from unittest import mock

import h5py
import numpy as np

sys.path.insert(0, str(Path(__file__).parents[1] / "scripts"))
import analyze  # noqa: E402


class AutoPeakSettingsTest(unittest.TestCase):
    def _args(self, *, config=None):
        return Namespace(
            peaks_json=None,
            config=config,
            auto_peaks=True,
            min_height=1e-3,
            max_peaks=300,
            mz_min=15.0,
            mz_max=None,
            R=None,
            R_phys=None,
        )

    def _spectrum(self):
        h5 = h5py.File("in-memory", "w", driver="core", backing_store=False)
        h5.create_group("SPECdata").create_dataset(
            "AverageSpec", data=np.ones(16, dtype=np.float64)
        )
        return h5

    def test_configured_r_phys_is_passed_to_detection(self):
        detected = [{"mz": 30.0, "height": 10.0}]
        with tempfile.TemporaryDirectory() as tmp:
            config_path = Path(tmp) / "config.json"
            config_path.write_text(
                json.dumps({"analyze": {"R": 1800.0, "R_phys": 3200.0}}),
                encoding="utf-8",
            )
            args = self._args(config=str(config_path))
            with self._spectrum() as h5, mock.patch.object(
                analyze.ptrms, "load_mass_cal", return_value=(1.0, 0.0)
            ), mock.patch.object(
                analyze, "assess_signal", return_value={"signal_present": True}
            ), mock.patch.object(
                analyze, "detect_peaks", return_value=detected
            ) as detect, mock.patch.object(
                analyze, "annotate_peaks", return_value=(1.0, [
                    {**detected[0], "suggested_label": "test"}
                ])
            ):
                result = analyze._load_peaks(args, h5)

        self.assertEqual(result, [{"mz": 30.0, "label": "test"}])
        self.assertEqual(detect.call_args.kwargs["R_phys"], 3200.0)

    def test_configured_r_changes_auto_merge_behaviour(self):
        args = self._args()
        detected = [
            {"mz": 100.0, "height": 10.0},
            {"mz": 100.05, "height": 8.0},
        ]
        annotated = [
            {**peak, "suggested_label": "test"} for peak in detected
        ]

        def run(r):
            settings = analyze.resolve_analysis_settings(
                {"analyze": {"R": r}}, args
            )
            with self._spectrum() as h5, mock.patch.object(
                analyze.ptrms, "load_mass_cal", return_value=(1.0, 0.0)
            ), mock.patch.object(
                analyze, "assess_signal", return_value={"signal_present": True}
            ), mock.patch.object(
                analyze, "detect_peaks", return_value=detected
            ), mock.patch.object(
                analyze, "annotate_peaks", return_value=(1.0, annotated)
            ):
                return analyze._load_peaks(args, h5, settings=settings)

        self.assertEqual(len(run(1200.0)), 2)
        self.assertEqual(len(run(600.0)), 1)


if __name__ == "__main__":
    unittest.main()
