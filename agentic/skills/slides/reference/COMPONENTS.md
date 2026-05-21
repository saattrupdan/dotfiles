# Slides — Agent Instructions

You are helping a human build a slide deck using the Slides framework. This file is everything you need to produce correct, on-brand slides.

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
<h1>Anchor <span class="dim">extension that fades</span></h1>
```

- First phrase: weight 500, full colour
- Second phrase: weight 300, colour `#b5b5b0` (or `#888` on dark slides)
- **No trailing periods.** The weight contrast handles the separation; periods read as preachy.
- Use on every headline that has the room

---

## Design tokens

All tokens are CSS variables on `:root` in `template/deck.html`. **Reference them through the variables (`var(--accent)`) rather than hard-coding hex values** so the Alexandra brand toggle works automatically.

### Colours — default (Craft)

| Variable             | Value                          | Use                                              |
|----------------------|--------------------------------|--------------------------------------------------|
| `--bg`               | `#f5f0e8`                      | Page/slide background (warm cream)               |
| `--bg-card`          | `#ffffff`                      | Standard card surface                            |
| `--bg-card-warm`     | `#faf6ef`                      | Inset card surface (e.g. feature-card-inner)     |
| `--bg-dark`          | `#161310`                      | Dark slide background                            |
| `--bg-dark-warm`     | `#1f1a15`                      | Gradient companion to `--bg-dark`                |
| `--text`             | `#1a1a1a`                      | Primary text                                     |
| `--text-light`       | `#f5f0e8`                      | Primary text on dark backgrounds                 |
| `--text-secondary`   | `#6b6560`                      | Body copy, captions                              |
| `--text-muted`       | `#9a9490`                      | Labels, eyebrows, meta, dim spans                |
| `--text-faint`       | `#b5b0aa`                      | Very low-priority text                           |
| `--accent`           | `#c05a3a`                      | Burnt orange — CTAs, eyebrows, accent lines      |
| `--accent-hover`     | `#a84d30`                      | Hover state for accent elements                  |
| `--accent-soft`      | `rgba(192, 90, 58, 0.08)`      | Accent backgrounds and pills                     |
| `--accent-glow`      | `rgba(192, 90, 58, 0.25)`      | Accent shadows and glows                         |
| `--border`           | `#e5e0d8`                      | Default card borders                             |
| `--border-strong`    | `#d5d0c8`                      | Emphasised borders, dividers                     |

### Colours — Alexandra brand (when `colourScheme = "alexandra-institute"`)

The flag swaps these variables under `body.alexandra`. Same names, brand values:

| Variable             | Value                          |
|----------------------|--------------------------------|
| `--bg`               | `#ffffff`                      |
| `--bg-card`          | `#f9f9f9`                      |
| `--bg-dark`          | `#002a3f` (deep teal)          |
| `--bg-dark-warm`     | `#16475e`                      |
| `--text`             | `#0c0c0c`                      |
| `--text-secondary`   | `#353535`                      |
| `--text-muted`       | `#839fad`                      |
| `--text-faint`       | `#aabbc4`                      |
| `--accent`           | `#be5d2b` (burnt sienna)       |
| `--accent-hover`     | `#d17546`                      |
| `--border`           | `#ededed`                      |
| `--border-strong`    | `#aabbc4`                      |

### Typography

Two fonts, paired. Sans for body and UI; serif for display headlines, stat numbers, product names, and quoted text.

- **Default (Craft):** Inter (300, 400, 500, 600, 700) for body. Fraunces (variable, weights 300–500) for `--serif`.
- **Alexandra:** Montserrat (300–700) for body. Playfair Display (400–600) for `--serif`.

| Element            | Size                                | Weight | Family   | Notes                              |
|--------------------|-------------------------------------|--------|----------|------------------------------------|
| `h1` (display)     | `clamp(2.2rem, 5vw, 4.2rem)`        | 400    | serif    | tracking `-0.035em`, line 1.02     |
| `h2`               | `clamp(1.5rem, 3vw, 2.2rem)`        | 400    | serif    | tracking `-0.025em`, line 1.08     |
| `h3`               | `1.05rem`                           | 600    | sans     | tracking `-0.01em`                 |
| `.subtitle`        | `clamp(1.05rem, 1.5vw, 1.25rem)`    | 400    | sans     | color `--text-secondary`           |
| `.eyebrow`         | `0.78rem`                           | 500    | sans     | uppercase, tracking `0.14em`, accent-coloured, with leading hairline |
| `.stat-number`     | `clamp(2.8rem, 5.5vw, 4.2rem)`      | 400    | serif    | tracking `-0.04em`                 |
| `.meta`            | `0.85rem`                           | 500    | sans     | color `--text-muted`               |

