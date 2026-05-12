# Slides — Agent Instructions

You are helping a human build a slide deck using the Slides framework. This file is everything you need to produce correct, on-brand slides.

## What this is

A minimalist HTML slide deck framework. One self-contained HTML file (`deck.html`), no build step, no dependencies beyond Google Fonts (Inter). Navigate with arrow keys, space, swipe, or on-screen buttons. Export to PDF with `P`.

## File structure

```
your-deck/
├── deck.html              ← the deck (edit this)
├── docs/
│   ├── USING.md           ← usage guide
│   ├── STORYTELLING.md    ← talk structure and tone
│   └── DESIGN.md          ← visual tokens and rules
├── media/                 ← images and videos
└── AGENTS.md              ← this file
```

---

## How slides work

Each slide is a `<section class="slide">` inside the `.deck` div. The first slide gets the class `active`. The JS handles navigation, counter, and progress bar automatically. Just add or remove `<section>` blocks.

```html
<section class="slide">
  <div class="slide-inner">
    <!-- content here -->
  </div>
</section>
```

Dark slides add the `.dark` class to `<section>`:

```html
<section class="slide dark">
```

---

## The headline pattern (use everywhere)

Bold anchor + dim extension. This is the visual identity of the system.

```html
<h1>Anchor. <span class="dim">Extension that fades.</span></h1>
```

- First phrase: weight 500, full color
- Second phrase: weight 300, color `#b5b5b0` (or `#888` on dark slides)
- Use on every headline that has the room

---

## Design tokens

### Colors

| Token              | Hex       | Use                              |
|--------------------|-----------|----------------------------------|
| Background         | `#f5f5f3` | Page/slide background            |
| Surface            | `#fafaf8` | Card backgrounds                 |
| Surface (white)    | `#ffffff` | Cards that need more contrast    |
| Ink / Hero         | `#1a1a1a` | Text primary, dark slides        |
| Border soft        | `#e0e0db` | Default borders                  |
| Border medium      | `#d5d5d0` | Emphasized borders               |
| Pill background    | `#eeeee9` | Context pills                    |
| Text dim           | `#a0a09a` | Subtitles, body copy             |
| Text very dim      | `#b5b5b0` | Dim spans in headlines, meta     |
| Text faint         | `#c5c5c0` | Labels, very low priority text   |
| On-dark text       | `#f5f5f3` | Primary text on dark backgrounds |
| On-dark dim        | `#ccc`    | Body text on dark backgrounds    |
| On-dark very dim   | `#888`    | Labels on dark backgrounds       |

### Typography

- **Font:** Inter (weights 300, 400, 500, 600)
- **H1 display:** `clamp(2.5rem, 6vw, 5rem)`, weight 500, tracking `-0.035em`
- **H2 section:** `clamp(1.75rem, 3.5vw, 2.6rem)`, weight 500, tracking `-0.025em`
- **H3 column:** ~1rem, weight 500
- **Body/subtitle:** 0.85–1rem, weight 400, line-height 1.5–1.6
- **Eyebrow:** 0.65–0.75rem, uppercase, weight 500, tracking `0.08–0.1em`, color `#a0a09a`

### Spacing

- Slide padding: `6vh 8vw`
- Max content width: `1100px`
- Card padding: `1rem–1.5rem`
- Border radius: `10px` cards, `4px` small elements
- Section gaps: `2–4rem`

---

## Component reference

Use these exact patterns. Copy the HTML structure. Change only the text content.

### 1. Cover slide

```html
<section class="slide active">
  <div class="slide-inner">
    <div class="eyebrow">Conference · Date</div>
    <h1>Your headline.<br><span class="dim">Continuation.</span></h1>
    <div class="meta">Speaker name · 20 minutes</div>
  </div>
</section>
```

### 2. Quote slide

A single bold statement. No subtitle. No supporting text.

