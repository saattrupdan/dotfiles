---
name: slides
description: What — the noskillish/slides framework for building single-file HTML decks (no build step, 25+ ready components, PDF export, embed mode). Use when the user asks to create, draft, extend, or restyle a slideshow, presentation, or deck — e.g. "create a slideshow about X", "make a deck on Y", "add a quote slide", "turn these notes into slides".
last-updated: 2026-05-12
---

## What this skill does

Produces a single self-contained `deck.html` file in the user's chosen directory using the noskillish/slides framework. No build step, no dependencies beyond Google Fonts (Inter). Navigate with arrow keys / space / swipe; export to PDF with `P`; embed with `?embed`.

## Bundled assets

This skill ships with everything you need — do not fetch from the internet:

- `template/deck.html` — the deck template. Minimalist editorial: warm off-white (`#f5f5f3`) base, Inter, bold-anchor/dim-extension headlines. All 25 components in `COMPONENTS.md` map to this file.
- `reference/COMPONENTS.md` — the full component library (25 components: cover, quote, two-column, three-column, capability list, dark callout, dot flow, stack grid, spec block, product, collage, JEDUF, dark, timeline, stat grid, quote pair, logo grid, code, closing, testimonial grid, logo bar, feature cards, update row, art overlay). **Read this before writing slides.** Copy HTML structures verbatim; change only text content.
- `reference/DESIGN.md` — design tokens (colors, type scale, spacing). Stay strictly on-token.
- `reference/TED_TALK_STORYTELLING.md` — six-beat structure for conference-style talks (Open / World Before / The Turn / Evidence / Honest Part / Close).
- `reference/CASUAL_STORYTELLING.md` — five-beat structure for informal/internal presentations (Hook / Context / The Thing / Caveats / Close). Allows light humour.
- `reference/CLIENT_PRESENTATIONS.md` — pitch and results-readout structures for paying or prospective clients. Serious, non-technical, outcome-driven.
- `reference/ACADEMIC_STORYTELLING.md` — paper-style structure for research talks (Motivation / Background / Method / Results / Discussion / Limitations / Conclusion). Plain, precise, evidence-led.

## Workflow

When the user asks for a deck:

1. **Ask which presentation type** (use `AskUserQuestion`). Recommend one based on what the user has said about the topic and audience — put that option first with "(recommended)" attached. Options:
   - **TED-style talk** — conference talks, keynotes, public-facing storytelling. Uses `TED_TALK_STORYTELLING.md`.
   - **Casual / internal** — team updates, lunch-and-learns, demos for people you know. Uses `CASUAL_STORYTELLING.md`.
   - **Client presentation** — pitches, sales decks, results readouts for paying clients. Uses `CLIENT_PRESENTATIONS.md`.
   - **Academic / research** — conference papers, thesis defences, lab seminars. Uses `ACADEMIC_STORYTELLING.md`.
   - **Custom** — the user describes their own structure or none of the above fit. Fall back to the user's own framing; don't force a guide.

   Skip this step only if the user has already clearly indicated which one they want.
