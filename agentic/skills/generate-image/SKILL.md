---
name: generate-image
description: >-
  Generate an image from a brief with MOSS-Image-SFT on sparkie. Develop a
  faithful caption or spatial Layout, compile it with the bundled MOSS tool,
  then return the generated image link. Use for requests to draw, create,
  render or generate a new image.
last-updated: 2026-10-17
---

# Generate an image

The generator is `OpenMOSS-Team/MOSS-Image-SFT` on sparkie's model router,
served with vLLM-Omni. The router is reachable on the tailnet at
`http://100.102.237.34:31000`; it is not a public Internet service.

## Develop the prompt for every image

Turn the user's idea into a concrete image description before generating. The
agent makes the creative decisions; the bundled compiler handles Layout
coordinate conversion and serialization. Do not merely prepend generic quality
words to the brief.

Preserve the user's subjects, counts, relationships, medium, style, exclusions
and intended visible wording. Resolve ordinary creative gaps yourself; ask only
when a missing decision materially changes the image. Do not invent factual
event logistics or specifications as if the user supplied them. Default to
English for descriptive prose unless another language is requested. Preserve
visible text verbatim in its original language, including punctuation,
capitalization and intended line breaks. Distinguish text that should appear in
the image from quoted instructions or reference material.

Describe visible choices: subject and action, relevant appearance, setting,
camera/framing, medium, lighting, materials, palette and mood. Add detail where
it makes the image more specific. Avoid redundant quality tags, unrequested
style changes, arbitrary word budgets and invisible process notes. Keep a
minimalist brief minimalist; do not turn a rich brief into a generic
title/hero/footer template. Keep JSON, bounding-box and conversion instructions
out of image-description fields: they are not depicted content.

For designed images, compose information and imagery together. Establish
reading order, relative prominence, coherent groups and readable text at the
chosen resolution. Write intended copy rather than placeholders such as
"headline here". Do not import unrelated names, watermarks or copy from a
reference. Use supplied references when useful; research only when factual
accuracy needs it or the user requests it.

## Write the draft

Create a UTF-8 JSON draft at a user-appropriate location (use `/tmp` for an
otherwise unscoped request). Choose a caption for ordinary scenes, photographs
and illustrations. Use Layout when specific text placement, a poster, several
panels or controlled object relationships benefit from bounding boxes. A
detailed image does not automatically need Layout.

### Caption

Write exactly `{"caption":"..."}` as cohesive prose, with spatial relations
in words and any visible wording quoted exactly. The caption can contain
paragraphs. Do not add coordinates or Layout fields just to make it look
structured.

### Layout

Read [the Layout schema and example](prompt-enhancer/references/layout.md)
before writing a Layout draft. Use readable JSON with `summary`, a flat `items`
array, concrete `width` and `height`, `bbox_coord_space="abs"` and
`bbox_format="xyxy"`. Draft boxes are `[x_min,y_min,x_max,y_max]` in actual
pixels from the top-left. Keep x in `0..width` and y in `0..height`; do not
normalize, center, reorder or quantize boxes yourself.

Use boxes for coherent visible units, splitting only when independent placement
matters. Natural occlusion and overlap are allowed; a box is not an instruction
to draw a border or panel. Describe appearance in item captions and global
treatment in `summary.caption`. Keep exact visible strings in text items'
`text` fields. Check that every requested string and line break fits its box
legibly at the chosen resolution. Preserve unrequested content when revising a
draft, and recompile after geometry or canvas changes.

Honor supplied dimensions. With only an aspect ratio, choose compatible pixel
dimensions; otherwise default to 1024×1024 unless the requested medium calls
for another shape. Both dimensions must be multiples of 16. This sparkie
endpoint supports 512–1024 pixels per side and at most 1024×1024 total pixels.
Do not silently change incompatible explicit dimensions; explain the constraint
instead. Use the same dimensions in the Layout draft and `--size`.

## Generate and deliver

Check the draft against the requested subject, exact text, geometry and canvas.
The standard-library Python CLI compiles it with the bundled upstream compiler,
sends only the *compiled* positive prompt to the router, verifies the returned
PNG and saves it. Fix draft validation errors and rerun; do not bypass the
compiler by hand-writing centered Layout JSON.

```bash
uv run --no-project python3 ~/.pi/agent/skills/generate-image/scripts/generate.py \
  --draft /tmp/my-image-draft.json \
  --size 1024x1024 \
  --output /tmp/my-image.png
```

Options: `--seed` (default 42) and `--endpoint` (default `MOSS_IMAGE_URL`
or sparkie's tailnet router). Run `--help` for the full interface. Generation
uses 50 Euler steps, CFG 3, flow shift 5, negative-branch skip layer 22 and one
output. A request can take several minutes; the CLI allows 15 minutes. Check
the output exists before responding. Give the user the full `file:///...` URL
of the saved PNG. Do not claim the image depicts text or details accurately
unless you inspect it; the model can miss fine details. When the user asks not
to open generated images, check only file existence, format signature and
metadata, not the contents.

## Availability

```bash
curl -fsS --max-time 5 http://100.102.237.34:31000/v1/models
```

Expect `OpenMOSS-Team/MOSS-Image-SFT`. If the tailnet, router or model is
unavailable, report the error; do not send prompts to an unrelated endpoint.
The router currently has no per-user authentication, so do not submit private
briefs or sensitive input through this shared tailnet service.

Bundled compiler source: OpenMOSS/MOSS-Image at
`c1355e6b1986dfe8fba3c0455783a05899212342` (Apache-2.0). The instructions
above prepare the draft; the CLI performs compilation and inference.