```html
<section class="slide quote-slide">
  <div class="slide-inner">
    <h1>A bold statement <span class="dim">that opens the talk.</span></h1>
  </div>
</section>
```

For a dark quote (closing slide, mic-drop):

```html
<section class="slide dark quote-slide">
```

### 3. Eyebrow + Headline + Subtitle

The default text slide.

```html
<section class="slide">
  <div class="slide-inner">
    <div class="eyebrow">Section label</div>
    <h1>Headline. <span class="dim">One line that lands.</span></h1>
    <p class="subtitle">One or two sentences of nuance. Keep it short.</p>
  </div>
</section>
```

### 4. Two-column (problem / fix)

```html
<section class="slide">
  <div class="slide-inner">
    <div class="two-col">
      <div>
        <div class="eyebrow">The problem</div>
        <h2>What's broken.</h2>
        <p>Description of the pain.</p>
      </div>
      <div>
        <div class="eyebrow">The fix</div>
        <h2>What we built.</h2>
        <p>Description of the solution.</p>
      </div>
    </div>
  </div>
</section>
```

### 4b. Two-column with step stack

Steps with optional `.dim` (blocker), `.kill` (negative outcome), `.live` (positive outcome):

```html
<div class="col-stack">
  <div class="step">First step</div>
  <div class="step">Second step</div>
  <div class="step dim">Blocked step</div>
  <div class="step kill">Negative outcome</div>
  <div class="step live">Positive outcome</div>
</div>
```

### 5. Three-column

```html
<div class="three-col" style="margin-top: 2rem;">
  <div><h3>Why</h3><p>The motivation.</p></div>
  <div><h3>How</h3><p>The mechanism.</p></div>
  <div><h3>What</h3><p>The outcome.</p></div>
</div>
```

### 6. Capability list (Q&A rows)

```html
<div class="cap-list" style="margin-top: 2rem;">
  <div class="cap-row">
    <div class="cap-q">Question?</div>
    <div class="cap-a">Clear, specific answer.</div>
  </div>
</div>
```

### 7. Dark callout

**One per deck max.** More than one and the emphasis stops working.

```html
<div class="callout">
  <h3>Why now</h3>
  <p>The moment. <strong>Key insight in bold.</strong> Then context.</p>
</div>
```

### 8. Dot flow (process)

```html
<div class="dot-flow">
  <div class="dot-step"><div class="dot"></div><h4>Step 1</h4><p>Caption</p></div>
  <div class="dot-step"><div class="dot"></div><h4>Step 2</h4><p>Caption</p></div>
  <!-- up to 5 steps -->
</div>
```

### 9. Stack grid

```html
<div class="stack-grid">
  <div class="stack-card">
    <div class="stack-card-label">Category</div>
    <div class="stack-tool"><span class="mark"></span>Tool name</div>
  </div>
  <!-- 4 cards total -->
</div>
```

### 10. Spec block + context + outputs

```html
<div class="spec-flow">
  <div class="spec-block"><h4>The Input</h4><p>What goes in</p></div>
  <div class="ctx-row">
    <span class="ctx-label">draws from</span>
    <span class="ctx-pill">Source 1</span>
    <span class="ctx-pill">Source 2</span>
  </div>
  <div class="ai-divider">
    <div class="line"></div>
    <span class="ai-pill">Process</span>
    <div class="line"></div>
  </div>
  <div class="outputs-row">
    <div class="output-card"><h5>Output A</h5><p>What it produces.</p></div>
    <div class="output-card"><h5>Output B</h5><p>What it produces.</p></div>
    <div class="output-card"><h5>Output C</h5><p>What it produces.</p></div>
  </div>
</div>
```

### 11. Product slide (showcase)

```html
<div class="product-row">
  <div class="product-meta">
    <div class="product-num">/01</div>
    <div class="product-tag">A short, punchy hook.</div>
    <h3 class="product-headline">One-line description.</h3>
    <p class="product-desc">Two or three sentences. Personal and concrete.</p>
    <div class="product-stat">Build time or metric</div>
  </div>
  <div class="product-name">Name<sup>™</sup></div>
</div>
```