2. **Ask for the story** (one short message): topic, audience/context, rough length, and the closing line. Skip if the user has already given enough.
3. **Read the matching storytelling reference** for the chosen type before drafting. Read `reference/COMPONENTS.md` as well — copy patterns verbatim.
4. **Sketch the arc** using the structure from the chosen reference. State the beat plan back to the user in 5–10 lines before writing HTML.
5. **Copy the template** to the target location as `deck.html` (default `./deck.html` in the user's cwd unless they specify). Use `cp template/deck.html <target>/deck.html` — the template's `<style>` and `<script>` blocks must remain intact.
6. **Edit the slides** inside `<div class="deck">`. Replace the placeholder `<section class="slide">` blocks with real content using the component patterns. First slide must keep `class="slide active"`.
7. **Iterate small.** One coherent change per turn. Show the user, get feedback.

## Hard rules (do not violate)

- **Headline pattern everywhere:** `<h1>Anchor. <span class="dim">Extension that fades.</span></h1>`. Bold the keyword, dim the rest.
- **No em-dashes in body copy.** Use periods.
- **Stay on-token.** Only colors, fonts, weights, and spacing from `reference/DESIGN.md`. No new colors. No new fonts.
- **Dark slides:** 2–3 per deck maximum. Reserved for pivot moments.
- **Dark callout (`.callout`):** one per deck maximum.
- **Headlines are statements, not questions** (exception: Q&A capability rows).
- **Specific numbers beat vague claims.** "7×" not "huge gains."
- **Pick one term per concept and stick with it.** Don't paraphrase the product.

## Freestyling new components

The 25 components are a library, not a ceiling. New layouts are fine when content demands them, but: stay on-token, use the bold/dim headline pattern, match existing border-radius (10px cards, 4px small), keep CSS in the existing `<style>` block grouped with a `/* --- Name --- */` comment, and only one novel layout per slide.

## Common user requests → component mapping

- "Add a quote slide" → component 2 (quote-slide)
- "Make it dark" → add `.dark` to the `<section>`
- "Add a comparison" → component 4 (two-col) or component 13 (JEDUF)
- "Show the process" → component 8 (dot-flow) or component 10 (spec-flow)
- "Add an image/video" → component 12 (collage-slide); place media in `./media/`
- "Add stats / metrics" → component 16 (stat-grid)
- "Closing slide / thanks" → component 20
- "Embed it" → user appends `?embed` to the URL; PDF button hides, navigation stays

## Plots and diagrams

Users expect visualisations in slides. Prefer inline over external files — a self-contained deck should not need `media/` images.

**Bar/pie/scatter charts:** Use Chart.js via CDN. Import once in `<head>`, then create a `<canvas>` per chart. Style with deck colours from `reference/DESIGN.md`.

```html
<head>
  <link href="https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.css" rel="stylesheet">
  <!-- ... -->
</head>
<!-- Slide content -->
<div class="chart-container" style="max-width:500px;margin:1rem auto;">
  <canvas id="myChart"></canvas>
</div>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js"></script>
<script>
  setTimeout(() => {
    new Chart(document.getElementById('myChart'), {
      type: 'bar',
      data: { labels: ['A','B'], datasets: [{ data: [1.42, 1.09], backgroundColor: ['#1a1a1a','#b5b5b0'] }] },
      options: { plugins: { legend: { display: false } } },
    });
  }, 100);
</script>
```

**Flow diagrams / architecture:** Use vanilla Canvas (no library). Draw shapes with `ctx.rect`, `ctx.arc`, `ctx.moveTo`+`ctx.lineTo`. Scale with `ctx.scale(2,2)` for crisp rendering. Avoid `roundRect` — it's not supported in Safari. Use `quadraticCurveTo` for rounded corners instead.

```js
const ctx = canvas.getContext('2d');
ctx.scale(2, 2);
const r = 8;
ctx.fillStyle = '#1a1a1a';
ctx.beginPath();
ctx.moveTo(x + r, y);
ctx.lineTo(x + w - r, y);
ctx.quadraticCurveTo(x + w, y, x + w, y + r);
ctx.lineTo(x + w, y + h - r);
ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
ctx.lineTo(x + r, y + h);
ctx.quadraticCurveTo(x, y + h, x, y + h - r);
ctx.lineTo(x, y + r);
ctx.quadraticCurveTo(x, y, x + r, y);
ctx.closePath();
ctx.fill();
```

**Key rules:**
- Always defer chart creation with `setTimeout(fn, N)` so the DOM is rendered first.
- If real data exists on disk (CSV, JSON, model outputs), load it. Otherwise use illustrative numbers — be honest about it.
- Keep text minimal. Users will complain about slides that are walls of text.

## Known issues

**Margin collapsing between `h1` and `.subtitle`.** The template's `.slide-inner` lacks `overflow: hidden`, so sibling margins collapse (the browser picks the larger margin instead of adding them). This makes the gap between a heading and its subtitle too small. Fix: add `overflow: hidden` to `.slide-inner` in the `<style>` block. This is inherited from the template and affects all decks — always check it when writing.