### Spacing & radius

- Slide padding: `3.5vh 5vw`
- Max content width (`.slide-inner`): `1200px`
- Card padding: `1.1rem–1.6rem` (varies by component)
- `--radius`: `14px` (default cards)
- `--radius-sm`: `8px` (steps, buttons, mock chrome)
- `--radius-lg`: `20px` (art overlay)
- Section gaps within a slide: `1.5–2rem` typical

### Shadows

- `--shadow-sm`: subtle card lift
- `--shadow-md`: hover state, hero cards
- `--shadow-lg`: floating UI mocks, JEDUF hero column

---

## Component reference

Use these exact patterns. Copy the HTML structure. Change only the text content.

### 1. Cover slide

```html
<section class="slide active">
  <div class="slide-inner">
    <div class="eyebrow">Conference · Date</div>
    <h1>Your headline<br><span class="dim">Continuation</span></h1>
    <div class="meta">Speaker name · 20 minutes</div>
  </div>
</section>
```

### 3. Eyebrow + Headline + Subtitle

The default text slide.

```html
<section class="slide">
  <div class="slide-inner">
    <div class="eyebrow">Section label</div>
    <h1>Headline <span class="dim">One line that lands</span></h1>
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
        <h2>What's broken</h2>
        <p>Description of the pain.</p>
      </div>
      <div>
        <div class="eyebrow">The fix</div>
        <h2>What we built</h2>
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
    <h1>The pivot moment <span class="dim">Lands harder in dark</span></h1>
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
    <h1 style="font-size: clamp(2.5rem, 5vw, 4rem);">Thanks</h1>
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

### 26. Bar chart

Pure-CSS bar chart. No external libraries. Vertical or horizontal variants, with optional title, y-axis label, legend, and grouped (multi-series) bars.

**Series colours:** `.s1` (accent orange), `.s2` (sage), `.s3` (slate blue), `.s4` (warm grey). `.hero` is an alias for `.s1` on vertical bars. Add to any `.bar` or `.hbar-fill`.

**Animation:** Wrap the chart (or any ancestor) in `data-reveal`. Bars grow from zero when revealed, and values fade in. Without `data-reveal`, bars render at full size immediately.

#### Vertical bars (basic)

Set bar height with `--h` (CSS variable, 0–100%):

```html
<div class="bar-chart">
  <div class="bar-col">
    <div class="bar" style="--h: 38%"><span class="bar-value">21%</span></div>
    <div class="bar-label">Q2</div>
  </div>
  <div class="bar-col">
    <div class="bar hero" style="--h: 92%"><span class="bar-value">52%</span></div>
    <div class="bar-label">Q4</div>
  </div>
</div>
```

#### Horizontal bars

Set fill width with `--w`:

```html
<div class="hbar-chart">
  <div class="hbar-row">
    <div class="hbar-label">CLI</div>
    <div class="hbar-track"><div class="hbar-fill hero" style="--w: 91%"></div></div>
    <div class="hbar-value">91%</div>
  </div>
  <div class="hbar-row">
    <div class="hbar-label">Web</div>
    <div class="hbar-track"><div class="hbar-fill" style="--w: 54%"></div></div>
    <div class="hbar-value">54%</div>
  </div>
</div>
```

#### Full-featured chart (title, y-axis label, legend, grouped bars)

Wrap in `.chart` to add title/subtitle/y-label/legend. Use `.bar-group` inside each `.bar-col` to nest multiple bars side-by-side (one per series). All four wrapper pieces are independently optional.

```html
<div class="chart">
  <div class="chart-title">Adoption rate by quarter and team</div>
  <div class="chart-subtitle">Optional one-line context.</div>
  <div class="chart-body">
    <div class="chart-y-label">Adoption (%)</div>
    <div class="bar-chart">
      <div class="bar-col">
        <div class="bar-group">
          <div class="bar s1" style="--h: 70%"><span class="bar-value">35</span></div>
          <div class="bar s2" style="--h: 58%"><span class="bar-value">29</span></div>
          <div class="bar s3" style="--h: 42%"><span class="bar-value">21</span></div>
        </div>
        <div class="bar-label">Q3</div>
      </div>
      <!-- more bar-cols -->
    </div>
  </div>
  <div class="chart-legend">
    <div class="legend-item"><span class="legend-swatch s1"></span>Platform</div>
    <div class="legend-item"><span class="legend-swatch s2"></span>Infrastructure</div>
    <div class="legend-item"><span class="legend-swatch s3"></span>Product</div>
  </div>
