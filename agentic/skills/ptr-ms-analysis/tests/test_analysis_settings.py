"""Focused tests for analysis-setting authority."""

import sys
import unittest
from argparse import Namespace
from unittest import mock
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1] / "scripts"))
import analyze  # noqa: E402


_KEYS = {
    "R": None,
    "R_phys": None,
    "K": None,
    "molar_volume": None,
    "primary_mz": None,
    "kinetic": None,
    "k_anchor": None,
    "humidity_correct": None,
    "humidity_p": None,
    "humidity_ref": None,
    "no_per_interval": None,
}


class AnalysisSettingsTest(unittest.TestCase):
    def test_curated_values_survive_omitted_cli_options(self):
        settings = analyze.resolve_analysis_settings(
            {"analyze": {
                "R": 1500,
                "R_phys": 3200,
                "primary_mz": 19.022,
                "kinetic": True,
                "whole_run_windows": True,
            }},
            Namespace(**_KEYS),
        )
        self.assertEqual(settings["R"], 1500)
        self.assertEqual(settings["R_phys"], 3200)
        self.assertEqual(settings["primary_mz"], 19.022)
        self.assertTrue(settings["kinetic"])
        self.assertTrue(settings["whole_run_windows"])
        self.assertFalse(settings["per_interval_windows"])

    def test_legacy_defaults_remain_available_without_analyze_block(self):
        settings = analyze.resolve_analysis_settings({}, Namespace(**_KEYS))
        self.assertEqual(settings["R"], 1200.0)
        self.assertEqual(settings["R_phys"], 2400.0)
        self.assertEqual(settings["primary_mz"], 21.022)
        self.assertFalse(settings["kinetic"])
        self.assertTrue(settings["per_interval_windows"])

    def test_explicit_cli_values_override_curated_values(self):
        args = dict(_KEYS)
        args.update({"R": 1800, "kinetic": False, "no_per_interval": True})
        settings = analyze.resolve_analysis_settings(
            {"analyze": {"R": 1500, "kinetic": True, "whole_run_windows": False}},
            Namespace(**args),
        )
        self.assertEqual(settings["R"], 1800)
        self.assertFalse(settings["kinetic"])
        self.assertTrue(settings["whole_run_windows"])
        self.assertEqual(settings["sources"]["R"], "cli")
        self.assertEqual(settings["sources"]["kinetic"], "cli")

    def test_calibrate_uses_all_effective_extraction_settings(self):
        config = {"analyze": {"R": 1800, "R_phys": 3200, "primary_mz": 19.022}}
        args = Namespace(
            config=None,
            raw=True,
            h5="run.h5",
            reference="reference.csv",
            peaks_json=None,
            ranges_json=None,
            auto_peaks=False,
            auto_segments=False,
            min_height=1e-3,
            max_peaks=300,
            mz_min=15.0,
            mz_max=None,
            R=None,
            R_phys=None,
            primary_mz=None,
        )
        fake_file = mock.MagicMock()
        fake_file.__enter__.return_value = fake_file
        with mock.patch.object(analyze, "_load_config", return_value=config), \
                mock.patch.object(analyze, "_parse_viewer_csv", return_value={
                    (30.0, "sample"): {"con": 1.0}}), \
                mock.patch.object(analyze, "_load_peaks", return_value=[{"mz": 30.0}]), \
                mock.patch.object(analyze, "_resolve_ranges", return_value={
                    "sample": (1, 2)}), \
                mock.patch.object(analyze.h5py, "File", return_value=fake_file), \
                mock.patch.object(analyze.ptrms, "extract_traces", return_value=({30.0: ([], 30.0)}, None)) as extract, \
                mock.patch.object(analyze.ptrms, "calibrate_K", return_value=(1.0, 0.0, 1)) as calibrate, \
                mock.patch.object(analyze.ptrms, "extract_primary", return_value=[]), \
                mock.patch.object(analyze.ptrms, "derive_K", return_value=1.0), \
                mock.patch.object(analyze, "_emit"):
            analyze.cmd_calibrate(args)

        self.assertEqual(extract.call_args.kwargs["R"], 1800)
        self.assertEqual(extract.call_args.kwargs["R_phys"], 3200)
        self.assertEqual(calibrate.call_args.kwargs["primary_mz"], 19.022)
        self.assertEqual(calibrate.call_args.kwargs["R_used"], 1800)


if __name__ == "__main__":
    unittest.main()
