# Design

The visual system. Tokens, components, rules.

Light, minimal, type-led. Inspired by editorial layouts and product showcase pages.

The principle: most pages are a headline, two columns, and breathing room. Anything more should earn its place.

---

## Colors

```
Background          #f5f5f3   warm off-white
Surface (subtle)    #fafaf8   slightly lighter than background, for cards
Surface (white)     #ffffff   for cards that should pop more
Hero / dark slide   #1a1a1a   inverted callouts, dark slides

Border (soft)       #e0e0db
Border (medium)     #d5d5d0
Pill background     #eeeee9

Text primary        #1a1a1a
Text dim            #a0a09a   subtitles, body that recedes
Text very dim       #b5b5b0   meta info, decorative
Text faint          #c5c5c0   labels next to pills

On-dark text        #f5f5f3
On-dark dim         #ccc
On-dark very dim    #888
```

Two grays do most of the work. Use color for hierarchy, not decoration.

---

## Typography

**Font:** Inter (Google Fonts). Weights 300, 400, 500, 600.

```
H1 (display)         clamp(2rem, 4.5vw, 3.2rem)   weight 500  letter-spacing -0.03em  line-height 1.2
H1 (slide cover)     clamp(2.5rem, 6vw, 5rem)     weight 500  letter-spacing -0.035em line-height 1.1
H2                   clamp(1.75rem, 3.5vw, 2.6rem) weight 500  letter-spacing -0.025em
H3 (section)         9.5pt–1rem                   weight 500  letter-spacing -0.01em
Body / subtitle      0.78–0.88rem                 weight 400  line-height 1.5–1.6
Eyebrow / label      0.65–0.75rem  uppercase   weight 500  letter-spacing 0.08em  color #a0a09a
Big number           clamp(2.4rem, 4.5vw, 3.5rem) weight 600  letter-spacing -0.035em
```

---

## The headline pattern

Headlines use a bold-then-dim split. The first phrase carries weight (500). The continuation fades to gray (300, color `#b5b5b0`). This gives every headline a built-in narrative — anchor + extension.

```html
<h1>Anchor. <span class="dim">Extension.</span></h1>
<h1>One spec. <span class="dim">Full transparency.</span></h1>
<h1>The tools changed. <span class="dim">The instinct is still yours.</span></h1>
```

```css
h1 span.dim {
  color: #b5b5b0;
  font-weight: 300;
}
```

This is the most consistent visual identity in the system. Use it.

---

## Spacing & rhythm

- **Slides:** 6vh top/bottom, 8vw sides. Max content width 1100px.
- **Cards/callouts:** 1rem–1.5rem padding internal.
- **Border radius:** 6–10pt for cards, 4pt for small buttons/steps.
- **Gaps between sections within a slide:** 2–4rem typically. Err toward more space.

---

## Components

### Eyebrow + Headline + Subtitle
The default opening of any slide. Eyebrow tags context. Headline carries the message. Subtitle gives one line of nuance.

### Two-column
Equal columns, gap 30–40pt. Each column has H3 + paragraph. Use for contrast: before/after, problem/solution, today/with-us.

### Three-column
Three equal columns. Used for structural breakdowns. Each column gets a 1-word title and a 1–2 sentence body.

### Capability list (Q&A)
Rows separated by thin borders. Left column = question (medium weight). Right column = answer (regular, dim color).

### Callout (dark block)
Black background, white text, rounded 6pt. For "Why now" or other emphasized sections. One per deck max.

### Dot flow
Five (or N) horizontal steps connected by a thin line. Each step: 9px black dot, label, dim caption. Used for process flows.

### Stack grid
Four-column grid of category cards. Each card has uppercase label + list of items with small monochrome marks.

### Spec block + context + outputs
A vertical flow: dark spec block at top → context pills → "Process" divider line → three output cards. Used for showing how a system processes input.

### Product slide (showcase style)
Big product name on the right. Description on the left with /0n number, tag, headline, body, stat line.

### Collage slide
Full-bleed image or video as its own slide. Used as a punch after a product slide. No text overlay — the image is the slide.

### JEDUF three-column
Three columns showing extremes vs middle path. Outer columns light, center column dark as the hero. Steps stacked vertically inside each column.

### Quote slide
A single bold statement, large type, no other elements. Used for openings, transitions, and mic-drops.

### Dark slide
Light text on black. Used for pivot moments. Two or three per deck max.

---

## Tone & voice rules

- **Bold the keyword. Dim the rest.** That's the rhythm of every headline.
- **No em-dashes in body copy.** Use periods or split into shorter sentences.
- **No fluff.** If a sentence doesn't add information, delete it.
- **Numbers should be specific.** "7×" beats "huge gains." "35 use cases per week" beats "much faster."
- **Headlines are statements, not questions.** Q&A rows are an exception — the question is the format.
- **Use names, not pronouns.** The product/feature/concept by name beats "it" or "this thing."

---

## What this isn't

- Not a framework. There's no NPM package, no CSS variables file, no build step. Each deck is a single self-contained HTML file with inline styles.
- Not designed for a real product UI. This is for content pages — decks, one-pagers, overviews. If you build an app, use a real component library.
- Not pretending to be neutral. The voice is opinionated. Lean into it.
