"""Load the pinned Kromoss pipeline for exactly one image, then exit."""

import argparse
import collections.abc as c
import json
import logging
import os
from pathlib import Path

import torch
from diffusers import DiffusionPipeline
from safetensors.torch import load_file

logger = logging.getLogger(__name__)


def main() -> None:
    """Generate the requested PNG in a process that owns all model allocations."""
    logging.basicConfig(level=logging.INFO)
    parser = argparse.ArgumentParser()
    parser.add_argument("--request", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    payload = json.loads(args.request.read_text())
    model = Path(os.environ["KROMOSS_MODEL"])
    pipe = _load_pipeline(model=model)
    width, height = (int(part) for part in payload["size"].split("x"))
    with torch.inference_mode():
        image = pipe(
            payload["prompt"],
            width=width,
            height=height,
            num_inference_steps=8,
            guidance_scale=1.0,
            generator=torch.Generator("cpu").manual_seed(payload["seed"]),
        ).images[0]
    image.save(args.output, format="PNG")
    logger.info("Kromoss image saved; releasing worker and model allocations")


def _load_pipeline(*, model: Path) -> DiffusionPipeline:
    """Load the pinned checkpoint and attach its unmerged LoRA hooks.

    Args:
        model:
            Offline snapshot containing the pipeline and eight-step LoRA.

    Returns:
        CUDA pipeline with the original 252 unmerged LoRA hooks.
    """
    state = load_file(str(model / "8-steps-dmd-lora.safetensors"), device="cpu")
    pipe = DiffusionPipeline.from_pretrained(
        str(model),
        custom_pipeline="pipeline_moss_image",
        trust_remote_code=True,
        torch_dtype={"default": torch.bfloat16, "vae": torch.float32},
        local_files_only=True,
    )
    pipe.scheduler = type(pipe.scheduler).from_config(pipe.scheduler.config)
    pipe.to("cuda")
    modules = dict(pipe.transformer.named_modules())
    loaded = 0
    for key in state:
        if not key.endswith(".lora_down.weight"):
            continue
        name = key.removeprefix("diffusion_model.").removesuffix(".lora_down.weight")
        up_key = key.replace(".lora_down.", ".lora_up.")
        alpha_key = f"diffusion_model.{name}.alpha"
        if name not in modules or up_key not in state or alpha_key not in state:
            raise RuntimeError(f"Incomplete LoRA target: {name}")
        down = state[key].to(device="cuda", dtype=torch.float32)
        up = state[up_key].to(device="cuda", dtype=torch.float32)
        scale = state[alpha_key].item() / down.shape[0]
        if (down.shape[1], up.shape[0]) != (
            modules[name].in_features,
            modules[name].out_features,
        ):
            raise RuntimeError(f"LoRA shape mismatch: {name}")
        modules[name].register_forward_hook(_make_hook(down=down, up=up, scale=scale))
        loaded += 1
    if loaded != sum(key.endswith(".lora_down.weight") for key in state) or loaded == 0:
        raise RuntimeError("LoRA targets missing")
    logger.info(f"Loaded {loaded} unmerged Kromoss LoRA hooks")
    return pipe


def _make_hook(
    *, down: torch.Tensor, up: torch.Tensor, scale: float
) -> c.Callable[
    [torch.nn.Module, tuple[torch.Tensor, ...], torch.Tensor], torch.Tensor
]:
    """Capture each LoRA projection independently of the loading loop.

    Args:
        down:
            Down projection on CUDA.
        up:
            Up projection on CUDA.
        scale:
            Checkpoint alpha divided by projection rank.

    Returns:
        Forward hook adding the original unmerged LoRA update.
    """

    def hook(
        _module: torch.nn.Module, args: tuple[torch.Tensor, ...], output: torch.Tensor
    ) -> torch.Tensor:
        """Apply the checkpoint's low-rank update without merging weights.

        Args:
            _module:
                Target linear layer.
            args:
                Input activation tuple.
            output:
                Unmodified layer output.

        Returns:
            Layer output including the low-rank update.
        """
        return output + (scale * (args[0].float() @ down.T) @ up.T).to(output.dtype)

    return hook


if __name__ == "__main__":
    main()
