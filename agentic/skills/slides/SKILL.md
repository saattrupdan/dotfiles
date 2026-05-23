---
name: slides
description: What — the noskillish/slides framework for building single-file HTML decks (no build step, 27+ ready components including pure-CSS bar charts and SVG diagrams, embed mode, stepped PDF export). Use when the user asks to create, draft, extend, or restyle a slideshow, presentation, or deck — e.g. "create a slideshow about X", "make a deck on Y", "turn these notes into slides", "export the deck to PDF".
tagline: Build single-file HTML presentations with the slides framework
last-updated: 2026-05-13
---

## What this skill does

Produces a single self-contained `deck.html` file in the user's chosen directory using the noskillish/slides framework. No build step, no dependencies beyond Google Fonts (Inter). Navigate with arrow keys / space / swipe; embed with `?embed`. A separate node script (`scripts/deck-to-pdf.mjs`) converts the finished deck into a stepped PDF.

## Bundled assets

This skill ships with everything you need — do not fetch from the internet:

- `template/deck.html` — the single template. Default theme is Craft: minimalist editorial with warm off-white (`#f5f0e8`) base, burnt orange (`#c05a3a`) accent, Inter + Fraunces. Set `colourScheme = "alexandra-institute"` in the ⚙️ DECK SETTINGS block at the top of `<body>` to switch to the Alexandra Institute brand variant (deep teal `#002a3f` dark slides, burnt sienna `#be5d2b` accent, Montserrat + Playfair Display, "Alexandra Institute" appended to the cover affiliation). Logos shown in the top-left are driven independently by the `darkLogo` and `whiteLogo` settings.
- `scripts/deck-to-pdf.mjs` — node script that exports a finished `deck.html` to a stepped PDF (one page per reveal state). See the "Exporting to PDF" section below.
- `reference/COMPONENTS.md` — the full component library (27 components: cover, two-column, three-column, capability list, dark callout, dot flow, stack grid, spec block, product, collage, JEDUF, dark, timeline, stat grid, quote pair, logo grid, code, closing, testimonial grid, logo bar, feature cards, update row, art overlay, **bar chart**, **flow row**, **diagram**). **Read this before writing slides.** Copy HTML structures verbatim; change only text content.
- `reference/ACADEMIC_STORYTELLING.md` — paper-style structure for research talks at scientific conferences, invited workshops, and lab seminars (Motivation / Background / Method / Results / Discussion / Limitations / Conclusion). Plain, precise, evidence-led.
- `reference/CASUAL_STORYTELLING.md` — five-beat structure for internal team talks, casual meetups, demos for people you know (Hook / Context / The Thing / Caveats / Close). Allows light humour.
- `reference/CLIENT_PRESENTATIONS.md` — pitch and results-readout structures for client meetings: either pitching new work or reporting progress on work already paid for. Serious, non-technical, outcome-driven.

## Workflow

When the user asks for a deck:

1. **Ask which presentation type** (use `AskUserQuestion`). Recommend one based on what the user has said about the topic and audience — put that option first with "(recommended)" attached. Options:
   - **Academic / research** — scientific conferences, invited workshop talks, lab seminars, thesis defences. Audience is researchers. Uses `ACADEMIC_STORYTELLING.md`.
   - **Casual / internal** — internal talks at the user's workplace, casual meetups, demos for people they know. Laid-back tone. Uses `CASUAL_STORYTELLING.md`.
   - **Client** — client meetings for either pitching new work or updating on the progress of a project the client has already paid for. Uses `CLIENT_PRESENTATIONS.md`.
   - **Custom** — the user describes their own structure or none of the above fit. Fall back to the user's own framing; don't force a guide.

   Skip this step only if the user has already clearly indicated which one they want.
2. **Ask for the story** (one short message): topic, audience/context, rough length, and the closing line. Skip if the user has already given enough.
3. **Read the matching storytelling reference** for the chosen type before drafting. Read `reference/COMPONENTS.md` as well — copy patterns verbatim.
4. **Sketch the arc** using the structure from the chosen reference. State the beat plan back to the user in 5–10 lines before writing HTML.
5. **Ask which colour scheme to use** (use `AskUserQuestion`). Options:
   - **Standard (Craft)** — warm cream + burnt orange. Recommended unless the user signals otherwise.
   - **Alexandra Institute** — pick when the user mentions Alexandra Institute or signals it's for an Alexandra-affiliated audience.

   Skip if the user has already clearly indicated.
