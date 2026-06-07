#!/usr/bin/env python3
"""Stable Diffusion image generation script using diffusers.

Generates images from text prompts with configurable parameters.
Automatically detects GPU/CPU and handles model download on first run.
"""

import argparse
import logging
import platform
import sys
from datetime import datetime
from pathlib import Path

import torch
from diffusers import StableDiffusionPipeline

# Output directory for generated images
OUTPUT_DIR = Path.home() / ".pi" / "agent" / "generated-images"

# Default model
DEFAULT_MODEL = "runwayml/stable-diffusion-v1-5"

# Logging setup
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)


def detect_device() -> torch.device:
    """Detect and return the best available device for inference.

    Returns:
        torch.device: CUDA if GPU available, MPS if Mac with Apple Silicon, else CPU.
    """
    if torch.cuda.is_available():
        logger.info("GPU detected: %s", torch.cuda.get_device_name(0))
        return torch.device("cuda")
    if platform.system() == "Darwin" and torch.backends.mps.is_available():
        logger.info("Apple Silicon MPS detected")
        return torch.device("mps")
    logger.info("No GPU detected, using CPU")
    return torch.device("cpu")


def load_model(model_name: str, device: torch.device) -> StableDiffusionPipeline:
    """Load Stable Diffusion model, downloading if necessary.

    Args:
        model_name:
            HuggingFace model identifier.
        device:
            Target device for inference.

    Returns:
        Loaded StableDiffusionPipeline ready for generation.
    """
    logger.info("Loading model: %s", model_name)

    # Load model with automatic download on first run
    pipeline = StableDiffusionPipeline.from_pretrained(
        model_name,
        torch_dtype=torch.float16 if device.type != "cpu" else torch.float32,
        use_safetensors=True,
    )

    # Move to device
    pipeline = pipeline.to(device)

    # Enable memory optimizations for GPU
    if device.type == "cuda":
        try:
            pipeline.enable_attention_slicing()
            logger.info("Enabled attention slicing for memory efficiency")
        except Exception as exc:  # noqa: BLE001
            logger.debug("Could not enable attention slicing: %s", exc)

    logger.info("Model loaded successfully")
    return pipeline


def generate_image(
    pipeline: StableDiffusionPipeline,
    prompt: str,
    device: torch.device,
    width: int = 512,
    height: int = 512,
    num_inference_steps: int = 50,
) -> Path:
    """Generate an image from a text prompt.

    Args:
        pipeline:
            Loaded StableDiffusionPipeline.
        prompt:
            Text description of the image to generate.
        device:
            Device used for inference.
        width:
            Output image width in pixels.
        height:
            Output image height in pixels.
        num_inference_steps:
            Number of denoising steps (higher = better quality, slower).

    Returns:
        Path to the saved image file.
    """
    logger.info("Generating image for prompt: %s", prompt)
    logger.info("Parameters: %dx%d, %d steps", width, height, num_inference_steps)

    # Generate image
    image = pipeline(
        prompt=prompt,
        width=width,
        height=height,
        num_inference_steps=num_inference_steps,
    ).images[0]

    # Ensure output directory exists
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    # Save with timestamped filename
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    filename = f"generated_{timestamp}.png"
    output_path = OUTPUT_DIR / filename

    image.save(output_path)
    logger.info("Image saved to: %s", output_path)

    return output_path


def main() -> int:
    """Main entry point for CLI.

    Returns:
        Exit code (0 for success, non-zero for errors).
    """
    parser = argparse.ArgumentParser(
        description="Generate images from text prompts using Stable Diffusion",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument(
        "prompt",
        type=str,
        help="Text prompt describing the image to generate",
    )
    parser.add_argument(
        "--width",
        "-W",
        type=int,
        default=512,
        help="Output image width in pixels",
    )
    parser.add_argument(
        "--height",
        "-H",
        type=int,
        default=512,
        help="Output image height in pixels",
    )
    parser.add_argument(
        "--steps",
        "-s",
        type=int,
        default=50,
        dest="num_inference_steps",
        help="Number of inference steps (quality vs speed)",
    )
    parser.add_argument(
        "--model",
        "-m",
        type=str,
        default=DEFAULT_MODEL,
        help="HuggingFace model identifier",
    )

    args = parser.parse_args()

    try:
        # Detect device
        device = detect_device()

        # Load model (downloads on first run)
        pipeline = load_model(args.model, device)

        # Generate image
        output_path = generate_image(
            pipeline=pipeline,
            prompt=args.prompt,
            device=device,
            width=args.width,
            height=args.height,
            num_inference_steps=args.num_inference_steps,
        )

        logger.info("Generation complete: %s", output_path)
        return 0

    except KeyboardInterrupt:
        logger.info("Generation cancelled by user")
        return 130
    except Exception as exc:
        logger.error("Generation failed: %s", exc)
        return 1


if __name__ == "__main__":
    sys.exit(main())
