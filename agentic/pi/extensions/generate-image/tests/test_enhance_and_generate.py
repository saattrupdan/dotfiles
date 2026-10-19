"""Tests for direct and locally enhanced sparkie generation."""

from __future__ import annotations

import importlib.util
import io
import json
import subprocess
import sys
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))
SPEC = importlib.util.spec_from_file_location(
    "enhance_and_generate", SCRIPTS / "enhance_and_generate.py"
)
assert SPEC is not None and SPEC.loader is not None
ENHANCE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ENHANCE)


class EnhanceAndGenerateTests(unittest.TestCase):
    """Check the local request, compiled generator handoff and failure paths."""

    def test_generation_pipeline(self) -> None:
        """Send the brief to the local model and pass its draft to the generator."""
        response = io.BytesIO(
            json.dumps(
                {
                    "choices": [
                        {
                            "finish_reason": "stop",
                            "message": {
                                "content": '{"caption":"A red ceramic teapot."}'
                            },
                        }
                    ]
                }
            ).encode()
        )
        drafts: list[dict[str, str]] = []

        def run(
            command: list[str], **kwargs: object
        ) -> subprocess.CompletedProcess[str]:
            """Capture the draft and simulate a saved image."""
            self.assertEqual(
                command[0:2], [sys.executable, str(SCRIPTS / "generate.py")]
            )
            draft_path = Path(command[command.index("--draft") + 1])
            drafts.append(json.loads(draft_path.read_text(encoding="utf-8")))
            self.assertEqual(command[command.index("--size") + 1], "768x1024")
            self.assertNotIn("--seed", command)
            Path(command[command.index("--output") + 1]).write_bytes(b"PNG")
            Path(command[command.index("--prompt-output") + 1]).write_text(
                "A red ceramic teapot.", encoding="utf-8"
            )
            return subprocess.CompletedProcess(command, 0, stdout="", stderr="")

        with (
            tempfile.TemporaryDirectory() as progress,
            patch.object(
                ENHANCE.urllib.request, "urlopen", return_value=response
            ) as url,
            patch.object(ENHANCE.subprocess, "run", side_effect=run),
        ):
            phase_file = Path(progress) / "phase"
            output, compiled_prompt = ENHANCE.generate_image(
                prompt="A red teapot", size="768x1024", phase_file=phase_file,
            )
            self.assertEqual(phase_file.read_text(encoding="utf-8"), "generating")
        try:
            request = url.call_args.args[0]
            self.assertEqual(
                request.full_url, "http://127.0.0.1:8080/v1/chat/completions"
            )
            body = json.loads(request.data)
            self.assertEqual(body["model"], "qwen3.6-35b-a3b-vision")
            self.assertIn("photorealistic", body["messages"][0]["content"])
            self.assertIn("soft-focus blur", body["messages"][0]["content"])
            self.assertIn("A red teapot", body["messages"][1]["content"])
            self.assertEqual(drafts, [{"caption": "A red ceramic teapot."}])
            self.assertEqual(output.read_bytes(), b"PNG")
            self.assertEqual(compiled_prompt, "A red ceramic teapot.")
            self.assertEqual(output.parent.parent, Path("/tmp"))
        finally:
            output.unlink()
            self.assertFalse(output.parent.joinpath("draft.json").exists())
            output.parent.rmdir()

    def test_direct_prompt_skips_local_model(self) -> None:
        """Send the supplied caption directly to the generator without enhancement."""
        prompt = "A red ceramic teapot beside a blue cup."
        drafts: list[dict[str, str]] = []

        def run(
            command: list[str], **kwargs: object
        ) -> subprocess.CompletedProcess[str]:
            """Capture the draft and simulate a saved image and compiled prompt."""
            draft_path = Path(command[command.index("--draft") + 1])
            drafts.append(json.loads(draft_path.read_text(encoding="utf-8")))
            Path(command[command.index("--output") + 1]).write_bytes(b"PNG")
            Path(command[command.index("--prompt-output") + 1]).write_text(
                prompt, encoding="utf-8"
            )
            return subprocess.CompletedProcess(command, 0, stdout="", stderr="")

        with (
            patch.object(ENHANCE, "_enhance") as enhance,
            patch.object(ENHANCE.subprocess, "run", side_effect=run),
        ):
            output, compiled_prompt = ENHANCE.generate_image(
                prompt=prompt, enhance=False
            )
        try:
            enhance.assert_not_called()
            self.assertEqual(drafts, [{"caption": prompt}])
            self.assertEqual(compiled_prompt, prompt)
            self.assertEqual(output.read_bytes(), b"PNG")
        finally:
            output.unlink()
            output.parent.rmdir()

    def test_layout_canvas_must_match(self) -> None:
        """Reject a layout at the wrong size before sending it to sparkie."""
        response = io.BytesIO(
            json.dumps(
                {
                    "choices": [
                        {
                            "finish_reason": "stop",
                            "message": {"content": '{"width":512,"height":512}'},
                        }
                    ]
                }
            ).encode()
        )
        with (
            patch.object(ENHANCE.urllib.request, "urlopen", return_value=response),
            patch.object(ENHANCE.subprocess, "run") as run,
            self.assertRaisesRegex(ValueError, "canvas"),
        ):
            ENHANCE.generate_image(prompt="A poster")
        run.assert_not_called()

    def test_local_failure_does_not_call_sparkie(self) -> None:
        """Do not bypass enhancement when the local server is unavailable."""
        with (
            patch.object(
                ENHANCE.urllib.request,
                "urlopen",
                side_effect=urllib.error.URLError("offline"),
            ),
            patch.object(ENHANCE.subprocess, "run") as run,
            self.assertRaisesRegex(ValueError, "local llama.cpp is unavailable"),
        ):
            ENHANCE.generate_image(prompt="A teapot")
        run.assert_not_called()

    def test_failed_generation_cleans_up(self) -> None:
        """Discard the draft and output directory if sparkie fails."""
        response = io.BytesIO(
            json.dumps(
                {
                    "choices": [
                        {
                            "finish_reason": "stop",
                            "message": {"content": '{"caption":"A teapot."}'},
                        }
                    ]
                }
            ).encode()
        )
        directories: list[Path] = []

        def run(
            command: list[str], **kwargs: object
        ) -> subprocess.CompletedProcess[str]:
            """Remember the temporary draft location before simulating failure."""
            directories.append(Path(command[command.index("--draft") + 1]).parent)
            return subprocess.CompletedProcess(command, 1, stderr="router unavailable")

        with (
            patch.object(ENHANCE.urllib.request, "urlopen", return_value=response),
            patch.object(ENHANCE.subprocess, "run", side_effect=run),
            self.assertRaisesRegex(ValueError, "router unavailable"),
        ):
            ENHANCE.generate_image(prompt="A teapot")
        self.assertFalse(directories[0].exists())

    def test_invalid_size_skips_both_servers(self) -> None:
        """Reject incompatible dimensions without making a network request."""
        with (
            patch.object(ENHANCE.urllib.request, "urlopen") as url,
            self.assertRaisesRegex(ValueError, "dimensions"),
        ):
            ENHANCE.generate_image(prompt="A teapot", size="1200x1024")
        url.assert_not_called()


if __name__ == "__main__":
    unittest.main()
