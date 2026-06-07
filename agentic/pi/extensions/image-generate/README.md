# image-generate extension

Provides the `image_generate` tool for creating images from text prompts using
Stable Diffusion models. Supports local GPU/CPU inference with automatic model
download on first run.

## Installation

The extension requires Python dependencies to be installed before use. Run from
the extension directory:

```bash
cd ~/.pi/agent/extensions/image-generate
pip install -r requirements.txt
```

Or with uv (recommended):

```bash
cd ~/.pi/agent/extensions/image-generate
uv pip install -r requirements.txt
```

### Requirements

- Python 3.9+
- ~4 GB disk space for the base model (downloaded automatically)
- GPU with 4+ GB VRAM recommended for acceptable generation times

## Enabling the extension

Pi auto-discovers extensions from `~/.pi/agent/extensions/`. No configuration in
`settings.json` is required — simply ensure the `image-generate/` directory
exists with `index.ts` and the Python dependencies are installed.

Restart any running Pi session for changes to take effect. Verify the tool is
available by asking Pi to list its tools or by using it in a prompt.

## Model options

The extension defaults to **`runwayml/stable-diffusion-v1-5`**, a well-tested
general-purpose model. Any Hugging Face diffusion model compatible with the
`StableDiffusionPipeline` can be used via the `--model` flag.

Popular alternatives:

| Model | Size | Strengths |
|-------|------|-----------|
| `runwayml/stable-diffusion-v1-5` | ~4 GB | Fast, general purpose, widely compatible |
| `stabilityai/stable-diffusion-2-1` | ~5 GB | Improved quality, better text handling |
| `stabilityai/stable-diffusion-xl-base-1.0` | ~7 GB | Higher resolution output, better composition |

Models are downloaded automatically on first use and cached in the Hugging Face
hub directory (`~/.cache/huggingface/` by default).

## Usage from agent prompts

The `image_generate` tool accepts the following parameters:

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `prompt` | string | Yes | — | Text description of the image to generate |
| `model` | string | No | `runwayml/stable-diffusion-v1-5` | HuggingFace model identifier |
| `width` | number | No | `512` | Output image width in pixels |
| `height` | number | No | `512` | Output image height in pixels |
| `steps` | number | No | `50` | Number of inference steps; higher = better quality, slower |

### Example agent prompt

```
Generate a concept art image of a cyberpunk city at night with neon signs and
flying cars, using the stable-diffusion-xl model, 1920x1080 resolution, 50 steps.
```

The agent will call:

```json
{
  "name": "image_generate",
  "arguments": {
    "prompt": "cyberpunk city at night with neon signs and flying cars",
    "model": "stabilityai/stable-diffusion-xl-base-1.0",
    "width": 1920,
    "height": 1080,
    "steps": 50
  }
}
```

### CLI usage (standalone)

The extension also ships a standalone CLI script for direct invocation:

```bash
# Basic usage
uv run generate.py "a serene mountain landscape at sunset"

# With custom parameters
uv run generate.py "portrait of a cat" \
  --model runwayml/stable-diffusion-v1-5 \
  --width 768 --height 768 \
  --steps 40
```

Generated images are saved to `~/.pi/agent/generated-images/` by default.

## GPU/CPU requirements and performance

### Device detection

The script automatically detects the best available device:

- **CUDA GPU** (NVIDIA): Fastest option, recommended for serious use
- **MPS** (Apple Silicon): Good performance on M1/M2/M3 Macs
- **CPU**: Works everywhere but significantly slower

Check detected device in the script output before generation starts.

### Expected generation times

Times vary by hardware, model, resolution, and step count. Approximate
benchmarks for 512×512 at 30 steps:

| Hardware | Time per image |
|----------|----------------|
| NVIDIA RTX 3080 (10 GB VRAM) | 2–4 seconds |
| NVIDIA RTX 4090 (24 GB VRAM) | 1–2 seconds |
| Apple M2 Max (unified memory) | 5–10 seconds |
| Apple M1 (8 GB RAM) | 15–30 seconds |
| Modern CPU (8+ cores) | 2–5 minutes |
| Older CPU (4 cores) | 5–10 minutes |

Higher resolutions and step counts increase times roughly linearly. For
1024×1024, expect ~4× the 512×512 time. XL models (~7 GB) are slower than
v1.5/v2.1 (~4–5 GB).

### Memory requirements

- **Minimum**: 4 GB system RAM (CPU mode, may swap)
- **Recommended**: 8+ GB system RAM, 4+ GB GPU VRAM
- **XL models**: 8+ GB GPU VRAM for comfortable operation

If you encounter out-of-memory errors:

1. Reduce resolution (`--width`/`--height` or `size` parameter)
2. Reduce batch size (currently 1, hard-coded)
3. Close other GPU applications
4. Use CPU mode explicitly by setting `CUDA_VISIBLE_DEVICES=""` (slower but works
   with any RAM)

## Troubleshooting

### CUDA out of memory

Reduce resolution, use a smaller model, or enable memory-efficient attention if
your GPU supports it:

```bash
export PYTORCH_CUDA_ALLOC_CONF=garbage_collection_threshold:0.6,max_split_size_mb:512
```

### Model download fails

Ensure internet connectivity and sufficient disk space (~4–7 GB). Models are
cached in `~/.cache/huggingface/`; clear this directory to re-download.

### Import errors after install

Verify the virtual environment or system Python has all dependencies:

```bash
uv run python -c "from diffusers import StableDiffusionPipeline; print('OK')"
```

If this fails, reinstall:

```bash
uv pip install -r requirements.txt --force-reinstall
```

### macOS performance

On Apple Silicon, ensure PyTorch is using MPS (Metal Performance Shaders):

```python
import torch
print(torch.backends.mps.is_available())  # Should print True
```

If MPS is unavailable, install a recent PyTorch version with MPS support.

## Implementation notes

- The Python backend (`generate.py`) handles device detection, model loading,
  and image generation
- The TypeScript frontend (`index.ts`) registers the `image_generate` tool with
  Pi's extension API
- Images are saved as PNG files in the configured output directory
- The extension is a work in progress — check `index.ts` for TODO comments on
  planned backend enhancements (DALL-E 3, Stability AI API, Replicate)