6. **Copy the template** to the target location as `deck.html` (default `./deck.html` in the user's cwd unless they specify). Use `cp template/deck.html <target>/deck.html` — the template's `<style>` and `<script>` blocks must remain intact.
7. **Edit the ⚙️ DECK SETTINGS block** at the top of `<body>` to set `colourScheme` (`"standard"` or `"alexandra-institute"`), `presentationTitle`, `speakerName`, `speakerTitle`, `presentationDate`, `contactUrl`, `speakerEmail`, and `darkLogo`/`whiteLogo` (set both to empty strings to hide the logo). Anything else is left as default.
8. **Edit the slides** inside `<div class="deck">`. The `<style>` and `<script>` blocks live at the **bottom** of the file so the slide content is front-and-centre when you open `deck.html`. Each slide is delimited by a clear `<!-- ===== Slide NN: NAME ===== -->` marker. Replace the placeholder `<section class="slide">` blocks with real content using the component patterns. First slide must keep `class="slide active"`.
9. **Iterate small.** One coherent change per turn. Show the user, get feedback.

## Hard rules (do not violate)

- **Headline pattern everywhere:** `<h1>Anchor <span class="dim">extension that fades</span></h1>`. Bold the keyword, dim the rest. **No trailing periods on headlines** — the weight contrast does the separation.
- **No em-dashes in body copy.** Use periods.
- **Stay on-token.** Only colours, fonts, weights, and spacing from the design tokens table in `reference/COMPONENTS.md`. Reference CSS variables (`var(--accent)`), not hex values. No new colours. No new fonts.
- **British English everywhere.** All slide copy, headlines, eyebrows, captions, and any prose written into the deck or these reference files uses British spelling: colour, organise, optimise, emphasise, specialise, favourite, grey, centre, behaviour, analyse, recognise, etc. CSS property names (`color`, `text-align: center`), HTML attributes, JS identifiers, and quoted source material stay as written.
- **Dark slides:** 2–3 per deck maximum. Reserved for pivot moments.
- **Dark callout (`.callout`):** one per deck maximum.
- **Never put `data-reveal` on the closing/thanks slide.** It's the final beat — let everything land at once so the speaker can stop talking and take questions.
- **Linear flows must use `.flow-row` (component 27), not `.diagram` (component 28).** `.flow-row` is flexbox-based and overlap is impossible. `.diagram` is for branching/converging/looping only. If the layout reads left-to-right with no branches, you must use `.flow-row` even when the user says "diagram".
- **Never use quote slides** (`.quote-slide`). Even if the user asks for one, use a regular eyebrow + headline + subtitle slide and treat the quote as the headline.
- **Headlines are statements, not questions** (exception: Q&A capability rows).
- **Specific numbers beat vague claims.** "7×" not "huge gains."
- **Pick one term per concept and stick with it.** Don't paraphrase the product.

## Freestyling new components

The 27 components are a library, not a ceiling. New layouts are fine when content demands them, but: stay on-token, use the bold/dim headline pattern, match existing border-radius (10px cards, 4px small), keep CSS in the existing `<style>` block grouped with a `/* --- Name --- */` comment, and only one novel layout per slide.

## Common user requests → component mapping

- "Add a quote slide" → **don't.** Quote slides are disabled. Use a regular eyebrow + headline + subtitle slide and treat the quote as the headline.
- "Make it dark" → add `.dark` to the `<section>`
- "Add a comparison" → component 4 (two-col) or component 13 (JEDUF)
- "Show the process" / "show a pipeline" / "input → output" → component 27 (flow-row). Flexbox layout, overlap impossible. Use this for **anything that's a left-to-right sequence of boxes**, even when the user says "diagram".
- "Show an architecture" / "diagram with arrows" → only reach for component 28 (`.diagram`) if the topology genuinely branches, fans out/in, or has a feedback loop. If it's just boxes in a row, use 27 (flow-row).
- "Add a chart" / "show data" → component 26 (bar chart). Wrap in `.chart` for title/y-axis/legend; use `.bar-group` with `.s1`–`.s4` for grouped series
- "Add an image/video" → component 12 (collage-slide); place media in `./media/`
- "Add stats / metrics" → component 16 (stat-grid)
- "Closing slide / thanks" → component 20
- "Embed it" → user appends `?embed` to the URL; toast hint is suppressed, navigation stays
- "Export to PDF" / "save as PDF" / "make a PDF" → run `scripts/deck-to-pdf.mjs` (see "Exporting to PDF" below)
- "Add progressive reveal" → add `data-reveal` to eyebrow, headline, subtitle, and content blocks in order; see `COMPONENTS.md` "Progressive reveal" section

## Plots and diagrams

Users expect visualisations in slides. **Prefer the built-in pure-CSS/SVG components** over any external library — no CDN, no JS dependencies, plays nicely with `data-reveal` for step-by-step builds. See `reference/COMPONENTS.md` for full markup.

**Bar charts:** use component 26 (`.bar-chart` / `.hbar-chart`). Heights/widths are CSS variables (`--h: 70%`). Series colours via `.s1`–`.s4`. Wrap in `.chart` for title, y-axis label, and legend. Use `.bar-group` for grouped multi-series bars. Animates on reveal.

**Linear flow diagrams:** use component 27 (`.flow-row`). Boxes connected by accent arrows. Each node + each arrow can have its own `data-reveal` so the pipeline builds left to right.

**Branching / architecture diagrams:** use component 28 (`.diagram`) **only** when the topology actually branches, converges, or loops — never for a left-to-right sequence. Absolutely-positioned `.diagram-node` divs over inline SVG arrow layers with arrowhead `<marker>` defs. **Critical rules:** viewBox must mirror the container's aspect ratio (so units are uniform and markers don't go pointy); never set `preserveAspectRatio="none"`; one `<svg>` per arrow, interleaved with the node divs in DOM order; never put `data-reveal` on the `.diagram` wrapper itself. See `reference/COMPONENTS.md` § 28 for the conversion table and worked examples.

