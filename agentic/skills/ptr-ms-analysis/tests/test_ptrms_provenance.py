"""Focused tests for runtime calibration provenance."""

import sys
import unittest
from pathlib import Path

import h5py
import numpy as np

sys.path.insert(0, str(Path(__file__).parents[1] / "scripts"))
import analyze  # noqa: E402
import ptrms  # noqa: E402


class ProvenanceTest(unittest.TestCase):
    def test_molar_volume_reports_drift_temperature_source(self):
        with h5py.File("in-memory", "w", driver="core", backing_store=False) as h5:
            h5.create_dataset("AddTraces/PTR-Reaction/Data", data=np.array([[30.0], [30.0]]))
            h5.create_dataset(
                "AddTraces/PTR-Reaction/Info",
                data=np.array([[b"T-Drift_Act"]]),
            )
            value, source = ptrms.derive_molar_volume_info(h5)
        self.assertAlmostEqual(value, 22.414 * 303.15 / 273.15, places=6)
        self.assertEqual(source, "file drift temperature")

    def test_molar_volume_reports_25_c_fallback(self):
        with h5py.File("in-memory", "w", driver="core", backing_store=False) as h5:
            value, source = ptrms.derive_molar_volume_info(h5)
        self.assertEqual(value, 24.465)
        self.assertEqual(source, "25 °C fallback (drift metadata unavailable)")

    def test_humidity_proxy_uses_effective_primary_mz(self):
        label = analyze._humidity_proxy_label(19.022)
        self.assertIn("m/z 19.022", label)
        self.assertNotIn("m/z 21", label)


if __name__ == "__main__":
    unittest.main()