</div>
```

**When to use which:**
- Use the **basic** vertical/horizontal form when you have a single series. Highlight one bar with `.hero`.
- Use the **chart wrapper** when you need any of: a title, a y-axis label, multiple series, or a legend.
- Grouped bars (`.bar-group`) only make sense in vertical form. For horizontal multi-series, just stack more `.hbar-row` entries and colour them with `.s1`–`.s4`.

### 27. Flow row (linear process diagram)

Boxes connected by accent-coloured arrows, laid out horizontally. Use for input → process → output style flows. Add `data-reveal` to each `.flow-node` and `.flow-arrow` so the pipeline builds step by step.

Node variants: default (light card), `.hero` (dark card), `.accent` (burnt orange — use for the terminal/output node).

```html
<div class="flow-row">
  <div class="flow-node" data-reveal>
    <div class="flow-node-title">Ingest</div>
    <div class="flow-node-desc">Raw events</div>
  </div>
  <div class="flow-arrow" data-reveal></div>
  <div class="flow-node" data-reveal>
    <div class="flow-node-title">Normalize</div>
    <div class="flow-node-desc">Clean and dedupe</div>
  </div>
  <div class="flow-arrow" data-reveal></div>
  <div class="flow-node accent" data-reveal>
    <div class="flow-node-title">Publish</div>
    <div class="flow-node-desc">Downstream</div>
  </div>
