#!/usr/bin/env python3
"""Compile a MOSS prompt draft and generate with Kromoss on sparkie."""

from __future__ import annotations

import argparse
import base64
import binascii
import json
import os
import struct
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
import zlib
from pathlib import Path

DEFAULT_ENDPOINT = "http://100.102.237.34:31000"
MODEL_ID = "lodestones/Kromoss"


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
    parser.add_argument(
        "--endpoint", default=os.environ.get("KROMOSS_IMAGE_URL", DEFAULT_ENDPOINT)
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
            model=MODEL_ID,
            prompt=prompt,
            size=args.size,
            seed=args.seed,
            width=width,
            height=height,
        )
        args.output.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(
            mode="wb",
            prefix=f".{args.output.name}-",
            suffix=".tmp",
            dir=args.output.parent,
            delete=False,
        ) as handle:
            temporary = Path(handle.name)
            try:
                handle.write(image)
                handle.flush()
                temporary.replace(args.output)
            finally:
                temporary.unlink(missing_ok=True)
        sys.stdout.write(f"{args.output.resolve().as_uri()}\n")
    except (
        OSError,
        ValueError,
        KeyError,
        IndexError,
        TypeError,
        binascii.Error,
        urllib.error.URLError,
    ) as exc:
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
        "seed": seed,
        "response_format": "b64_json",
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
    _validate_png(image=image, width=width, height=height)
    return image


def _validate_png(*, image: bytes, width: int, height: int) -> None:
    """Check PNG chunks, checksums and bounded pixel decompression.

    Args:
        image:
            Encoded PNG data from the model.
        width:
            Expected width in pixels.
        height:
            Expected height in pixels.

    Raises:
        ValueError:
            If the image is incomplete, corrupt or has unexpected dimensions.
    """
    chunks = _png_chunks(image=image)
    if not chunks or chunks[0][0] != b"IHDR" or len(chunks[0][1]) != 13:
        raise ValueError("PNG is missing its IHDR chunk")
    actual_width, actual_height, depth, colour, compression, filtering, interlace = (
        struct.unpack(">IIBBBBB", chunks[0][1])
    )
    if (actual_width, actual_height) != (width, height):
        raise ValueError("router returned an image with unexpected dimensions")
    if (depth, colour, compression, filtering, interlace) != (8, 2, 0, 0, 0):
        raise ValueError("unsupported PNG format from router")
    if chunks[-1] != (b"IEND", b""):
        raise ValueError("PNG is incomplete")
    data = b"".join(content for kind, content in chunks if kind == b"IDAT")
    if not data:
        raise ValueError("PNG has no pixel data")
    _validate_pixels(data=data, width=width, height=height)


def _png_chunks(*, image: bytes) -> list[tuple[bytes, bytes]]:
    """Read PNG chunks, rejecting incomplete data or incorrect checksums.

    Args:
        image:
            Encoded PNG bytes.

    Returns:
        Chunk types and data in file order.

    Raises:
        ValueError:
            If any chunk or the file signature is invalid.
    """
    if not image.startswith(b"\x89PNG\r\n\x1a\n"):
        raise ValueError("router response is not a PNG")
    chunks: list[tuple[bytes, bytes]] = []
    offset = 8
    while offset + 12 <= len(image):
        length = struct.unpack_from(">I", image, offset)[0]
        if length > 20_000_000 or offset + 12 + length > len(image):
            raise ValueError("PNG chunk is truncated or too large")
        kind = image[offset + 4 : offset + 8]
        content = image[offset + 8 : offset + 8 + length]
        checksum = struct.unpack_from(">I", image, offset + 8 + length)[0]
        if zlib.crc32(kind + content) != checksum:
            raise ValueError("PNG chunk checksum mismatch")
        chunks.append((kind, content))
        offset += 12 + length
        if kind == b"IEND":
            break
    if offset != len(image):
        raise ValueError("PNG has trailing or incomplete data")
    return chunks


def _validate_pixels(*, data: bytes, width: int, height: int) -> None:
    """Verify complete, bounded PNG decompression and row filters.

    Args:
        data:
            Concatenated IDAT chunks.
        width:
            Expected width in pixels.
        height:
            Expected height in pixels.

    Raises:
        ValueError:
            If the pixel stream is malformed.
    """
    expected = height * (1 + 3 * width)
    try:
        decoder = zlib.decompressobj()
        pixels = decoder.decompress(data, expected + 1)
        if (
            len(pixels) != expected
            or not decoder.eof
            or decoder.unused_data
            or decoder.unconsumed_tail
        ):
            raise ValueError("PNG pixel data is incomplete or oversized")
    except zlib.error as exc:
        raise ValueError("PNG pixel data is corrupt") from exc
    if any(pixels[row * (1 + 3 * width)] > 4 for row in range(height)):
        raise ValueError("PNG row filter is invalid")


if __name__ == "__main__":
    main()
