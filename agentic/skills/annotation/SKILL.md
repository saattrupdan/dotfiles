---
name: annotation
description: >-
  Build task-specific, keyboard-first HTML annotation interfaces for reviewing
  examples, editing labels, comparing model predictions and autosaving decisions.
  Use when creating or updating an annotation or dataset review page.
last-updated: 2026-10-16
---

# Annotation interfaces

Create a **standalone, keyboard-first HTML file** for the specific annotation job. Build
it directly under `/tmp`, not in a repository. Use stable example IDs as annotation keys
so reordering a queue never shifts decisions. Keep the page self-contained: embed CSS,
JavaScript and example metadata; use no CDN, build step or public network service. A
private token-gated loopback server may serve local images and receive autosaves when
the task needs them.

## Dan's interface preferences

- Keep the page compact: a task-specific title, current sample, necessary choices, a
  progress bar, a short count and controls. Show useful model-versus- dataset cues when
  comparing them, but avoid extra panels and instructions. Render untrusted text with
  `textContent`, not `innerHTML`; escape embedded data for the HTML/script context,
  including `</script>`.
- **Up/Down** move between examples without wrapping or marking them reviewed.
  Navigation must not inflate the reviewed count. The progress bar tracks the **current
  position** and moves when changing samples; show absolute position and reviewed count
  separately. For a very large queue, a 100-sample segment makes each move visible while
  the count retains the absolute position.
- Provide **one forward action**, `Next`: mark the current sample reviewed, autosave and
  advance; on the last sample, save and stay there. **Enter** does the same. Do not add
  separate `Next`, `Done` and `Mark reviewed` actions.
- For binary single-choice tasks, **Right = yes** and **Left = no**; either choice saves
  and advances. For multi-label tasks, clicking a label toggles it and stays on the
  sample so other labels can be edited; `Next` completes that sample. Indicate selected
  labels clearly.
- When model predictions are available, show them distinctly from existing labels and
  provide a clickable `Use model and next` action. **Shift+Enter** copies the model's
  complete predictions as the sample's new labels, saves and advances. Do **not** use
  Shift+Tab; leave it to browser focus navigation. If model predictions violate a
  mutually exclusive label constraint, stop and request a manual choice rather than
  saving an invalid combination or silently picking one. A model/dataset disagreement is
  a review candidate, not proof that the model is wrong.
- Ignore page shortcuts in text inputs, textareas, selects and editable elements, or
  with unrelated modifiers. Prevent the browser default for handled shortcuts. Offer
  visible buttons as well as keyboard shortcuts.

## Continuous autosave

- Autosave **every label change, measurement, review action and cursor move**. Restore
  both annotations and position before enabling edits. Keep cursor state separate from
  the reviewed count. Never equate visiting a sample with reviewing it.
- When the annotations must be usable later without a download, persist them to a
  private, authenticated loopback service as well as in browser storage. Use stable IDs
  and bind the service to the queue; reject unknown IDs. Keep server files private and
  make writes atomic. Browser storage alone does not write to the annotation folder and
  is not a substitute for server autosave.
- For large queues, use IndexedDB records per sample, not one ever-growing
  `localStorage` JSON value: browser localStorage quotas can be exhausted long before
  the queue is complete. Migrate existing browser annotations without discarding them. A
  unique queue/dataset key prevents unrelated reviews from sharing state. If a queue is
  narrowed, preserve earlier annotations and exclude already-reviewed IDs rather than
  resetting or re-showing them.
- Dan prefers **no JSON export button** when private server autosave exists. Do not make
  him export JSON to preserve or hand off completed work. Add export only when
  explicitly requested or when the task genuinely cannot use durable server storage and
  its output must be transferred.
- On storage or sync failure, keep the edit in memory, show a compact error and retry
  control, and do not imply it was saved. Warn on closing only while writes are pending
  or failed; do not show an "unexported changes" warning after durable autosave. Do not
  delete browser state until the server has confirmed the same edits.

## Images, measurements and provenance

- Use private, token-gated localhost URLs for local photos; never embed private image
  bytes in HTML or expose them through a public server. Follow each dataset's access
  rules. Where agents may not view image pixels, verify only text metadata, hashes,
  manifests, headers and aggregate results; the human browser can render authorized
  images.
- When asked to compare past and current labels, show all relevant current labels plus
  identifiable historical selections, rather than hiding older positives. Distinguish
  manually measured values from samples that have not been manually measured. Never
  fabricate measurements or turn browser-local changes into authoritative ground truth
  without explicit approval.
- For drag-to-measure interactions, map pointer coordinates to the displayed image
  rather than a letterboxed container, and handle resizing during a drag. Keep raw,
  **unrounded** geometry for label thresholds and saved measurements; round only the
  displayed percentage. Update mutually exclusive labels together. Preserve an explicit
  human qualitative decision when it differs from a measurement proxy.
- When asked for an error-focused queue, include only actual model/label disagreements,
  order larger errors first and exclude previously annotated samples. Keep test or
  held-out images out of a non-test review queue. Do not call repeated test-set ranking
  independent validation.

## Check before handing it over

Test the page without surfacing restricted image pixels: first/last navigation, position
and reviewed counts, multi-label edits, `Next`/Enter, Shift+Enter, Shift+Tab remaining
unbound, model-label conflicts, drag thresholds, storage failure/retry, autosave and
cursor restoration after reload, and exclusion of already-reviewed or forbidden IDs.
Confirm the server rejects unlisted IDs and that the HTML, queue and storage keys agree.
Give Dan the full `file:///tmp/...html` URL and tell him to reload an existing tab after
a page update.
