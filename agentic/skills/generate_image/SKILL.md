---
name: generate_image
description: Generate an image from a brief with MOSS-Image-SFT on sparkie. Enhance the prompt using the bundled official MOSS prompt-enhancer, then call the model router and return a local image link. Use for requests to draw, create, render or generate a new image.
last-updated: 2026-10-17
---

# Generate an image

The generator is `OpenMOSS-Team/MOSS-Image-SFT` on sparkie's model router,
served with vLLM-Omni. The router is reachable on the tailnet at
`http://100.102.237.34:31000`; it is not a public Internet service.

## Prepare the prompt

Read [the bundled MOSS prompt-enhancer instructions](prompt-enhancer/SKILL.md)
first. For Layout, also read
[prompt-enhancer/references/layout.md](prompt-enhancer/references/layout.md).
Follow its creative and fidelity rules; do not merely prepend generic quality
words to the user's brief. Create a UTF-8 JSON draft at a user-appropriate
location (use `/tmp` for an otherwise unscoped request):

- For an ordinary scene, use `{"caption": "..."}` with a developed, coherent
  description. Keep any wording that must appear in the image exact.
- For explicit placement, posters or panels, use the official Layout draft schema
  and absolute `xyxy` pixel boxes. Its compiler validates and converts the draft.
  Supply a matching `--size` to the generator. Default to 1024x1024 if unspecified.

Do not change explicit dimensions silently. Both dimensions must be multiples
of 16. For this sparkie endpoint each dimension is 512–1024 pixels and total
area is at most 1024×1024. If the requested dimensions cannot be served,
explain that constraint rather than generating at a different size.

## Generate and deliver

The Python CLI uses only the standard library. It compiles the draft with the
bundled upstream compiler, sends the *compiled* positive prompt to the router,
decodes the response and saves a PNG. It rejects failed requests and unexpected
responses instead of manufacturing an image.

```bash
uv run --no-project python3 ~/.pi/agent/skills/generate_image/scripts/generate.py \
  --draft /tmp/my-image-draft.json \
  --size 1024x1024 \
  --output /tmp/my-image.png
```

Options: `--seed` (default 42) and `--endpoint` (default `MOSS_IMAGE_URL`
or sparkie's tailnet router). Run
`--help` for the full interface. Generation uses 50 Euler steps, CFG 3,
flow shift 5, negative-branch skip layer 22 and one output. A request can take
several minutes; the CLI allows 15 minutes. Check the output exists before
responding. Give the user the full `file:///...` URL of the saved PNG. Do not
claim the image depicts text or details accurately unless you inspect it; the
model can miss fine details. When the user asks not to open generated images,
check only file existence, format signature and metadata, not the contents.

## Availability

```bash
curl -fsS --max-time 5 http://100.102.237.34:31000/v1/models
```

Expect `OpenMOSS-Team/MOSS-Image-SFT`. If the tailnet, router or model is
unavailable, report the error; do not send prompts to an unrelated endpoint.
The router currently has no per-user authentication, so do not submit private
briefs or sensitive input through this shared tailnet service.

Bundled prompt-enhancer source: OpenMOSS/MOSS-Image at
`c1355e6b1986dfe8fba3c0455783a05899212342` (Apache-2.0). Its instructions
prepare prompts; the CLI below performs the separate inference step.