### 12. Collage slide (full media)

```html
<section class="slide collage-slide">
  <div class="collage">
    <img src="media/your-image.png" alt="">
    <!-- or: <video src="media/your-video.mp4" controls loop playsinline></video> -->
  </div>
</section>
```

Use after a product slide for maximum impact. No text overlay.

### 13. JEDUF three-column comparison

Two extremes flanking a dark hero (the middle path):

```html
<div class="jeduf">
  <div class="jeduf-col">
    <div class="jeduf-label">Too much</div>
    <div class="jeduf-title">Extreme A</div>
    <div class="jeduf-philosophy">"Philosophy quote."</div>
    <div class="jeduf-step">Step 1</div>
  </div>
  <div class="jeduf-col hero">
    <div class="jeduf-label">Just right</div>
    <div class="jeduf-title">The middle path</div>
    <div class="jeduf-philosophy">"Balanced philosophy."</div>
    <div class="jeduf-step">Step 1</div>
  </div>
  <div class="jeduf-col">
    <div class="jeduf-label">Too little</div>
    <div class="jeduf-title">Extreme B</div>
    <div class="jeduf-philosophy">"Other extreme."</div>
    <div class="jeduf-step">Step 1</div>
  </div>
</div>
```

### 14. Dark slide

```html
<section class="slide dark">
  <div class="slide-inner">
    <div class="eyebrow">Section label</div>
    <h1>The pivot moment. <span class="dim">Lands harder in dark.</span></h1>
    <p class="subtitle">Use sparingly. Two or three per deck max.</p>
  </div>
</section>
```

### 15. Timeline

Vertical timeline with year/label on the left, connecting dots, content on the right.

```html
<div class="timeline">
  <div class="timeline-row">
    <div class="timeline-year">Year 1</div>
    <div class="timeline-track"><div class="timeline-dot"></div><div class="timeline-line"></div></div>
    <div class="timeline-content"><h4>Title</h4><p>Description of this period.</p></div>
  </div>
  <!-- add more rows; the line hides on the last row automatically -->
</div>
```

### 16. Stat grid

Big numbers with context. Use `.stat-dark` on one card to highlight the hero metric.

```html
<div class="stat-grid">
  <div class="stat-card">
    <div class="stat-label">Metric</div>
    <div class="stat-number">7×</div>
    <div class="stat-desc">What this number means.</div>
  </div>
  <div class="stat-card stat-dark">
    <div class="stat-label">Hero metric</div>
    <div class="stat-number">42</div>
    <div class="stat-desc">The key number, highlighted.</div>
  </div>
  <div class="stat-card">
    <div class="stat-label">Metric</div>
    <div class="stat-number">91%</div>
    <div class="stat-desc">Another measurement with context.</div>
  </div>
</div>
```

### 17. Quote pair

Two perspectives side by side. One light, one dark.

```html
<div class="quote-pair">
  <div class="quote-card">
    <div class="quote-text">"The first perspective."</div>
    <div class="quote-attr">Speaker or label</div>
  </div>
  <div class="quote-card quote-dark">
    <div class="quote-text">"The counterpoint."</div>
    <div class="quote-attr">Speaker or label</div>
  </div>
</div>
```

### 18. Logo grid

Four-column grid for partners, clients, or team members. Swap `.logo-mark` div for `<img>` with real logos.

```html
<div class="logo-grid">
  <div class="logo-cell">
    <div class="logo-mark"></div>
    <div class="logo-name">Partner name</div>
    <div class="logo-role">Role or team</div>
  </div>
  <!-- repeat for each partner -->
</div>
```

### 19. Code slide

Dark code block with macOS-style header. Use `.code-comment`, `.code-keyword`, `.code-string`, `.code-dim` for syntax highlighting.

