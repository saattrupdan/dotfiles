---
name: mermaid
description: Create and render mermaid diagrams. Generates .mmd source files and optionally exports to SVG or PNG. Use when the user asks to create, draw, or visualize a diagram, flowchart, mindmap, sequence, Gantt chart, pie chart, class diagram, state diagram, entity relationship, git graph, or any mermaid-supported diagram type.
tagline: Create and render mermaid diagrams to .mmd, SVG, or PNG
last-updated: 2026-05-28
---

## Overview

This skill handles the full lifecycle of mermaid diagrams: interpreting a description, generating valid mermaid source (.mmd), and optionally rendering to SVG or PNG.

## Workflow

### 1. Generate the .mmd source

- Parse the user's description of the diagram (nodes, edges, labels, layout).
- Write valid mermaid source to a `.mmd` file in the current working directory.
- Use clear node labels (short identifiers as IDs, human-readable text in display labels).
- Choose the appropriate diagram type (`graph TD` for flowcharts, `sequenceDiagram`, `gantt`, `pie`, `classDiagram`, `stateDiagram-v2`, `erDiagram`, `gitGraph`, `mindmap`, etc.).
- If the user specifies a filename, use it; otherwise, infer a sensible name from context.

### 2. Decide on an output format

- If the user explicitly requests SVG or PNG, render to that format.
- If the user doesn't specify, **ask** which format they prefer.
- Default to PNG if the user says "just show me something."

### 3. Render to the chosen format

- Use `mermaid-cli` (`mmdc`) via `npx @mermaid-js/mermaid-cli`.
- Find Chrome on the system portably:
  ```bash
  CHROME=$(which google-chrome 2>/dev/null || which chromium 2>/dev/null || which chromium-browser 2>/dev/null || echo "")
  if [ -z "$CHROME" ]; then
    CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    [ ! -f "$CHROME" ] && CHROME="/Applications/Chromium.app/Contents/MacOS/Chromium"
  fi
  ```
- Then:
  ```bash
  PUPPETEER_SKIP_DOWNLOAD=true \
  PUPPETEER_EXECUTABLE_PATH="$CHROME" \
  npx @mermaid-js/mermaid-cli -i <input.mmd> -o <output.png|svg>
  ```
- If `mmdc` is not installed, install it globally first:
  ```
  npm install -g @mermaid-js/mermaid-cli
  ```
  (Only install if not already present — check with `which mmdc`.)

### 4. Verify the output

- Confirm the output file exists and is non-empty.
- For PNG: check it's a valid image (`file` command).
- Report the file path and dimensions back to the user.

## Diagram type selection

| User intent | Diagram type |
|---|---|
| Flowchart, process, decision tree | `graph TD` |
| Communication between actors | `sequenceDiagram` |
| Timeline or project schedule | `gantt` |
| Pie / donut proportions | `pie` |
| Class relationships | `classDiagram` |
| State transitions | `stateDiagram-v2` |
| Database schema | `erDiagram` |
| Git branch history | `gitGraph` |
| Hierarchical idea map | `mindmap` |
| Architecture / system layout | `graph LR` or `graph TD` |

## Making diagrams look good

### Themes

Pick a theme that fits the mood — avoid the default grey:

| Theme | Best for |
|---|---|
| `default` | Neutral, clean |
| `forest` | Nature, growth, positive |
| `dark` | Presentations, dark-mode docs |
| `neutral` | Minimalist, academic |
| `base` | Custom styling on top |

Add at the top: `%%{init: {'theme': 'forest'}}%%`

### Node styling

Use `style` blocks for colored, rounded boxes:

```
style NODE_ID fill:#6C5CE7,stroke:#4834D4,color:#fff,stroke-width:2px
```

Pick a cohesive palette (6–7 distinct colors). Assign one per key node.

### Reducing clutter

- Keep labels short (2–4 words max).
- Use `<br/>` for multi-line labels instead of long single lines.
- Avoid `linkStyle` blocks — they break on some mermaid-cli versions.
- Place related nodes close together in the source; mermaid respects declaration order.
- Consider `graph LR` (left-to-right) for wide diagrams instead of `TD` (top-down).

## Styling tips

- Use `<br/>` for multi-line labels.
- Use plain Unicode text directly — θ, φ, →, ←, ≈, ≠, etc. Do **not** escape with `\` or `\\`.
- Use `- ->` for dashed arrows, `-.->` for dotted.
- Keep node IDs short (single letters or abbreviations); put descriptive text in quoted labels.

## Common pitfalls

- **Backslashes in labels**: Do not use `\theta` or `\\n` — mermaid renders Unicode natively. Write θ directly.
- **linkStyle blocks**: Some mermaid-cli versions choke on `linkStyle` declarations. If rendering fails, strip them and retry.
- **Long labels**: Cause cramped, unreadable diagrams. Use short node IDs and brief display text.
- **Special characters in node IDs**: Use underscores if needed. Never spaces or symbols in the ID portion.

## Hard rules

- Always save the `.mmd` source file — the user should have the editable source.
- Always ask for output format preference if the user hasn't specified one.
- Detect Chrome portably; do not hardcode macOS paths.
- Do not install mermaid-cli unless it's not already available. Check first.
