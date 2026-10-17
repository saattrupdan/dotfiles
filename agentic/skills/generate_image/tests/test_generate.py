"""Tests for the standalone MOSS-Image generator CLI."""

from __future__ import annotations

import base64
import importlib.util
import io
import json
import struct
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/generate.py"
SPEC = importlib.util.spec_from_file_location("generate", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
GENERATE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(GENERATE)


class GenerateTests(unittest.TestCase):
    """Check prompt compilation, request construction and format validation."""

    def test_dimensions(self) -> None:
        """Accept valid sizes and reject unsupported dimensions."""
        self.assertEqual(GENERATE._dimensions(size="768x1024"), (768, 1024))
        for size in ("513x768", "2048x512", "1024x1009", "bad", "1024x1024x1"):
            with self.subTest(size=size), self.assertRaises(ValueError):
                GENERATE._dimensions(size=size)

    def test_compiles_caption(self) -> None:
        """Use the upstream compiler for the exact prompt text."""
        with TemporaryDirectory() as temp:
            draft = Path(temp) / "draft.json"
            draft.write_text(json.dumps({"caption": "A red teapot."}))
            self.assertEqual(GENERATE._compile(draft_path=draft), "A red teapot.")

    def test_request(self) -> None:
        """Route by model ID and verify the returned PNG dimensions."""
        image = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR" + struct.pack(">II", 512, 512)
        response = io.BytesIO(
            json.dumps(
                {"data": [{"b64_json": base64.b64encode(image).decode()}]}
            ).encode()
        )
        with patch.object(
            GENERATE.urllib.request, "urlopen", return_value=response
        ) as mock:
            actual = GENERATE._request(
                endpoint="http://127.0.0.1:31000",
                model=GENERATE.MODELS["sft"],
                prompt="A red teapot.",
                size="512x512",
                seed=17,
                width=512,
                height=512,
            )
        self.assertEqual(actual, image)
        payload = json.loads(mock.call_args.args[0].data)
        self.assertEqual(payload["model"], "OpenMOSS-Team/MOSS-Image-SFT")
        self.assertEqual(payload["extra_params"]["uncond_skip_layers"], [22])
        self.assertEqual(payload["seed"], 17)

    def test_wrong_dimensions(self) -> None:
        """Reject a PNG with dimensions different from the request."""
        image = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR" + struct.pack(">II", 768, 512)
        response = io.BytesIO(
            json.dumps(
                {"data": [{"b64_json": base64.b64encode(image).decode()}]}
            ).encode()
        )
        with patch.object(GENERATE.urllib.request, "urlopen", return_value=response):
            with self.assertRaisesRegex(ValueError, "unexpected dimensions"):
                GENERATE._request(
                    endpoint="http://127.0.0.1:31000",
                    model=GENERATE.MODELS["base"],
                    prompt="A red teapot.",
                    size="512x512",
                    seed=17,
                    width=512,
                    height=512,
                )


if __name__ == "__main__":
    unittest.main()
