# Using the deck

A guide to making slides with this template.

---

## Quick start

1. **Clone or download** this repo.
2. **Open `deck.html`** in any modern browser. That's it. No build step. No dependencies.
3. **Edit the HTML** to add your content. Each slide is a `<section class="slide">`.
4. **Drop your media** into `media/` and reference it with relative paths.
5. **Present** in full-screen (F11 in Chrome, or Cmd+Ctrl+F on Mac).

The file is fully self-contained except for fonts (Inter is loaded from Google Fonts). If you'll present somewhere without wifi, that one line at the top of `<style>` is the only thing that needs to change.

---

## Using with Claude Code

This template was made for collaboration with Claude Code (or any AI coding assistant). The workflow that works:

1. **Open the repo in your editor** with Claude Code running.
2. **Tell Claude what slide you want.** Example: *"Add a quote slide after slide 4 that says 'But isn't this just chaos?' as a question."*
3. Claude inserts the slide using the existing components.
4. **Iterate by feedback.** *"Make it dark."* *"Move it before slide 5."* *"Shorten the headline."*
5. **Drop in media** as you go: *"Wire `media/demo.mp4` to the collage on slide 8."*

The key is treating the deck as **a document, not a tool**. You write it like prose. The components are just the vocabulary.

### Tips for prompting

- **Say what you want, not how to build it.** "Add a comparison slide" beats "use a three-column grid."
- **Reference existing slides.** "Make slide 5 quieter, like slide 2." Claude will copy the pattern.
- **Iterate small.** Don't ask for 10 changes at once. One thing, see it, next thing.

---

## Components

Every component is in `deck.html` as a working example. Copy any `<section class="slide">` and edit the content.

| Component | What it's for |
|---|---|
| **Cover** | Title, speaker, date. First slide. |
| **Quote slide** | A single bold statement. Used for openings, transitions, mic-drops. |
| **Eyebrow + headline + subtitle** | The default text slide. Use for setup, explanation, framing. |
| **Two-column** | Side-by-side comparison. Problem/fix, before/after, today/tomorrow. |
| **Step stack** *(in two-column)* | The "old way of building" pattern. Cumulative steps, dimmed blockers, kill marker at the end. |
| **Three-column** | Why/how/what or any structural breakdown. |
| **Capability list** | Q&A rows. "What it solves" sections. |
| **Dark callout** | One-per-deck emphasis block. Black background, white text. |
| **Dot flow** | Process diagram. Five steps connected by a thin line. |
| **Stack grid** | Four cards of categorized tools/items with simple marks. |
| **Spec block + outputs** | Input → process → outputs vertical flow. |
| **Product slide** | Showcase style. Big name on the right, description on the left. |
| **Collage slide** | Full-bleed image or video. Used after a product slide for impact. |
| **JEDUF three-column** | Two extremes vs the middle path. Hero column is dark. |
| **Dark slide** | A pivot moment. Marks the turn in the talk. |
| **Closing** | Mic-drop line. Often dark. |

---

## Keyboard shortcuts

| Key | Action |
|---|---|
| `→` `Space` `PageDown` | Next slide |
| `←` `PageUp` | Previous slide |
| `Home` | Jump to first slide |
| `End` | Jump to last slide |
| `P` | Download PDF |
| Swipe left/right | Next / previous slide (touch devices) |

---

## Embedding

Add `?embed` to any deck URL to get an embeddable version. The PDF button hides; navigation arrows, slide counter, and progress bar stay visible.

```html
<iframe src="your-deck.html?embed" style="width:100%; aspect-ratio:16/9; border:none;"></iframe>
```

Works in blog posts, Notion, documentation sites, or anywhere that renders HTML. The deck is fully interactive inside the iframe — arrow keys, swipe, and click navigation all work.

---

## Presenting

**Full-screen:** F11 (Chrome/Edge) or Cmd+Ctrl+F (Safari).

**Tip:** Test the deck on the actual screen you'll present from. Aspect ratios matter. The deck is responsive but feels best at 16:9.

**Backup plan:** Always download a PDF before the talk. If the laptop dies, you can present from the PDF on a phone or borrowed machine.

---

## PDF export

Click **Download PDF** (bottom center) or press `P`. In the browser print dialog:

- **Destination:** Save as PDF
- **Layout:** auto-detected from `@page` (16:9, 13.333in × 7.5in — matches PowerPoint widescreen)
- **Margins:** None / Default
- **Background graphics: ON** *(critical — otherwise dark slides print white)*

This works best in Chrome. Safari and Firefox sometimes mangle backgrounds.

---

## Adding a slide

1. Find the slide that comes before yours in `deck.html`.
2. Copy any existing `<section class="slide">…</section>` block.
3. Paste it after the previous slide.
4. Edit the content.

The slide counter and progress bar update automatically — no JS changes needed.

---

## Customizing the design

**To change colors, type, or spacing:** edit the `<style>` block at the top of `deck.html`.

**To stay on-brand:** see `docs/DESIGN.md` for the design tokens and rules. The design is opinionated — bold-then-dim headlines, no em-dashes in body copy, monochrome with one accent color (black). Lean into it or fork it.

**To use your own fonts:** replace the Inter import line at the top with your own. Update `font-family` in the `body` rule.

---

## Troubleshooting

**Images don't load.** You're probably opening the file from a different folder than `media/`. Make sure `deck.html` and `media/` sit next to each other.

**Videos won't autoplay with sound.** Browsers block this by default. Use `controls` (let the user click play) or `autoplay muted loop` (silent background).

**PDF export looks wrong.** Make sure "Background graphics" is enabled in the print dialog. Use Chrome — it has the best print engine.

**Fonts look wrong offline.** Inter is loaded from Google Fonts via the `@import` line. If you need offline support, download Inter and reference it locally instead.

---

## What this isn't

It's not a slideshow framework like Reveal.js or Slidev. It doesn't have transitions, themes, or build steps. It's just HTML and CSS. That's the point.

If you need animation, fragments, speaker notes, or a presenter view — use Reveal.js. If you need editing in PowerPoint — use PowerPoint. This template is for people who want to write their deck like a website.
