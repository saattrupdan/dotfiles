# image-generate extension

Provides the `image_generate` tool for creating images from text prompts using
the **Ideogram 4** model. Supports local GPU/CPU inference with automatic model
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

- Python 3.10+
- ~20 GB disk space for the base model (downloaded automatically on first run)
- GPU with 8+ GB VRAM recommended for acceptable generation times
- Hugging Face account with accepted license for gated model access

## Enabling the extension

Pi auto-discovers extensions from `~/.pi/agent/extensions/`. No configuration in
`settings.json` is required — simply ensure the `image-generate/` directory
exists with `index.ts` and the Python dependencies are installed.

Restart any running Pi session for changes to take effect. Verify the tool is
available by asking Pi to list its tools or by using it in a prompt.

## Model access setup

**Required before first use:** The Ideogram 4 model is gated on Hugging Face.

1. **Accept the license** — Visit the model page and click "Agree and access repository":
   - [ideogram-ai/ideogram-4-fp8](https://huggingface.co/ideogram-ai/ideogram-4-fp8) (recommended, works on all devices)
   - [ideogram-ai/ideogram-4-nf4](https://huggingface.co/ideogram-ai/ideogram-4-nf4) (CUDA-only, faster on NVIDIA GPUs)

2. **Authenticate** — Create a Hugging Face access token and log in:
   ```bash
   hf auth login
   ```
   Or export the token directly:
   ```bash
   export HF_TOKEN="hf_..."
   ```

3. **Optional: Magic Prompt API key** — For automatic prompt expansion, get a free API key at
   [https://developer.ideogram.ai/](https://developer.ideogram.ai/) and set:
   ```bash
   export IDEOGRAM_API_KEY="your_key_here"
   ```
   Without this, the model runs with your raw prompt (still works, just less refined).

## Model options

The extension defaults to **`fp8` quantization**, which runs on any device (CPU,
MPS, or CUDA). The `nf4` quantization is available for CUDA GPUs only and offers
better performance.

| Quantization | Size | Hardware | Speed |
|--------------|------|----------|-------|
| `fp8`        | ~10 GB | All (CPU, MPS, CUDA) | Standard |
| `nf4`        | ~6 GB  | CUDA only            | Faster   |

Models are downloaded automatically on first use and cached in the Hugging Face
hub directory (`~/.cache/huggingface/` by default).

## Usage from agent prompts

The `image_generate` tool accepts the following parameters:

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `prompt` | string | Yes | — | Text description of the image to generate |
| `width` | number | No | `1024` | Output image width in pixels (multiples of 16, max 2048) |
| `height` | number | No | `1024` | Output image height in pixels (multiples of 16, max 2048) |
| `quantization` | string | No | `"fp8"` | Model quantization: `"fp8"` (universal) or `"nf4"` (CUDA-only) |
| `sampler_preset` | string | No | `"V4_QUALITY_48"` | Quality/speed preset (see sampler presets below) |
| `seed` | number | No | `0` | Random seed for reproducibility |
| `magic_prompt_key` | string | No | From env | API key for prompt expansion (or set IDEOGRAM_API_KEY env var) |

### Sampler presets

| Preset | Steps | Use case |
|--------|-------|----------|
| `V4_QUALITY_48` | 48 | Highest quality (default) |
| `V4_BALANCED_32` | 32 | Good quality/speed balance |
| `V4_SPEED_20` | 20 | Fast generation |

### Example agent prompt

```
Generate a photorealistic portrait of an elderly wizard with a long white beard
holding a glowing crystal ball, 2048x2048 resolution, highest quality.
```

The agent will call:

```json
{
  "name": "image_generate",
  "arguments": {
    "prompt": "photorealistic portrait of an elderly wizard with a long white beard holding a glowing crystal ball",
    "width": 2048,
    "height": 2048,
    "sampler_preset": "V4_QUALITY_48"
  }
}
```

### CLI usage (standalone)

The extension also ships a standalone CLI script for direct invocation:

```bash
# Basic usage
uv run generate.py "a serene mountain landscape at sunset"

# With custom parameters
uv run generate.py "cyberpunk city at night" \
  --width 2048 --height 2048 \
  --quantization fp8 \
  --sampler-preset V4_QUALITY_48

# With magic prompt API key
export IDEOGRAM_API_KEY="your_key"
uv run generate.py "a cat wearing a tiny wizard hat" --magic-prompt-key "$IDEOGRAM_API_KEY"

# Disable magic prompt (use prompt verbatim)
uv run generate.py "exact prompt here" --no-magic-prompt
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

Times vary by hardware, resolution, and sampler preset. Approximate benchmarks
for 1024×1024 with V4_QUALITY_48:

| Hardware | Time per image |
|----------|----------------|
| NVIDIA RTX 4090 (24 GB VRAM) | 15–30 seconds |
| NVIDIA RTX 3080 (10 GB VRAM) | 30–60 seconds |
| Apple M2 Max (unified memory) | 1–2 minutes |
| Apple M1 (8 GB RAM) | 2–4 minutes |
| Modern CPU (8+ cores) | 5–10 minutes |
| Older CPU (4 cores) | 10–20 minutes |

Higher resolutions (e.g., 2048×2048) increase times roughly 2–4×. The model is
~9.3B parameters and requires significant compute even with quantization.

### Memory requirements

- **Minimum**: 12 GB system RAM (CPU mode, may swap)
- **Recommended**: 16+ GB system RAM, 8+ GB GPU VRAM
- **fp8 quantization**: Runs on any device with sufficient RAM
- **nf4 quantization**: CUDA-only, requires 8+ GB VRAM

If you encounter out-of-memory errors:

1. Reduce resolution (`--width`/`--height`)
2. Use a faster sampler preset (`V4_SPEED_20`)
3. Close other GPU applications
4. Ensure no other memory-intensive processes are running

## Troubleshooting

### Gated model access error (404 / GatedRepoError)

Ensure you have accepted the license on Hugging Face and are authenticated:

```bash
# Visit model page and click "Agree and access repository"
# https://huggingface.co/ideogram-ai/ideogram-4-fp8

# Then authenticate
hf auth login
```

### Import errors after install

Verify the ideogram4 package is installed:

```bash
uv run python -c "from ideogram4 import Ideogram4Pipeline; print('OK')"
```

If this fails, reinstall:

```bash
uv pip install -r requirements.txt --force-reinstall
```

### Magic prompt not working

Without an API key, magic prompt expansion falls back gracefully — your plain
prompt is used verbatim. To enable expansion:

1. Get a free API key at https://developer.ideogram.ai/
2. Set `export IDEOGRAM_API_KEY="your_key"` or pass `--magic-prompt-key`

### macOS performance

On Apple Silicon, ensure PyTorch is using MPS (Metal Performance Shaders):

```python
import torch
print(torch.backends.mps.is_available())  # Should print True
```

If MPS is unavailable, install a recent PyTorch version with MPS support.

### CUDA out of memory

Reduce resolution, use fp8 quantization (auto-selected on non-CUDA), or enable
memory-efficient attention:

```bash
export PYTORCH_CUDA_ALLOC_CONF=garbage_collection_threshold:0.6,max_split_size_mb:512
```

## Implementation notes

- The Python backend (`generate.py`) handles device detection, model loading,
  and image generation using the Ideogram 4 pipeline
- The TypeScript frontend (`index.ts`) registers the `image_generate` tool with
  Pi's extension API
- Images are saved as PNG files in the configured output directory
- Magic prompt expansion uses Ideogram's hosted API (free) when API key is provided
- Model weights are gated and require Hugging Face authentication

## Model architecture

Ideogram 4 is a 9.3B parameter Diffusion Transformer (DiT) trained from scratch
on structured JSON captions. Key features:

- **Single-stream architecture**: Text and image tokens processed together
- **Vision-language text encoder**: Qwen3-VL-8B-Instruct for rich semantic understanding
- **Flexible resolution**: Any resolution from 256 to 2048 (multiples of 16)
- **Excellent text rendering**: Best-in-class for in-image text generation
- **Spatial layout control**: Bounding-box coordinates for precise placement

For more details, see the [Ideogram 4 GitHub repository](https://github.com/ideogram-oss/ideogram4).