</div>
```

### 28. Diagram (free-form, with arrows)

**For non-linear processes only**: branching, convergence, fan-out / fan-in, feedback loops. Anything that's just a left-to-right sequence of boxes ("input → process → output", "stage 1 → stage 2 → stage 3") is **not** a `.diagram` — it's a `.flow-row` (component 27). `.flow-row` uses flexbox so overlap is impossible by construction; `.diagram` requires hand-positioning, which is error-prone. If your diagram could be drawn as a horizontal line of boxes, you must use `.flow-row`.

When the topology genuinely branches: nodes are absolutely positioned `<div>`s; arrows are inline SVG paths in overlay `<svg>` elements.

Every node, arrow, and label can carry `data-reveal` for progressive build.

**Arrow classes:** default (accent orange, solid), `.muted` (grey), `.dashed` (dashed stroke — combine with `.muted` for "feedback" style lines).

**Node variants:** default, `.hero` (dark), `.accent` (burnt orange filled).

**Optional icon:** drop a `.diagram-node-icon` with an inline SVG above the title. Use `stroke="currentColor"`, `fill="none"`, `stroke-width="1.6"`, viewBox `0 0 24 24`. The icon inherits the accent colour by default (white on `.accent` nodes).

#### Authoring procedure — follow these steps in order

The failure modes that show up over and over:

1. **Used `.diagram` when the layout was linear.** Stop. Use `.flow-row` instead. Re-read the first paragraph of this section.
2. **Arrows reveal in one big batch before any node appears.** Caused by putting every path inside a single `<svg>` at the top of the diagram. Fix: one `<svg>` per arrow, interleaved between the node divs in DOM order.
3. **`data-reveal` on the `.diagram` wrapper itself.** That makes the entire diagram reveal as one step and breaks the per-node/per-arrow build. The wrapper must never carry `data-reveal` — only its children do.
4. **Pointy / stretched arrowheads.** Caused by `preserveAspectRatio="none"` on the arrow SVG, which stretches the marker triangle. Solution: **never set `preserveAspectRatio="none"` on `.diagram-arrows`.** Leave it at the default (`xMidYMid meet`) and use an aspect-matched viewBox (see Rule 0).
5. **Arrow tips land on top of (or under) the node card.** Caused by setting the arrow's end coordinate to the node's centre coordinate. The arrow must stop a card-half-width short.
6. **Coordinates don't line up.** Caused by picking a viewBox that doesn't match the container's aspect ratio, then thinking in percentages. See Rule 0.

**Rule 0 — Aspect-matched viewBox, no `preserveAspectRatio` override.**

`.diagram` defaults to `aspect-ratio: 2 / 1`. The viewBox **must mirror that aspect ratio** so each viewBox unit is a uniform square on screen — that's what keeps strokes and arrowheads from stretching. Use these conventions:

| Container `aspect-ratio` | `viewBox`         | x ranges over | y ranges over |
|--------------------------|-------------------|---------------|---------------|
| `1 / 1` (square)         | `0 0 100 100`     | 0–100         | 0–100         |
| `1.5 / 1`                | `0 0 150 100`     | 0–150         | 0–100         |
| `2 / 1` (default)        | `0 0 200 100`     | 0–200         | 0–100         |
| `2.2 / 1`                | `0 0 220 100`     | 0–220         | 0–100         |
| `2.5 / 1`                | `0 0 250 100`     | 0–250         | 0–100         |

Do **not** set `preserveAspectRatio` on `<svg class="diagram-arrows">`. The default (`xMidYMid meet`) is correct because the viewBox already matches the container aspect.

The trade-off is that viewBox coordinates are **not** percentages. Convert with the formulas below.

**Conversion formulas (memorise these).** Let `W` be the first number of the aspect ratio (so 2 for `2/1`, 2.5 for `2.5/1`). Then for any node centred at `left: L%`, `top: T%`:

```
viewBox x = L × W
viewBox y = T            (because the second number of the aspect ratio is always 1)
```

Examples for `W = 2.2`:
- Node at `left: 9%, top: 50%`  → viewBox (19.8, 50) ≈ (20, 50)
- Node at `left: 36%, top: 50%` → viewBox (79.2, 50) ≈ (79, 50)
- Node at `left: 92%, top: 50%` → viewBox (202.4, 50) ≈ (202, 50)

**Step 1 — Plan node positions in `left%`/`top%` first.** Build the grid in percentages where humans think:

| Node | left % | top % | Variant |
|------|--------|-------|---------|
| Source | 9 | 50 | default |
| Router | 36 | 50 | `.hero` |
| Worker A | 68 | 22 | default |
| Worker B | 68 | 78 | default |
| Sink | 92 | 50 | `.accent` |

Keep at least 20% horizontal separation and 25% vertical separation between neighbouring node centres. A `.diagram-node` is roughly 12–18% of the container wide (`min-width: 110px`, `max-width: 200px`), so half-width is ~9%.

**Step 2 — Compute arrow endpoints in viewBox units using the W-aware setback rule.** An arrow from A to B should stop ~10% (of container width) short of B's centre and start ~10% past A's centre. In viewBox units, that's `10 × W` units of x-setback and `10` units of y-setback. So for a 2.2/1 diagram (`W = 2.2`):
- Setback in x = 22 viewBox units (≈ 10% of width).
- Setback in y = 10 viewBox units (= 10% of height).

Example chain: Source (9%, 50%) → Router (36%, 50%) in a 2.2/1 diagram:
- Source centre in viewBox = (20, 50). Router centre = (79, 50).
- Arrow runs from (20 + 22, 50) = (42, 50) to (79 − 22, 50) = (57, 50)? Actually that's too short. Use a smaller setback when nodes are close: 16 viewBox units works (= ~7% of width). Path: `M 36 50 L 64 50`.

In practice, **eyeball the gap**: if neighbouring nodes' rendered cards are tight (long titles), bump the setback; if they're loose, reduce it. The browser is the source of truth.

For diagonal or curved arrows, apply the setback along the direction of travel. Cubic Bezier (`M x1 y1 C cx1 cy1, cx2 cy2, x2 y2`) is the right tool: place the control points roughly along the straight line between endpoints and nudge perpendicular to taste.

**Step 3 — Write the DOM in flow order.** Reveal order = DOM order. The file should read like the story:

```
<div class="diagram">                  ← NO data-reveal here, ever
  [marker defs svg]                    ← invisible, just <defs>
  [node A, data-reveal]                ← first thing the audience sees
  [arrow A→B svg, path data-reveal]    ← then the arrow draws
  [node B, data-reveal]                ← then B appears
  [arrow B→C svg, path data-reveal]
  [node C, data-reveal]
  [feedback arrow svg, data-reveal]    ← finally the loop closes
  [label, data-reveal]