```html
<div class="code-frame">
  <div class="code-frame-header">
    <div class="code-frame-dot"></div>
    <div class="code-frame-dot"></div>
    <div class="code-frame-dot"></div>
    <div class="code-frame-title">filename.ext</div>
  </div>
  <pre><span class="code-comment">// comment</span>
<span class="code-keyword">function</span> <span class="code-string">example</span>() {}</pre>
</div>
```

### 20. Closing / Thanks

```html
<section class="slide">
  <div class="slide-inner">
    <h1 style="font-size: clamp(2.5rem, 5vw, 4rem);">Thanks.</h1>
    <p class="subtitle">Questions?</p>
    <div class="meta">Speaker name · Affiliation</div>
  </div>
</section>
```

### 21. Testimonial grid

3×2 grid of quote cards with avatar, name, and title. For social proof.

```html
<div class="testimonial-grid">
  <div class="testimonial-card">
    <div class="testimonial-quote">"Quote text here."</div>
    <div class="testimonial-author">
      <div class="testimonial-avatar"></div>
      <div>
        <div class="testimonial-name">Name</div>
        <div class="testimonial-title">Role, Company</div>
      </div>
    </div>
  </div>
  <!-- repeat for each testimonial, up to 6 -->
</div>
```

### 22. Logo bar

Horizontal row of partner/client names between hairline borders. Compact social proof.

```html
<div class="logo-bar">
  <div class="logo-bar-item">Partner A</div>
  <div class="logo-bar-item">Partner B</div>
  <div class="logo-bar-item">Partner C</div>
</div>
```

### 23. Feature card row

Three cards with title, description, and inner mock element. For feature breakdowns.

```html
<div class="feature-cards">
  <div class="feature-card">
    <div>
      <div class="feature-card-title">Feature name</div>
      <div class="feature-card-desc">Short description of what this feature does.</div>
    </div>
    <div class="feature-card-inner">
      <!-- mock UI lines or content -->
    </div>
  </div>
  <!-- repeat for 3 cards -->
</div>
```

### 24. Update row (changelog)

Four changelog cards with version badges and dates. For shipping cadence slides.

```html
<div class="update-row">
  <div class="update-card">
    <div class="update-header">
      <span class="update-badge">3.3</span>
      <span class="update-date">May 7, 2026</span>
    </div>
    <div class="update-title">Feature or fix description</div>
  </div>
  <!-- repeat for each update -->
</div>
```

### 25. Art overlay

Classical painting background with UI mockup floating on top. The "craft meets code" visual. Swap the gradient for a real painting via `background-image` on `.art-overlay-bg`.

```html
<div class="art-overlay">
  <div class="art-overlay-bg"></div>
  <div class="art-overlay-ui">
    <div class="art-overlay-titlebar">
      <div class="art-overlay-dot"></div>
      <div class="art-overlay-dot"></div>
      <div class="art-overlay-dot"></div>
    </div>
    <div class="art-overlay-content">
      <!-- sidebar + main mock content -->
    </div>
  </div>
  <div class="art-overlay-caption">
    <h3>Caption title</h3>
    <p>Caption description.</p>
  </div>
</div>
```

---

## Storytelling structure

Every presentation follows six beats. The timing scales to your format.

| Beat | ~Share | Purpose |
|------|--------|---------|
| Open | 10% | Hook the room. A confession, a contradiction, a surprising fact. Not your bio. |
| Act 1 — The World Before | 15% | The status quo. The old way. Build empathy. |
| Act 2 — The Turn | 15% | Something changed. State it cleanly. |
| Act 3 — The Evidence | 40% | 3–5 concrete examples. Before → action → after. |
| Act 4 — The Honest Part | 15% | Doubt, risk, what you're still figuring out. |
| Close | 5% | The closing line. Slow down. Stop talking. |

### Show, don't tell

