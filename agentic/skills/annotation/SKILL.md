---
name: annotation
description: >-
  Create standalone, keyboard-first HTML interfaces in /tmp for human annotation,
  labeling, binary classification, review, or dataset triage, with local autosave
  and JSON export.
last-updated: 2026-10-12
---

# Annotation interfaces

Create a **self-contained HTML file** for the specific annotation task. The agent
builds the interface directly; this skill does not prescribe a generator or fixed
schema for the examples. Put every generated artifact in `/tmp`, never in the repo.

## Workflow

1. Identify the examples, stable IDs, label choices, and any task-specific context.
   Decide whether labels are binary, multiclass, or structured. Use concise,
   unambiguous control labels. Write a very brief, task-specific instruction as
   the title (for example, "Mark whether this is relevant."); add no other
   explanatory copy.
2. Write `/tmp/<descriptive-name>.html`. Embed the examples and all CSS/JS in that
   single file; use no CDN, external assets, build step, or remote requests. Escape
   embedded data for the HTML/script context (in particular `</script>`), and render
   untrusted example text with `textContent`, not `innerHTML`.
3. Use stable example IDs as JSON keys so reordered examples do not shift labels.
   Include only the fields needed by this task (for example,
   `{ "item-id": "yes" }`). Autosave in browser `localStorage` after every edit;
   add an **Export JSON** control that downloads `<descriptive-name>.json`.
4. Check that the HTML opens, the title describes the task, arrow shortcuts work,
   labeling advances to the next sample (and stays on the last), the progress bar
   updates as samples are labeled, an annotation survives reload, export contains
   the latest labels, and closing with unexported changes prompts for confirmation.
   Give the user the full `file:///tmp/...html` URL. Tell them the export should be
   saved to `/tmp/<descriptive-name>.json`; do not claim that a browser download
   automatically appears there.

## Keyboard and interface rules

- Keep the visible interface **super minimal: a title, a progress bar, the current
  sample, and its controls**. The title must be a mini-sentence telling the user
  what to annotate; use it for the HTML `<title>` too. No other headings,
  instructions, descriptions, progress counts, IDs, metadata panels, status prose,
  or decorative copy. Controls may have short labels and key glyphs (for example,
  `← No`, `Yes →`, `↑`, `↓`). Use accessible names for icon-only buttons without
  adding visible copy.
- Show a compact progress bar for the number of labeled samples out of the total.
  Update it after each label change and when restoring saved labels; navigating
  without labeling must not increase it. Give it an accessible name, such as
  "Samples labeled", without adding a visible count.
- **Up**: previous example. **Down**: next example. Do not wrap at either end.
- For binary classification, **Right = yes** and **Left = no**. Show these exact
  mappings on the controls. A label key must update the current example before
  advancing; do not map left/right to navigation in this mode.
- For nonbinary tasks, show the available labels and assign discoverable shortcuts
  only when they do not conflict with up/down. Do not force binary yes/no semantics.
- After any label choice, by key or click, record the label for the current sample
  and attempt autosave, then advance to the next sample. Stay on the last sample
  after labeling it; never wrap. Keep previous/next controls for corrections.
  Choosing the already-selected label also advances.
- Ignore global shortcuts when focus is in a text input, textarea, select, editable
  element, or modifier key combination. Call `preventDefault()` for shortcuts that
  are handled. Provide clickable controls as well as keys.
- Indicate the current label on its control (for example, selected styling). Keep
  **Export JSON** among the controls. If local autosave fails, retain the value in
  memory and expose a compact error/retry control; never imply it was saved.
- Restore local labels **before** allowing edits. Write the latest labels to
  `localStorage` after every change, not only on page exit.

## Local autosave, export, and close warning

- Use a `localStorage` key specific to this HTML file and dataset. Store the labels
  and an export checkpoint together, so both survive reload. Catch storage access,
  quota, and JSON parse errors; never silently replace existing labels with `{}`.
  If restoring fails, block edits and offer a compact recovery control.
- Export the **current** labels as a JSON Blob with the HTML's basename and `.json`
  extension. Use a user-clicked download control. A `file://` page cannot silently
  write the JSON beside itself: `localStorage` is browser data, and the user picks
  the download location (often Downloads). Tell the user where to save the export
  outside the interface, not in explanatory text on the page.
- Treat any label change since the last export action as **unexported**, even when
  it is safely autosaved in `localStorage`. Record the checkpoint when the export
  action starts, but do not claim the browser confirmed the download finished.
  Persist the checkpoint alongside labels so reloading does not forget it.
- Register `beforeunload`: if labels differ from the export checkpoint **or local
  autosave failed**, call `preventDefault()` and set `event.returnValue = ''` to
  request the browser's built-in confirmation on close, reload, or navigation.
  Do not use a custom modal or visible warning copy. Browsers choose the warning
  text and may require prior user interaction before showing it.
- If labeling continues after export, mark the new changes unexported again. Do
  not interpret a successful localStorage write as a JSON export.
