#!/usr/bin/env python3
"""Ideogram 4 image generation script.

Generates images from text prompts using the Ideogram 4 model.
Accepts structured JSON captions or plain text prompts.
Automatically detects GPU/CPU and handles model download on first run.
"""

import argparse
import logging
import sys
from datetime import datetime
from pathlib import Path

import torch
from ideogram4 import Ideogram4Pipeline, Ideogram4PipelineConfig

# Output directory for generated images
OUTPUT_DIR = Path.home() / ".pi" / "agent" / "generated-images"

# Default model quantization
DEFAULT_QUANTIZATION = "fp8"

# Logging setup
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)


def detect_device() -> str:
    """Detect and return the best available device for inference.

    Returns:
        Device string: "cuda" if GPU available, "mps" if Mac with Apple Silicon, else "cpu".
    """
    if torch.cuda.is_available():
        logger.info("GPU detected: %s", torch.cuda.get_device_name(0))
        return "cuda"
    if torch.backends.mps.is_available():
        logger.info("Apple Silicon MPS detected")
        return "mps"
    logger.info("No GPU detected, using CPU")
    return "cpu"


def generate_image(
    prompt: str,
    device: str,
    quantization: str = DEFAULT_QUANTIZATION,
    width: int = 1024,
    height: int = 1024,
    sampler_preset: str = "V4_QUALITY_48",
    seed: int = 0,
) -> Path:
    """Generate an image from a text prompt using Ideogram 4.

    Args:
        prompt:
            Text description or structured JSON caption for the image.
        device:
            Device string for inference ("cuda", "mps", or "cpu").
        quantization:
            Model quantization ("fp8" or "nf4"). Default: fp8.
        width:
            Output image width in pixels. Default: 1024.
        height:
            Output image height in pixels. Default: 1024.
        sampler_preset:
            Sampler preset for generation. Default: V4_QUALITY_48.
        seed:
            Random seed for reproducibility. Default: 0.

    Returns:
        Path to the saved image file.

    Raises:
        ImportError: If ideogram4 package is not installed.
        RuntimeError: If model loading or generation fails.
    """
    logger.info("Generating image for prompt: %s", prompt)
    logger.info(
        "Parameters: %dx%d, quantization=%s, sampler=%s, device=%s",
        width,
        height,
        quantization,
        sampler_preset,
        device,
    )

    # Configure pipeline
    config = Ideogram4PipelineConfig(quantization=quantization)

    logger.info("Loading Ideogram 4 model (this may take time on first run)...")
    pipeline = Ideogram4Pipeline.from_pretrained(
        config=config,
        device=device,
        dtype=torch.bfloat16,
    )

    # Run inference
    logger.info("Running inference...")
    images = pipeline(
        prompt,
        height=height,
        width=width,
        sampler_preset=sampler_preset,
        seed=seed,
    )

    # Ensure output directory exists
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    # Save with timestamped filename
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    filename = f"generated_{timestamp}.png"
    output_path = OUTPUT_DIR / filename

    images[0].save(output_path)
    logger.info("Image saved to: %s", output_path)

    return output_path


def main() -> int:
    """Main entry point for CLI.

    Returns:
        Exit code (0 for success, non-zero for errors).
    """
    parser = argparse.ArgumentParser(
        description="Generate images from text prompts using Ideogram 4",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument(
        "prompt",
        type=str,
        help="Text prompt or structured JSON caption describing the image to generate",
    )
    parser.add_argument(
        "--width",
        "-W",
        type=int,
        default=1024,
        help="Output image width in pixels",
    )
    parser.add_argument(
        "--height",
        "-H",
        type=int,
        default=1024,
        help="Output image height in pixels",
    )
    parser.add_argument(
        "--quantization",
        "-q",
        type=str,
        choices=["fp8", "nf4"],
        default=DEFAULT_QUANTIZATION,
        help="Model quantization (fp8 works on all devices, nf4 is CUDA-only)",
    )
    parser.add_argument(
        "--sampler-preset",
        "-s",
        type=str,
        default="V4_QUALITY_48",
        help="Sampler preset for generation quality/speed tradeoff",
    )
    parser.add_argument(
        "--seed",
        type=int,
        default=0,
        help="Random seed for reproducibility",
    )

    args = parser.parse_args()

    try:
        # Detect device
        device = detect_device()

        # Auto-select quantization if needed
        quantization = args.quantization
        if quantization == "nf4" and device != "cuda":
            logger.warning("nf4 quantization is CUDA-only, switching to fp8")
            quantization = "fp8"

        # Generate image
        output_path = generate_image(
            prompt=args.prompt,
            device=device,
            quantization=quantization,
            width=args.width,
            height=args.height,
            sampler_preset=args.sampler_preset,
            seed=args.seed,
        )

        logger.info("Generation complete: %s", output_path)
        return 0

    except KeyboardInterrupt:
        logger.info("Generation cancelled by user")
        return 130
    except ImportError as exc:
        logger.error("Import failed: %s", exc)
        return 127
    except Exception as exc:
        logger.error("Generation failed: %s", exc)
        return 1