</div>
```

Every arrow lives in its own `<svg class="diagram-arrows">`. They all use the same viewBox (from Rule 0) and share `position: absolute; inset: 0` (from the `.diagram-arrows` class), so they paint on the same coordinate space but reveal independently.

**Step 4 — Sanity-check before declaring done.** Open the deck in a browser and verify:
- Arrowheads are roughly equilateral triangles, not pointy slivers (if they're slivers, you set `preserveAspectRatio="none"` somewhere — find it and delete it).
- Every arrow tip touches the edge of its target node, not the centre and not empty space.
- No two nodes overlap.
- Pressing Space cycles node → arrow → node → arrow in narration order.
- The `.diagram` wrapper itself has no `data-reveal`.

```html
<div class="diagram-node hero" style="left: 36%; top: 50%;" data-reveal>
  <div class="diagram-node-icon">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
         stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="5" cy="12" r="2"/>
      <circle cx="19" cy="6" r="2"/>
      <circle cx="19" cy="18" r="2"/>
      <path d="M7 12l10-6"/>
      <path d="M7 12l10 6"/>
    </svg>
  </div>
  <div class="diagram-node-title">Router</div>
</div>
```

#### Reference markup

The marker defs sit in an invisible `<svg>` at the top. Every later arrow `<svg>` references them by id (`marker-end="url(#diagram-arrowhead)"` is wired up automatically by the `.diagram-arrow` CSS).

```html
<!-- aspect-ratio 2.2/1 → viewBox 0 0 220 100 (W = 2.2). NO preserveAspectRatio. -->
<div class="diagram" style="aspect-ratio: 2.2 / 1;">
  <!-- Shared marker defs (invisible) -->
  <svg class="diagram-arrows" viewBox="0 0 220 100" aria-hidden="true">
    <defs>
      <marker id="diagram-arrowhead" viewBox="0 0 10 10" refX="9" refY="5"
              markerWidth="5" markerHeight="5" orient="auto-start-reverse">
        <path d="M0,0 L10,5 L0,10 Z" fill="#c05a3a" />
      </marker>
      <marker id="diagram-arrowhead-muted" viewBox="0 0 10 10" refX="9" refY="5"
              markerWidth="5" markerHeight="5" orient="auto-start-reverse">
        <path d="M0,0 L10,5 L0,10 Z" fill="#d5d0c8" />
      </marker>
    </defs>
  </svg>

  <!-- 1. Source node (left: 9% → viewBox x = 9 × 2.2 ≈ 20) -->
  <div class="diagram-node" style="left: 9%; top: 50%;" data-reveal>
    <div class="diagram-node-title">Source</div>
  </div>

  <!-- 2. Source -> Router arrow. Source centre vbox x=20, Router x=79.
       Setback 16 vbox units (~7% of width) on each side. -->
  <svg class="diagram-arrows" viewBox="0 0 220 100">
    <path class="diagram-arrow" d="M 36 50 L 64 50"
          vector-effect="non-scaling-stroke" data-reveal />
  </svg>

  <!-- 3. Router node (left: 36% → viewBox x = 36 × 2.2 ≈ 79) -->
  <div class="diagram-node hero" style="left: 36%; top: 50%;" data-reveal>
    <div class="diagram-node-title">Router</div>
  </div>

  <!-- ...continue: arrow, node, arrow, node along the flow... -->

  <!-- Dashed feedback loop curving from Sink back to Source -->
  <svg class="diagram-arrows" viewBox="0 0 220 100">
    <path class="diagram-arrow muted dashed" d="M 200 60 C 200 95, 30 95, 18 60"
          vector-effect="non-scaling-stroke" data-reveal />
  </svg>
  <div class="diagram-label" style="left: 50%; top: 96%;" data-reveal>feedback</div>
