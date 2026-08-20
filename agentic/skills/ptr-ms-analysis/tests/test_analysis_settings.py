"""Focused tests for analysis-setting authority."""

import sys
import unittest
from argparse import Namespace
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


if __name__ == "__main__":
    unittest.main()
