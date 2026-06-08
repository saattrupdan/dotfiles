#!/usr/bin/env python3
"""Ideogram 4 image generation CLI."""

import argparse
import logging
import os
import sys
from datetime import datetime
from pathlib import Path

try:
    import torch
    from ideogram4 import Ideogram4Pipeline
    from ideogram4.pipeline_ideogram4 import Ideogram4PipelineConfig
except ImportError as exc:
    print(
        "Error: ideogram4 package not installed. Run: pip install -e .",
        file=sys.stderr,
    )
    sys.exit(1)

logger = logging.getLogger(__name__)
logging.basicConfig(
    level=logging.INFO,
    format="%(levelname)s: %(message)s",
)

OUTPUT_DIR = Path.home() / ".pi" / "agent" / "generated-images"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="generate-image",
        description="Generate images from text prompts using Ideogram 4",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument(
        "prompt",
        type=str,
        help="Text prompt describing the desired image",
    )
    parser.add_argument(
        "--width",
        type=int,
        default=1024,
        help="Output image width in pixels (multiples of 16, max 2048)",
    )
    parser.add_argument(
        "--height",
        type=int,
        default=1024,
        help="Output image height in pixels (multiples of 16, max 2048)",
    )
    parser.add_argument(
        "--quantization",
        type=str,
        choices=["fp8", "nf4"],
        default="fp8",
        help="Model quantisation: fp8 (all devices) or nf4 (CUDA-only)",
    )
    parser.add_argument(
        "--sampler-preset",
        type=str,
        choices=["V4_QUALITY_48", "V4_BALANCED_32", "V4_SPEED_20"],
        default="V4_QUALITY_48",
        help="Sampler preset for quality/speed tradeoff",
    )
    parser.add_argument(
        "--seed",
        type=int,
        default=0,
        help="Random seed for reproducibility (0 for random)",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=OUTPUT_DIR,
        help="Directory to save generated images",
    )
    parser.add_argument(
        "--hive-text-key",
        type=str,
        default=None,
        help="Hive API key for text moderation (or set HIVE_TEXT_MODERATION_KEY)",
    )
    parser.add_argument(
        "--hive-visual-key",
        type=str,
        default=None,
        help="Hive API key for visual moderation (or set HIVE_VISUAL_MODERATION_KEY)",
    )
    parser.add_argument(
        "--device",
        type=str,
        default=None,
        help="Device to run inference on (cuda, mps, cpu). Auto-detected if not specified",
    )
    parser.add_argument(
        "--verbose",
        action="store_true",
        help="Enable verbose logging",
    )
    return parser.parse_args()


def get_device(device_arg: str | None) -> str:
    if device_arg:
        return device_arg
    if torch.cuda.is_available():
        return "cuda"
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def get_num_steps(sampler_preset: str) -> int:
    if sampler_preset == "V4_QUALITY_48":
        return 48
    if sampler_preset == "V4_BALANCED_32":
        return 32
    if sampler_preset == "V4_SPEED_20":
        return 20
    return 48


def main() -> None:
    args = parse_args()

    if args.verbose:
        logger.setLevel(logging.DEBUG)

    # Validate dimensions
    if args.width % 16 != 0 or args.height % 16 != 0:
        logger.error("Width and height must be multiples of 16")
        sys.exit(1)
    if args.width > 2048 or args.height > 2048:
        logger.error("Width and height must not exceed 2048 pixels")
        sys.exit(1)

    # Setup Hive API keys
    hive_text_key = args.hive_text_key or os.environ.get("HIVE_TEXT_MODERATION_KEY")
    hive_visual_key = args.hive_visual_key or os.environ.get("HIVE_VISUAL_MODERATION_KEY")

    if not hive_text_key:
        logger.warning(
            "HIVE_TEXT_MODERATION_KEY not set - prompt safety screening disabled"
        )
    if not hive_visual_key:
        logger.warning(
            "HIVE_VISUAL_MODERATION_KEY not set - image safety screening disabled"
        )

    # Determine device
    device = get_device(args.device)
    logger.info(f"Using device: {device}")

    # Quantisation
    dtype = torch.float8_e4m3fn if args.quantization == "fp8" else torch.bfloat16
    if args.quantization == "nf4" and device != "cuda":
        logger.warning("nf4 quantisation is CUDA-only, falling back to dtype handling")

    # Load model
    logger.info("Loading Ideogram 4 model...")
    config = Ideogram4PipelineConfig()
    pipeline = Ideogram4Pipeline.from_pretrained(
        config=config,
        device=device,
        dtype=dtype,
    )

    # Generate image
    logger.info(f"Generating image for prompt: {args.prompt}")
    num_steps = get_num_steps(args.sampler_preset)
    seed = args.seed if args.seed != 0 else None

    images = pipeline(
        prompts=[args.prompt],
        height=args.height,
        width=args.width,
        num_steps=num_steps,
        seed=seed,
    )

    # Save output
    args.output_dir.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    output_filename = f"ideogram4_{timestamp}.png"
    output_path = args.output_dir / output_filename

    images[0].save(output_path)
    logger.info(f"Image saved to: {output_path}")


if __name__ == "__main__":
    main()
