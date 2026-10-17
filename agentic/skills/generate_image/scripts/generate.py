#!/usr/bin/env python3
"""Compile a MOSS prompt draft and save one image from sparkie's router."""

from __future__ import annotations

import argparse
import base64
import json
import os
import struct
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
from pathlib import Path

DEFAULT_ENDPOINT = "http://100.102.237.34:31000"
MODELS = {
    "base": "OpenMOSS-Team/MOSS-Image-Base",
    "sft": "OpenMOSS-Team/MOSS-Image-SFT",
}


def main() -> None:
    """Compile a prompt draft, generate an image and write its file URL.

    Raises:
        ValueError:
            If the draft or generation settings are invalid.
    """
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--draft",
        required=True,
        type=Path,
        help="Official caption or Layout draft JSON",
    )
    parser.add_argument("--output", required=True, type=Path, help="Output PNG")
    parser.add_argument(
        "--size", default="1024x1024", help="WIDTHxHEIGHT, e.g. 768x1024"
    )
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--model", choices=MODELS, default="sft")
    parser.add_argument(
        "--endpoint", default=os.environ.get("MOSS_IMAGE_URL", DEFAULT_ENDPOINT)
    )
    args = parser.parse_args()
    try:
        width, height = _dimensions(size=args.size)
        if not 0 <= args.seed <= 2**32 - 1:
            raise ValueError("seed must be between 0 and 2**32-1")
        draft = json.loads(args.draft.read_text(encoding="utf-8"))
        if not isinstance(draft, dict):
            raise ValueError("draft must be a JSON object")
        if "caption" not in draft and (draft.get("width"), draft.get("height")) != (
            width,
            height,
        ):
            raise ValueError("Layout canvas and --size must match")
        prompt = _compile(draft_path=args.draft)
        image = _request(
            endpoint=args.endpoint,
            model=MODELS[args.model],
            prompt=prompt,
            size=args.size,
            seed=args.seed,
            width=width,
            height=height,
        )
        args.output.parent.mkdir(parents=True, exist_ok=True)
        temporary = args.output.with_suffix(args.output.suffix + ".tmp")
        temporary.write_bytes(image)
        temporary.replace(args.output)
        sys.stdout.write(f"{args.output.resolve().as_uri()}\n")
    except (OSError, ValueError, KeyError, subprocess.CalledProcessError) as exc:
        parser.exit(status=1, message=f"Image generation failed: {exc}\n")


def _dimensions(*, size: str) -> tuple[int, int]:
    """Validate sparkie's supported image dimensions.

    Args:
        size:
            Requested width and height.

    Returns:
        The width and height in pixels.

    Raises:
        ValueError:
            If the dimensions are unsupported.
    """
    parts = size.split("x")
    if len(parts) != 2 or not all(part.isdecimal() for part in parts):
        raise ValueError("size must be WIDTHxHEIGHT")
    width, height = (int(part) for part in parts)
    if not (
        512 <= width <= 1024
        and 512 <= height <= 1024
        and width % 16 == 0
        and height % 16 == 0
        and width * height <= 1024 * 1024
    ):
        raise ValueError(
            "dimensions must be multiples of 16, 512-1024, at most 1 megapixel"
        )
    return width, height


def _compile(*, draft_path: Path) -> str:
    """Run the vendored upstream compiler without reimplementing its schema.

    Args:
        draft_path:
            The JSON prompt draft.

    Returns:
        The compiled positive prompt.

    Raises:
        ValueError:
            If the draft is invalid.
    """
    compiler = (
        Path(__file__).resolve().parents[1]
        / "prompt-enhancer/scripts/compile_prompt.py"
    )
    with tempfile.TemporaryDirectory(prefix="moss-prompt-") as directory:
        output = Path(directory) / "prompt.txt"
        result = subprocess.run(
            [sys.executable, str(compiler), str(draft_path), "--output", str(output)],
            check=False,
            capture_output=True,
            text=True,
        )
        if result.returncode:
            raise ValueError(result.stderr.strip() or "prompt compilation failed")
        return output.read_text(encoding="utf-8").removesuffix("\n")


def _request(
    *,
    endpoint: str,
    model: str,
    prompt: str,
    size: str,
    seed: int,
    width: int,
    height: int,
) -> bytes:
    """Request one image and verify the PNG signature and dimensions.

    Args:
        endpoint:
            Base URL of the sparkie router.
        model:
            Model identifier selected by the router.
        prompt:
            Compiled MOSS prompt.
        size:
            Requested dimensions as WIDTHxHEIGHT.
        seed:
            Reproducible sampling seed.
        width:
            Expected PNG width.
        height:
            Expected PNG height.

    Returns:
        Verified PNG bytes.

    Raises:
        ValueError:
            If the request fails or the response is not the requested PNG.
    """
    body = {
        "model": model,
        "prompt": prompt,
        "size": size,
        "n": 1,
        "num_inference_steps": 50,
        "guidance_scale": 3.0,
        "flow_shift": 5.0,
        "seed": seed,
        "negative_prompt": "",
        "response_format": "b64_json",
        "extra_params": {
            "uncond_skip_layers": [22],
            "slg_start": 0.01,
            "slg_stop": 1.0,
        },
    }
    request = urllib.request.Request(
        url=f"{endpoint.rstrip('/')}/v1/images/generations",
        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=900) as response:
            payload = json.load(response)
    except urllib.error.HTTPError as exc:
        detail = exc.read(1000).decode("utf-8", errors="replace")
        raise ValueError(f"router returned HTTP {exc.code}: {detail}") from exc
    image = base64.b64decode(payload["data"][0]["b64_json"], validate=True)
    if len(image) < 24 or image[:16] != b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR":
        raise ValueError("router response is not a PNG")
    if struct.unpack(">II", image[16:24]) != (width, height):
        raise ValueError("router returned an image with unexpected dimensions")
    return image


if __name__ == "__main__":
    main()
