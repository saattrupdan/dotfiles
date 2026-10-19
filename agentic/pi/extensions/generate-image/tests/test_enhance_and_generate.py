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
            outputs, compiled_prompt = ENHANCE.generate_image(
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
            self.assertEqual(body["chat_template_kwargs"], {"enable_thinking": False})
            self.assertEqual(body["reasoning_effort"], "none")
            self.assertEqual(body["max_tokens"], 8192)
            self.assertIn("photorealistic", body["messages"][0]["content"])
            self.assertIn("soft-focus blur", body["messages"][0]["content"])
            self.assertIn("A red teapot", body["messages"][1]["content"])
            self.assertEqual(drafts, [{"caption": "A red ceramic teapot."}])
            self.assertEqual(len(outputs), 1)
            self.assertEqual(outputs[0].read_bytes(), b"PNG")
            self.assertEqual(compiled_prompt, "A red ceramic teapot.")
            self.assertEqual(outputs[0].parent.parent, Path("/tmp"))
        finally:
            outputs[0].unlink()
            self.assertFalse(outputs[0].parent.joinpath("draft.json").exists())
            outputs[0].parent.rmdir()

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
            self.assertEqual(command[command.index("--size") + 1], "512x512")
            Path(command[command.index("--output") + 1]).write_bytes(b"PNG")
            Path(command[command.index("--prompt-output") + 1]).write_text(
                prompt, encoding="utf-8"
            )
            return subprocess.CompletedProcess(command, 0, stdout="", stderr="")

        with (
            patch.object(ENHANCE, "_enhance") as enhance,
            patch.object(ENHANCE.subprocess, "run", side_effect=run),
        ):
            outputs, compiled_prompt = ENHANCE.generate_image(
                prompt=prompt, enhance=False
            )
        try:
            enhance.assert_not_called()
            self.assertEqual(drafts, [{"caption": prompt}])
            self.assertEqual(compiled_prompt, prompt)
            self.assertEqual(len(outputs), 1)
            self.assertEqual(outputs[0].read_bytes(), b"PNG")
        finally:
            outputs[0].unlink()
            outputs[0].parent.rmdir()

    def test_cli_returns_every_image_path(self) -> None:
        """Include the complete batch in the JSON consumed by Pi."""
        outputs = [Path("/tmp/image-01.png"), Path("/tmp/image-02.png")]
        with (
            patch.object(sys, "argv", ["generate-image", "A teapot", "--num", "2"]),
            patch.object(sys, "stdout", new_callable=io.StringIO) as stdout,
            patch.object(
                ENHANCE, "generate_image", return_value=(outputs, "A red teapot")
            ) as generate,
        ):
            ENHANCE.main()
        generate.assert_called_once_with(
            prompt="A teapot", size="512x512", num=2,
            phase_file=None, enhance=True,
        )
        self.assertEqual(
            json.loads(stdout.getvalue()),
            {"paths": [str(output) for output in outputs], "compiled_prompt": "A red teapot"},
        )

    def test_multiple_images_share_a_directory_and_one_enhancement(self) -> None:
        """Generate distinct image paths from one draft and one enhancement."""
        prompt = "A red teapot."
        seen_drafts: list[dict[str, str]] = []

        def run(
            command: list[str], **kwargs: object
        ) -> subprocess.CompletedProcess[str]:
            """Save each image and the compiled prompt as the generator would."""
            draft_path = Path(command[command.index("--draft") + 1])
            seen_drafts.append(json.loads(draft_path.read_text(encoding="utf-8")))
            Path(command[command.index("--output") + 1]).write_bytes(b"PNG")
            Path(command[command.index("--prompt-output") + 1]).write_text(
                prompt, encoding="utf-8"
            )
            return subprocess.CompletedProcess(command, 0, stdout="", stderr="")

        with (
            patch.object(ENHANCE, "_enhance", return_value={"caption": prompt}) as enhance,
            patch.object(ENHANCE.subprocess, "run", side_effect=run) as generate,
        ):
            outputs, compiled_prompt = ENHANCE.generate_image(prompt=prompt, num=3)
        try:
            enhance.assert_called_once_with(prompt=prompt, width=512, height=512)
            self.assertEqual(generate.call_count, 3)
            self.assertEqual(seen_drafts, [{"caption": prompt}] * 3)
            self.assertEqual(
                [output.name for output in outputs],
                ["image-01.png", "image-02.png", "image-03.png"],
            )
            self.assertEqual(len({output.parent for output in outputs}), 1)
            self.assertTrue(all(output.read_bytes() == b"PNG" for output in outputs))
            self.assertEqual(compiled_prompt, prompt)
            self.assertFalse(outputs[0].parent.joinpath("draft.json").exists())
            self.assertFalse(outputs[0].parent.joinpath("prompt.txt").exists())
        finally:
            for output in outputs:
                output.unlink()
            outputs[0].parent.rmdir()

    def test_later_failure_removes_the_entire_batch(self) -> None:
        """Do not leave incomplete image batches after a failed request."""
        directories: list[Path] = []

        def run(
            command: list[str], **kwargs: object
        ) -> subprocess.CompletedProcess[str]:
            """Write the first image, then fail the second request."""
            output = Path(command[command.index("--output") + 1])
            directories.append(output.parent)
            if len(directories) == 2:
                return subprocess.CompletedProcess(command, 1, stderr="router unavailable")
            output.write_bytes(b"PNG")
            return subprocess.CompletedProcess(command, 0, stdout="", stderr="")

        with (
            patch.object(ENHANCE.subprocess, "run", side_effect=run),
            self.assertRaisesRegex(ValueError, "router unavailable"),
        ):
            ENHANCE.generate_image(prompt="A teapot", num=3, enhance=False)
        self.assertEqual(len(directories), 2)
        self.assertFalse(directories[0].exists())

    def test_invalid_count_skips_both_servers(self) -> None:
        """Reject counts outside 1-10 before enhancement or generation."""
        for num in (0, 11):
            with (
                self.subTest(num=num),
                patch.object(ENHANCE, "_enhance") as enhance,
                patch.object(ENHANCE.subprocess, "run") as generate,
                self.assertRaisesRegex(ValueError, "num must be between 1 and 10"),
            ):
                ENHANCE.generate_image(prompt="A teapot", num=num)
            enhance.assert_not_called()
            generate.assert_not_called()

    def test_invalid_layout_label_is_retried_before_generation(self) -> None:
        """Ask the local model to correct a literal union label before GPU work."""
        def response(label: str) -> io.BytesIO:
            """Return a local-model Layout response with the given item label."""
            draft = {
                "width": 512, "height": 512, "bbox_coord_space": "abs",
                "bbox_format": "xyxy", "summary": {"caption": "A poster"},
                "items": [{
                    "label": label, "caption": "A title", "bbox": [20, 20, 400, 100],
                    "text": "Hello",
                }],
            }
            return io.BytesIO(json.dumps({"choices": [{
                "finish_reason": "stop",
                "message": {"content": json.dumps(draft)},
            }]}).encode())

        with (
            patch.object(
                ENHANCE.urllib.request, "urlopen",
                side_effect=[response("object|character|text"), response("text")],
            ) as url,
            patch.object(ENHANCE.subprocess, "run") as generate,
        ):
            draft = ENHANCE._enhance(prompt="A poster", width=512, height=512)
        self.assertEqual(draft["items"][0]["label"], "text")
        self.assertEqual(url.call_count, 2)
        first = json.loads(url.call_args_list[0].args[0].data)
        self.assertIn('"label":"text"', first["messages"][0]["content"])
        self.assertIn("exactly one of", first["messages"][0]["content"])
        second = json.loads(url.call_args_list[1].args[0].data)
        self.assertIn("invalid items[0].label", second["messages"][1]["content"])
        generate.assert_not_called()

    def test_repeated_invalid_layout_label_fails_after_one_retry(self) -> None:
        """Stop before sparkie if the corrected draft is still invalid."""
        draft = {
            "width": 512, "height": 512, "bbox_coord_space": "abs",
            "bbox_format": "xyxy", "summary": {"caption": "A poster"},
            "items": [{
                "label": "object|character|text", "caption": "A title",
                "bbox": [20, 20, 400, 100], "text": "Hello",
            }],
        }
        response = json.dumps({"choices": [{
            "finish_reason": "stop", "message": {"content": json.dumps(draft)},
        }]}).encode()
        with (
            patch.object(
                ENHANCE.urllib.request, "urlopen",
                side_effect=lambda *_args, **_kwargs: io.BytesIO(response),
            ) as url,
            patch.object(ENHANCE.subprocess, "run") as generate,
            self.assertRaisesRegex(ValueError, r"invalid items\[0\]\.label"),
        ):
            ENHANCE.generate_image(prompt="A poster")
        self.assertEqual(url.call_count, 2)
        generate.assert_not_called()

    def test_layout_canvas_must_match(self) -> None:
        """Reject a layout at the wrong size before sending it to sparkie."""
        response = io.BytesIO(
            json.dumps(
                {
                    "choices": [
                        {
                            "finish_reason": "stop",
                            "message": {"content": '{"width":768,"height":512}'},
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
