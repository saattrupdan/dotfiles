"""Generate a PNG on sparkie, optionally enhancing the image brief locally."""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
from pathlib import Path

from generate import _dimensions

LOCAL_ENDPOINT = "http://127.0.0.1:8080"
LOCAL_MODEL = "qwen3.6-35b-a3b-vision"
SYSTEM_PROMPT = """Turn the user's brief into a concrete MOSS-Image prompt draft. Return only a JSON object.
Preserve subjects, counts, relationships, medium, style, exclusions and exact visible text
(including spelling, punctuation and line breaks). Do not invent facts or unrelated copy.
Resolve ordinary creative gaps with visible details: setting, framing, lighting, palette,
materials and composition. Keep minimalist requests minimalist. No generic quality tags.
Use descriptive prose in English unless requested otherwise; keep visible wording in its
original language. Do not include invisible instructions in image-description fields.

For an ordinary scene or illustration return exactly {"caption":"..."} with a cohesive,
specific description. For a poster, designed image, multiple panels, or precise text or
object placement, return a Layout draft: {"width":W,"height":H,
"bbox_coord_space":"abs","bbox_format":"xyxy","summary":{"caption":"..."},
"items":[{"label":"object|character|text","caption":"...","bbox":[x1,y1,x2,y2],
"text":"exact visible wording for text items only"}]}. Use the requested canvas dimensions.
Boxes are absolute pixels within the canvas, top-left origin, and text must fit legibly.
Keep the exact requested wording in text fields. Do not add any other fields, Markdown,
or explanations. Never normalise or centre the coordinates yourself."""


def main() -> None:
    """Generate an image with optional enhancement and write result JSON."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("prompt", help="Image brief or final visual prompt")
    parser.add_argument("--size", default="1024x1024", help="WIDTHxHEIGHT")
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--phase-file", type=Path, help="Progress marker for the caller")
    parser.add_argument("--skip-enhancement", action="store_true")
    args = parser.parse_args()
    try:
        output, compiled_prompt = generate_image(
            prompt=args.prompt, size=args.size, seed=args.seed,
            phase_file=args.phase_file, enhance=not args.skip_enhancement,
        )
    except (OSError, ValueError, KeyError, IndexError, TypeError) as exc:
        parser.exit(status=1, message=f"Image generation failed: {exc}\n")
    sys.stdout.write(
        json.dumps({"path": str(output), "compiled_prompt": compiled_prompt}) + "\n"
    )


def generate_image(
    *, prompt: str, size: str = "1024x1024", seed: int = 42,
    phase_file: Path | None = None, enhance: bool = True,
) -> tuple[Path, str]:
    """Save one PNG from sparkie under /tmp, optionally enhancing the brief.

    Args:
        prompt:
            The user's image brief.
        size (optional):
            Canvas dimensions. Defaults to 1024x1024.
        seed (optional):
            Sampling seed. Defaults to 42.
        phase_file (optional):
            File for reporting phase transitions to the caller.
        enhance (optional):
            Whether to use local llama.cpp to expand the brief. Defaults to True.

    Returns:
        Absolute path to the generated PNG and the compiled prompt sent to sparkie.

    Raises:
        ValueError:
            If the brief, draft or generation fails.
    """
    if not prompt.strip():
        raise ValueError("prompt must not be empty")
    width, height = _dimensions(size=size)
    if not 0 <= seed <= 2**32 - 1:
        raise ValueError("seed must be between 0 and 2**32-1")
    draft = (
        _enhance(prompt=prompt, width=width, height=height)
        if enhance
        else {"caption": prompt}
    )
    if phase_file is not None:
        phase_file.write_text("generating", encoding="utf-8")
    directory = Path(tempfile.mkdtemp(prefix="moss-image-", dir="/tmp"))
    try:
        draft_path = directory / "draft.json"
        draft_path.write_text(json.dumps(draft, ensure_ascii=False), encoding="utf-8")
        output = directory / "image.png"
        prompt_path = directory / "prompt.txt"
        script = Path(__file__).with_name("generate.py")
        result = subprocess.run(
            [
                sys.executable,
                str(script),
                "--draft",
                str(draft_path),
                "--size",
                size,
                "--seed",
                str(seed),
                "--output",
                str(output),
                "--prompt-output",
                str(prompt_path),
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode:
            raise ValueError(result.stderr.strip() or "sparkie generation failed")
        if not output.is_file():
            raise ValueError("generator did not save an image")
        compiled_prompt = prompt_path.read_text(encoding="utf-8")
        if not compiled_prompt.strip():
            raise ValueError("generator did not return a compiled prompt")
        draft_path.unlink()
        prompt_path.unlink()
        return output, compiled_prompt
    except BaseException:
        shutil.rmtree(directory)
        raise


def _enhance(*, prompt: str, width: int, height: int) -> dict[str, object]:
    """Request an official caption or Layout draft from the local vision model."""
    body = {
        "model": LOCAL_MODEL,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {
                "role": "user",
                "content": f"Canvas: {width}x{height} pixels. Brief:\n{prompt}",
            },
        ],
        "response_format": {"type": "json_object"},
        "temperature": 0.6,
        "max_tokens": 4096,
    }
    request = urllib.request.Request(
        url=f"{LOCAL_ENDPOINT}/v1/chat/completions",
        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=600) as response:
            payload = json.load(response)
    except urllib.error.HTTPError as exc:
        detail = exc.read(1000).decode("utf-8", errors="replace")
        raise ValueError(f"local llama.cpp returned HTTP {exc.code}: {detail}") from exc
    except urllib.error.URLError as exc:
        raise ValueError(f"local llama.cpp is unavailable: {exc.reason}") from exc
    choice = payload["choices"][0]
    if choice.get("finish_reason") == "length":
        raise ValueError("local prompt enhancement exceeded the token limit")
    content = choice["message"]["content"]
    if not isinstance(content, str) or not content.strip():
        raise ValueError("local model returned no prompt draft")
    try:
        draft = json.loads(content)
    except json.JSONDecodeError as exc:
        raise ValueError("local model returned invalid draft JSON") from exc
    if not isinstance(draft, dict):
        raise TypeError("local model returned a non-object draft")
    if "caption" in draft:
        if set(draft) != {"caption"} or not isinstance(draft["caption"], str):
            raise ValueError("local model returned an invalid caption draft")
    elif (draft.get("width"), draft.get("height")) != (width, height):
        raise ValueError("local Layout canvas does not match the requested size")
    return draft


if __name__ == "__main__":
    main()
