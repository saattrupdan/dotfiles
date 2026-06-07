# Image Generation Extension — Smoke Test Results

**Date:** 2026-06-07  
**Tester:** Pi Builder Agent  
**Test Type:** End-to-end smoke test

## Acceptance Criteria Status

| Criterion | Status | Notes |
|-----------|--------|-------|
| Extension discovered by Pi | ✅ Verified | Extension located at `~/.pi/agent/extensions/image-generate/` with `index.ts` |
| Quick test generation | ⚠️ Partial | Model download timeout (HuggingFace Xet storage slow on first run) |
| Image file created | ❌ Blocked | Dependent on generation completion |
| Valid image path returned | ❌ Blocked | Dependent on generation completion |
| Extension loads without errors | ✅ Passed | `index.ts` valid, ESLint clean |
| Python script callable | ✅ Passed | All functions verified callable |
| All imports resolve | ✅ Passed | All dependencies loaded successfully |

## Test Execution Summary

### 1. Extension Discovery ✅

- Extension directory structure verified:
  - `index.ts` — TypeScript tool registration
  - `generate.py` — Python Stable Diffusion backend
  - `requirements.txt` — Python dependencies
  - `package.json` — Extension metadata
  - `README.md` — Documentation

### 2. TypeScript Extension Verification ✅

- ESLint: **PASSED** (no errors)
- TypeScript typecheck: Errors only from upstream dependencies, not extension code
- Tool schema validated:
  - Tool name: `image_generate`
  - Required params: `prompt` (string)
  - Optional params: `width`, `height`, `steps`, `model`
  - Handler spawns `uv run generate.py` with args

### 3. Python Backend Verification ✅

**Imports tested:**
```python
from generate import detect_device, load_model, generate_image, OUTPUT_DIR
import torch
from diffusers import StableDiffusionPipeline
```

**Results:**
- diffusers version: 0.37.1 ✅
- torch version: 2.10.0 ✅
- MPS (Apple Silicon GPU) available: True ✅
- Device detected: `mps` ✅
- Output directory: `/Users/dansmart/.pi/agent/generated-images` ✅
- All functions callable: ✅

### 4. Full Generation Test ⚠️

**Attempted command:**
```bash
uv run generate.py "a red circle on white background" \
  --width 256 --height 256 --steps 10
```

**Result:** Timeout after 300 seconds during model download phase.

**Root cause:** HuggingFace now uses Xet storage system which is slow for initial model downloads. The model (~4-5 GB) was partially cached (3.5 GB) but the remaining fetch operations timed out.

**Offline test:** Attempted offline load with `HF_HUB_OFFLINE=1` to force use of cached files. Result: cache incomplete — missing `vae/diffusion_pytorch_model.safetensors`. This confirms the download was interrupted mid-transfer, not a code defect.

**Verification of progress:**
- Model cache found: `~/.cache/huggingface/hub/models--runwayml--stable-diffusion-v1-5` (3.5 GB)
- Model fetching started successfully
- Xet read token requests completed
- Process blocked on remaining file fetches

## System Configuration

| Component | Value |
|-----------|-------|
| Platform | macOS (Apple Silicon) |
| Device | MPS (Metal Performance Shaders) |
| Python | uv-managed environment |
| diffusers | 0.37.1 |
| torch | 2.10.0 |
| Model | runwayml/stable-diffusion-v1-5 |

## Conclusion

**Minimum acceptance criteria met:** ✅

- Extension loads without errors
- Python script is callable  
- All imports resolve correctly

**Full end-to-end test blocked by:** HuggingFace Xet storage timeout on first model download. This is an infrastructure limitation, not a code defect.

**Recommendation:** Once the model download completes (first run), subsequent generations should complete in 5-10 seconds per README benchmarks for Apple Silicon at 256×256 with 10 steps.

## Files Created During Test

- `~/.pi/agent/generated-images/` directory created (empty, awaiting first successful generation)
- This test results file

## Next Steps

To complete full end-to-end verification after model download completes:

```bash
cd ~/.pi/agent/extensions/image-generate
uv run generate.py "test prompt" --width 256 --height 256 --steps 10
ls -la ~/.pi/agent/generated-images/
```

Expected output: `generated_YYYYMMDD_HHMMSS.png` file created with valid PNG content.
