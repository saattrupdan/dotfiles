---
name: annotation
description: >-
  Create standalone, keyboard-first HTML interfaces in /tmp for human annotation,
  labeling, binary classification, review, or dataset triage, with companion JSON
  labels.
last-updated: 2026-10-12
---

# Annotation interfaces

Create a **self-contained HTML file** for the specific annotation task. The agent
builds the interface directly; this skill does not prescribe a generator or fixed
schema for the examples. Put every generated artifact in `/tmp`, never in the repo.

## Workflow

1. Identify the examples, stable IDs, label choices, and any task-specific context.
   Decide whether labels are binary, multiclass, or structured. Do not guess what
   ambiguous labels mean; put their definitions in the interface.
2. Write `/tmp/<descriptive-name>.html`. Embed the examples and all CSS/JS in that
   single file; use no CDN, external assets, build step, or remote requests. Escape
   embedded data for the HTML/script context (in particular `</script>`), and render
   untrusted example text with `textContent`, not `innerHTML`.
3. Use `/tmp/<descriptive-name>.json` for the companion labels. Keep stable example
   IDs in the JSON so reordered examples do not shift annotations. Include only the
   fields needed by this task (for example, `{ "item-id": "yes" }`); document any
   more elaborate schema in the page. Preserve existing labels when reopening.
4. Pick a **real persistence method** before presenting the page. Prefer immediate
   writes to the companion JSON using one of the methods below. If neither is
   available, provide an honest manual export path; do not claim autosave.
5. Check that the HTML opens, arrow shortcuts work, an annotation survives reload,
   and the JSON has the expected filename and values. Give the user a full
   `file:///tmp/...html` URL (or the localhost URL for a local server) and the full
   `file:///tmp/...json` URL if the file has been created.

## Keyboard and interface rules

- **Up**: previous example. **Down**: next example. Do not wrap at either end.
- For binary classification, **Right = yes** and **Left = no**. Show these exact
  mappings visibly next to the choices; if the task uses different terminology,
  show its meaning alongside yes/no. A label key must update the current example,
  not silently navigate away. Do not map left/right to navigation in this mode.
- For nonbinary tasks, show the available labels and assign discoverable shortcuts
  only when they do not conflict with up/down. Do not force binary yes/no semantics.
- Ignore global shortcuts when focus is in a text input, textarea, select, editable
  element, or modifier key combination. Call `preventDefault()` for shortcuts that
  are handled. Provide clickable controls as well as keys.
- Show current position, stable ID, saved/unsaved status, total labeled, and the
  current example's label. Mark failed saves visibly and retain the unsaved value
  for retry; never display "saved" before persistence succeeds.
- On startup, restore prior labels **before** allowing edits. Serialize writes to
  avoid an earlier request finishing after a later one and replacing new labels.
  Save after every change; do not rely only on `beforeunload` or `sendBeacon`.

## Saving beside the HTML

**A `file://` page cannot silently create or overwrite a sibling JSON file with
ordinary JavaScript.** `localStorage` persists in the browser profile, not in
`/tmp/<name>.json`; an automatic Blob download may create numbered copies in
Downloads rather than update the companion file. Choose explicitly:

- **File System Access API (supported browsers):** From a user click, call
  `showSaveFilePicker` with suggested name `<name>.json`, ask the user to select
  `/tmp/<name>.json`, and keep the returned handle for subsequent `createWritable()`
  writes. Load an existing JSON file with a user-initiated `showOpenFilePicker`
  when resuming, or use the selected save handle's `getFile()`. Check for API
  support and permission, and surface denied/revoked permissions. Do not promise
  this path in Firefox; browser support varies.
- **Local write endpoint (works with Firefox):** If hands-free live sidecar writes
  are required, create a *task-specific* tiny local server in `/tmp` and serve the
  HTML at `http://127.0.0.1:<port>/`. The server reads/writes **only** the
  corresponding `/tmp/<name>.json`; the page fetches existing labels at startup
  and POSTs changes after every annotation. Bind to loopback, check the request's
  Origin and content type, validate IDs/labels, and atomically replace the JSON
  file (temporary file in the same directory, then rename). Never expose an
  unrestricted file-write endpoint. Keep the HTML self-contained: the server is
  only a persistence bridge, not a dependency for rendering. Give the user the
  server URL and explain that the server must stay running while annotating.
- **No filesystem write available:** Keep labels in memory (optionally also
  `localStorage` for crash recovery) and provide an explicit **Export JSON** button
  that downloads `<name>.json`. Tell the user to move/overwrite that file at
  `/tmp/<name>.json` themselves. This is **not live sidecar saving**. If the user
  requires live saving, use one of the first two methods instead.

Avoid overwriting existing annotations with an empty object when loading fails.
Fail visibly and let the user recover the existing JSON before annotating. If an
existing sidecar and in-browser draft both exist, make their differences visible
rather than silently discarding either one.