When you have a story to tell, use the **setup slide → evidence slide** pair. Text first (product slide, stat grid, or any text component), then full-bleed image/video (collage slide). The visual punch lands harder after the setup.

### Punctuation slides

- **Quote slides:** Bold statement, no other text. Use to open, close, and mark turning points.
- **Dark slides:** Reserved for moments that matter. 2–3 per deck max.
- **Breakers:** A quiet line between acts. *"That felt normal. Until it wasn't."*

---

## Embed mode

Adding `?embed` to the deck URL produces an embeddable version. The PDF button hides; navigation stays. Use this when the human wants to share a deck inside another page.

```html
<iframe src="deck.html?embed" style="width:100%; aspect-ratio:16/9; border:none;"></iframe>
```

---

## Tone rules (follow strictly)

1. **Bold the keyword. Dim the rest.** Every headline.
2. **No em-dashes in body copy.** Use periods or shorter sentences.
3. **No fluff.** If a sentence doesn't add information, delete it.
4. **Specific numbers.** "7×" beats "huge gains." "35 use cases/week" beats "much faster."
5. **Headlines are statements, not questions.** Exception: Q&A rows.
6. **Use names, not pronouns.** Say the product/feature name, not "it."
7. **Pick one term and stick with it.** Don't paraphrase your own product.

---

## Common mistakes to avoid

- **Too many dark slides.** Emphasis needs contrast. 2–3 max.
- **More than one callout.** The dark callout block is a one-per-deck component.
- **Index as key.** Don't number slides manually in content. The nav counter handles it.
- **Reading the slide.** The slide is the punchline. The speaker is the setup.
- **Overstuffing Act 3.** Three solid build stories beat ten thin ones.
- **Skipping Act 4 (the honest part).** This is where the audience trusts you.

---

## Freestyle: creating new components

The 25 components above are the standard library, not a ceiling. You are encouraged to invent new slide layouts when the content demands it. Follow these rules when freestyling:

1. **Stay on-token.** Use only the colors, fonts, weights, and spacing from the design tokens table. No new colors, no new fonts.
2. **Use the headline pattern.** Any new layout with a headline should use bold-then-dim (`<span class="dim">`).
3. **Match existing craft.** Study how the existing components handle border radius (10px cards, 4px small elements), padding (1–1.5rem internal), and text hierarchy (eyebrow → headline → body).
4. **Name the class.** Give your new component a descriptive class name that fits the existing naming style (lowercase, hyphenated: `timeline-row`, `stat-grid`, `quote-pair`).
5. **Keep the CSS inline** in the `<style>` block at the top of `deck.html`, grouped with a comment like `/* --- Timeline --- */`.
6. **One new idea per slide.** Don't combine two novel layouts on the same slide. Pair a new component with familiar elements (eyebrow, subtitle) so it feels native.

Examples of good freestyle components:
- A **timeline** with years on the left and events on the right
- A **big number + caption** stat card for impact slides
- A **side-by-side quote** comparing two speakers or perspectives
- A **logo grid** for partner/client slides
- A **code block** slide for technical talks

If it looks like it belongs next to the existing components, it's a good freestyle. If it needs a new color or a different font to work, rethink it.

---

## When the human asks you to build a deck

1. **Ask for the story first.** What's the talk about? What's the arc? What's the closing line?
2. **Draft the structure** using the six-beat model above.
3. **Pick components** from the reference. Match component to content type.
4. **Write the HTML** using exact class names from this file.
5. **Iterate small.** One change at a time. Show the change, get feedback.

When the human says things like:
- "Add a quote slide" → use component 2
- "Make it dark" → add `.dark` to the `<section>`
- "Add a comparison" → use component 4 (two-column) or 13 (JEDUF)
- "Show the process" → use component 8 (dot flow) or 10 (spec block)
- "Add an image" → use component 12 (collage slide), reference `media/`
- "Shorten the headline" → keep the bold-then-dim pattern, just use fewer words