**Pie / scatter / line charts:** these are NOT covered by the built-in components. Use Chart.js via CDN as a last resort. Always defer chart creation with `setTimeout(fn, N)` so the DOM is rendered first, and style with deck colours from the design tokens table in `reference/COMPONENTS.md` (reference the CSS variables: `var(--accent)`, `var(--text)`, etc.).

**Key rules:**
- If real data exists on disk (CSV, JSON, model outputs), load it. Otherwise use illustrative numbers — be honest about it.
- Keep text minimal. Users will complain about slides that are walls of text.
- Reach for the CSS/SVG components first; only fall back to Chart.js when the chart type genuinely isn't supported.

## Exporting to PDF

When the user asks to export, save, or convert a deck to PDF, run the bundled script:

```bash
node ~/.claude/skills/slides/scripts/deck-to-pdf.mjs <path-to-deck.html> [output.pdf]
```

- Output defaults to `<parent-dir>.pdf` when the input is `…/<dir>/deck.html` or `…/<dir>/index.html`, otherwise `<basename>.pdf`, written to the current working directory.
- The script produces a **stepped PDF**: each slide expands into N+1 pages (initial state + one page per `data-reveal`), matching the live keypress sequence the speaker walks through.
- Page size is 13.333 × 7.5 in (16:9) with no margins. Box-shadows, text-shadows, and CSS filters are suppressed in the export because they render as muddy grey blocks in print rasterization.
- The final PDF is losslessly deduplicated (`mutool clean`) and linearized for snappy viewer load (`qpdf --linearize`).

**Dependencies — the script self-bootstraps:**

- Playwright + Chromium: auto-installed into the script's own folder on first run (~300 MB), with a yes/no confirmation prompt.
- `qpdf` and `mutool` (mupdf-tools): auto-installed via Homebrew on macOS or apt on Debian/Ubuntu, with confirmation. On other platforms the script prints install instructions and exits.

The agent should invoke the script directly; do not modify `template/deck.html` to add a "Save as PDF" button or override the print dialog. Those approaches were tried and don't survive Firefox's `file://` canvas-taint rule.

## Known issues

**Margin collapsing between `h1` and `.subtitle`.** The template's `.slide-inner` lacks `overflow: hidden`, so sibling margins collapse (the browser picks the larger margin instead of adding them). This makes the gap between a heading and its subtitle too small. Fix: add `overflow: hidden` to `.slide-inner` in the `<style>` block. This is inherited from the template and affects all decks — always check it when writing.

## Colour scheme and logo

The template ships with the Craft theme as the default (warm cream + burnt orange, Inter + Fraunces). The ⚙️ DECK SETTINGS block at the top of `<body>` exposes two related knobs:

```js
const colourScheme = "standard";        // or "alexandra-institute"
const darkLogo  = "https://…Sort_DK.webp";   // dark logo, shown on light slides
const whiteLogo = "https://…Hvid_DK.webp";   // light logo, shown on dark slides
```

**`colourScheme`** controls the palette, fonts, and the "Alexandra Institute" affiliation suffix on the cover. Add more schemes by extending the `if (colourScheme === '…')` branch in the bottom `<script>` and matching the body class to a new `body.<name> { … }` CSS block.

**`darkLogo` / `whiteLogo`** are independent. Set both to non-empty URLs to show a logo fixed in the top-left of every slide; the JS auto-swaps between them based on whether the active slide is dark. Set both to empty strings to hide the logo entirely. This works regardless of which colour scheme is active.
