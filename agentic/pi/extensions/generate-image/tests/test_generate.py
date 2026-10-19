"""Tests for the standalone MOSS-Image generator CLI."""

from __future__ import annotations

import base64
import importlib.util
import io
import json
import struct
import sys
import unittest
import zlib
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/generate.py"
SPEC = importlib.util.spec_from_file_location("generate", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
GENERATE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(GENERATE)


def _png(*, width: int, height: int) -> bytes:
    """Make a complete, synthetic black RGB PNG for request tests.

    Args:
        width:
            Canvas width.
        height:
            Canvas height.

    Returns:
        Complete PNG bytes.
    """

    def chunk(kind: bytes, data: bytes) -> bytes:
        """Encode a PNG chunk with its checksum.

        Args:
            kind:
                Chunk type.
            data:
                Chunk content.

        Returns:
            Encoded chunk bytes.
        """
        return (
            struct.pack(">I", len(data))
            + kind
            + data
            + struct.pack(">I", zlib.crc32(kind + data))
        )

    rows = (b"\0" + b"\0" * (3 * width)) * height
    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(rows))
        + chunk(b"IEND", b"")
    )


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

    def test_output_does_not_follow_symlink(self) -> None:
        """An existing predictable temporary symlink cannot redirect writes."""
        with TemporaryDirectory() as temp:
            directory = Path(temp)
            draft = directory / "draft.json"
            draft.write_text(json.dumps({"caption": "A red teapot."}))
            output = directory / "generated.png"
            prompt_output = directory / "prompt.txt"
            unrelated = directory / "unrelated.txt"
            unrelated.write_text("unchanged")
            output.with_suffix(".png.tmp").symlink_to(unrelated)
            arguments = [
                "generate.py",
                "--draft",
                str(draft),
                "--output",
                str(output),
                "--prompt-output",
                str(prompt_output),
                "--size",
                "512x512",
            ]
            with (
                patch.object(sys, "argv", arguments),
                patch.object(
                    GENERATE, "_request", return_value=_png(width=512, height=512)
                ),
            ):
                GENERATE.main()
            self.assertEqual(unrelated.read_text(), "unchanged")
            self.assertEqual(output.read_bytes()[:8], b"\x89PNG\r\n\x1a\n")
            self.assertEqual(prompt_output.read_text(encoding="utf-8"), "A red teapot.")

    def test_model_selection_is_not_available(self) -> None:
        """The CLI cannot request the retired Base checkpoint."""
        with patch.object(sys, "argv", ["generate.py", "--model", "base"]):
            with self.assertRaises(SystemExit) as result:
                GENERATE.main()
        self.assertEqual(result.exception.code, 2)

    def test_request(self) -> None:
        """Route by model ID and verify the returned PNG dimensions."""
        image = _png(width=512, height=512)
        response = io.BytesIO(
            json.dumps(
                {"data": [{"b64_json": base64.b64encode(image).decode()}]}
            ).encode()
        )
        with (
            patch.object(GENERATE.urllib.request, "urlopen", return_value=response) as mock,
            patch.object(GENERATE.secrets, "randbits", return_value=17) as random_seed,
        ):
            actual = GENERATE._request(
                endpoint="http://127.0.0.1:31000",
                model=GENERATE.MODEL_ID,
                prompt="A red teapot.",
                size="512x512",
                width=512,
                height=512,
            )
        self.assertEqual(actual, image)
        payload = json.loads(mock.call_args.args[0].data)
        self.assertEqual(payload["model"], "lodestones/Kromoss")
        self.assertNotIn("num_inference_steps", payload)
        self.assertNotIn("extra_params", payload)
        self.assertEqual(payload["seed"], 17)
        random_seed.assert_called_once_with(32)

    def test_each_request_uses_a_fresh_random_seed(self) -> None:
        """Avoid repeating the same server seed across identical image requests."""
        image = _png(width=512, height=512)
        response = json.dumps(
            {"data": [{"b64_json": base64.b64encode(image).decode()}]}
        ).encode()
        with (
            patch.object(
                GENERATE.urllib.request,
                "urlopen",
                side_effect=[io.BytesIO(response), io.BytesIO(response)],
            ) as url,
            patch.object(GENERATE.secrets, "randbits", side_effect=[17, 18]) as random_seed,
        ):
            for _ in range(2):
                GENERATE._request(
                    endpoint="http://127.0.0.1:31000",
                    model=GENERATE.MODEL_ID,
                    prompt="A red teapot.",
                    size="512x512",
                    width=512,
                    height=512,
                )
        self.assertEqual(
            [json.loads(call.args[0].data)["seed"] for call in url.call_args_list],
            [17, 18],
        )
        self.assertEqual(random_seed.call_count, 2)

    def test_truncated_png(self) -> None:
        """A complete-looking header without pixel data is not an image."""
        image = _png(width=512, height=512)
        with self.assertRaisesRegex(ValueError, "incomplete"):
            GENERATE._validate_png(image=image[:33], width=512, height=512)

    def test_wrong_dimensions(self) -> None:
        """Reject a PNG with dimensions different from the request."""
        image = _png(width=768, height=512)
        response = io.BytesIO(
            json.dumps(
                {"data": [{"b64_json": base64.b64encode(image).decode()}]}
            ).encode()
        )
        with patch.object(GENERATE.urllib.request, "urlopen", return_value=response):
            with self.assertRaisesRegex(ValueError, "unexpected dimensions"):
                GENERATE._request(
                    endpoint="http://127.0.0.1:31000",
                    model=GENERATE.MODEL_ID,
                    prompt="A red teapot.",
                    size="512x512",
                    width=512,
                    height=512,
                )


if __name__ == "__main__":
    unittest.main()