</div>
```

**Other authoring rules:**
- Always include `vector-effect="non-scaling-stroke"` on arrow paths so strokes stay consistent when the diagram resizes.
- For curves, use SVG cubic Bezier (`C x1 y1, x2 y2, x y`). The two control points pull the curve toward themselves — start by placing them on the line between the endpoints and nudge perpendicular to taste.
- Feedback loops (the dashed arrow looping back from the end to the start) belong at the bottom of the DOM so they reveal last.
- Don't add inline `transform` to `.diagram-node` or `.diagram-label` — they already use `translate(-50%, -50%)` to centre on their `left/top` point, and the deck CSS preserves that during reveal.
- Keep diagrams to 7 nodes or fewer. More than that and the reveal sequence becomes tedious and the layout gets cramped. Split into two slides instead.

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

- **Dark slides:** Reserved for moments that matter. 2–3 per deck max.
- **Breakers:** A quiet line between acts. *"That felt normal. Until it wasn't."*

---

## Progressive reveal

Each slide can progressively reveal its content — like PowerPoint animations — by adding `data-reveal` to elements. Press **Space** or **Enter** to reveal the next element on the current slide. When all elements are revealed, the next press goes to the next slide. The counter shows `3/25 · 2/4` (slide 3 of 25, reveal 2 of 4 on that slide).

### How it works

Add `data-reveal` to any element you want to appear progressively. Elements start invisible and animate in with a subtle fade + slide-up. The reveal order is the DOM order — first `data-reveal` appears, then the second, etc.

**Never put `data-reveal` on eyebrows or headlines (h1/h2).** The eyebrow and headline set the frame for the slide — they should be visible the moment the slide lands so the audience knows what they're looking at. Reveal the supporting content (subtitle, columns, stats, diagram nodes), not the title.

**Never put `data-reveal` anywhere on the closing/thanks slide.** It's the final beat — everything should land at once so the speaker can stop talking and take questions.

```html
<section class="slide">
  <div class="slide-inner">
    <div class="eyebrow">Context</div>
    <h1>The headline <span class="dim">The extension</span></h1>
    <p class="subtitle" data-reveal>One line of nuance.</p>
    <div class="two-col" style="margin-top:2rem;" data-reveal>
      <div><h3>Problem</h3><p>The pain.</p></div>
      <div><h3>Fix</h3><p>The solution.</p></div>
    </div>
  </div>
</section>
```

Pressing Space/Enter cycles through: subtitle → two-col. Pressing ArrowRight always goes to the next slide regardless of reveal state.

### Typical reveal patterns

- **Simple text slide:** subtitle (1 reveal)
- **Comparison slide:** subtitle → two-col (2 reveals)
- **Stats slide:** stat-grid (1 reveal, or reveal each stat-card individually)
- **Dark slide:** subtitle (1 reveal)
- **Cover slide:** subtitle → meta (2 reveals)

### When to use it

- Slides with dense content (many data points, multiple columns, long lists)
- Slides where you want to control pacing and not overwhelm the audience
- Complex architecture diagrams or flowcharts where you want to walk through step by step

### When not to use it

- Simple slides (one stat, one quote, one image) — reveal adds nothing
- Slides meant to be absorbed at a glance
- If you're just doing a demo and not presenting slides

### Keyboard shortcuts

| Key | Action |
|-----|--------|
| ArrowLeft | Previous slide |
| ArrowRight | Next slide |
| Space / Enter | Reveal next element (or next slide if all revealed) |
| PageDown | Reveal next element (same as Space) |
| PageUp | Previous slide |
| Home | First slide |
| End | Last slide |
| P | Export to PDF |

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

The 27 components above are the standard library, not a ceiling. You are encouraged to invent new slide layouts when the content demands it. Follow these rules when freestyling:

1. **Stay on-token.** Use only the colours, fonts, weights, and spacing from the design tokens table. No new colours, no new fonts.
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

If it looks like it belongs next to the existing components, it's a good freestyle. If it needs a new colour or a different font to work, rethink it.

---

## When the human asks you to build a deck

1. **Ask for the story first.** What's the talk about? What's the arc? What's the closing line?
2. **Draft the structure** using the six-beat model above.
3. **Pick components** from the reference. Match component to content type.
4. **Write the HTML** using exact class names from this file.
5. **Iterate small.** One change at a time. Show the change, get feedback.

When the human says things like:
- "Make it dark" → add `.dark` to the `<section>`
- "Add a comparison" → use component 4 (two-column) or 13 (JEDUF)
- "Show the process" → use component 8 (dot flow) for a simple linear, 27 (flow row) for boxes+arrows, 28 (diagram) for branching/loops
- "Show an architecture" or "diagram with arrows" → use component 28 (diagram)
- "Add an image" → use component 12 (collage slide), reference `media/`
- "Show data" or "add a chart" → use component 26 (bar chart). Wrap in `.chart` for title/y-axis/legend; use `.bar-group` with `.s1`–`.s4` for grouped series.
- "Shorten the headline" → keep the bold-then-dim pattern, just use fewer words
