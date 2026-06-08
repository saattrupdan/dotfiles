---
name: image-generate
description: Generate images from text prompts using Ideogram 4 via CLI.
---

# Image Generation Skill

Generate images from text prompts using **Ideogram 4** (fp8 quantised).

## When to use

Use this skill when the user wants to:
- Generate an image from a text description
- Create visual assets, illustrations, or concept art
- Visualise ideas, characters, scenes, or designs
- Experiment with AI image generation

## Installation

Install the CLI package (editable mode):

```bash
cd ~/.pi/agent/skills/image-generate
pip install -e .
```

This makes the `generate-image` command available globally.

### Model access

Model weights are **gated** on Hugging Face. Before generating:

1. Visit [ideogram-ai/ideogram-4-fp8](https://huggingface.co/ideogram-ai/ideogram-4-fp8) or [ideogram-ai/ideogram-4-nf4](https://huggingface.co/ideogram-ai/ideogram-4-nf4)
2. Click **Agree and access repository** to accept the licence
3. Log in with HF: `hf auth login`

## CLI usage

```bash
generate-image "detailed description of the desired image" [options]
```

### Arguments

| Argument | Description | Default |
|----------|-------------|---------|
| `prompt` | Text prompt describing the desired image (required) | — |
| `--width` | Output image width in pixels (multiples of 16, max 2048) | `1024` |
| `--height` | Output image height in pixels (multiples of 16, max 2048) | `1024` |
| `--quantization` | Model quantisation: `fp8` (all devices) or `nf4` (CUDA-only) | `fp8` |
| `--sampler-preset` | Sampler preset: `V4_QUALITY_48`, `V4_BALANCED_32`, `V4_SPEED_20` | `V4_QUALITY_48` |
| `--seed` | Random seed for reproducibility (0 for random) | `0` |
| `--output-dir` | Directory to save generated images | `~/.pi/agent/generated-images/` |
| `--device` | Device: `cuda`, `mps`, `cpu` (auto-detected if omitted) | auto |
| `--hive-text-key` | Hive API key for text moderation | env `HIVE_TEXT_MODERATION_KEY` |
| `--hive-visual-key` | Hive API key for visual moderation | env `HIVE_VISUAL_MODERATION_KEY` |
| `--verbose` | Enable verbose logging | off |

### Examples

```bash
# Basic usage
generate-image "A serene mountain landscape at sunset, photorealistic"

# Custom resolution and quality
generate-image "Cyberpunk city street at night, neon signs" \
  --width 1536 --height 1024 \
  --sampler-preset V4_BALANCED_32

# With specific seed for reproducibility
generate-image "Portrait of a cat in Victorian suit, oil painting" \
  --seed 42

# Fast generation for testing
generate-image "Minimalist logo design, geometric shapes" \
  --sampler-preset V4_SPEED_20

# Custom output directory
generate-image "Fantasy castle on a cliff" \
  --output-dir ./my-images
```

### Prompt writing tips

- Be specific and descriptive
- Include style references (e.g. "photorealistic", "digital art", "oil painting")
- Mention lighting, composition, mood
- Avoid negative descriptions (state what you want, not what you don't want)

### Example prompts

- "A serene mountain landscape at sunset, photorealistic, golden hour lighting"
- "Cyberpunk city street at night, neon signs, rain reflections, cinematic"
- "Portrait of a cat wearing a Victorian suit, oil painting style, dignified expression"
- "Minimalist logo design for a tech startup, geometric shapes, blue and white"

## Technical details

- Uses `ideogram4` Python package with Ideogram 4 model
- Auto-detects GPU acceleration (CUDA/MPS) or falls back to CPU
- First run downloads model from HuggingFace (requires `hf auth login` + licence acceptance)
- Images saved to `~/.pi/agent/generated-images/` with timestamps
- Default resolution: 1024×1024 (max 2048×2048, multiples of 16)

## Sampler presets

| Preset | Steps | Use case |
|--------|-------|----------|
| `V4_QUALITY_48` | 48 | Highest quality, production use |
| `V4_BALANCED_32` | 32 | Balanced quality/speed |
| `V4_SPEED_20` | 20 | Fastest generation, drafts |

## Gotchas

- **Authentication required**: Must have `HF_TOKEN` set and accept Ideogram 4 licence on HuggingFace
- First generation takes time (model download ~20-30 min on slower connections)
- `nf4` quantisation is CUDA-only; use `fp8` for MPS/CPU
- Larger dimensions = more VRAM; stick to 1024×1024 unless you need higher res
- MPS (Apple Silicon) supported but slower than CUDA
- CPU fallback works but significantly slower
- Width and height must be multiples of 16

## Safety screening

Prompt and output safety screening is performed via [Hive](https://thehive.ai/).

Set the following environment variables to enable screening:

```bash
export HIVE_TEXT_MODERATION_KEY="your-text-key"
export HIVE_VISUAL_MODERATION_KEY="your-visual-key"
```

The CLI will emit warnings if these keys are not set.
