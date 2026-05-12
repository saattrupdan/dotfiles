---
name: slides
description: What — the noskillish/slides framework for building single-file HTML decks (no build step, three themes: Default/Craft/Solid, 25+ ready components, PDF export, embed mode). Use when the user asks to create, draft, extend, or restyle a slideshow, presentation, or deck — e.g. "create a slideshow about X", "make a deck on Y", "add a quote slide", "turn these notes into slides".
last-updated: 2026-05-12
---

## What this skill does

Produces a single self-contained `deck.html` file in the user's chosen directory using the noskillish/slides framework. No build step, no dependencies beyond Google Fonts (Inter). Navigate with arrow keys / space / swipe; export to PDF with `P`; embed with `?embed`.

## Bundled assets

This skill ships with everything you need — do not fetch from the internet:

- `template/deck.html` — **Default theme.** Minimalist editorial: warm off-white (`#f5f5f3`) base, Inter, bold-anchor/dim-extension headlines. The reference implementation; all 25 components in `COMPONENTS.md` map to this file.
- `template/deck-craft.html` — **Craft theme.** Warm parchment (`#f5f0e8`) + burnt-orange accent (`#c05a3a`), 12px rounded cards, editorial SaaS feel (Cursor/Linear/Notion lineage). Same 21 base components plus craft-specific extras (testimonial grid, logo bar, art overlay, feature cards, update row).
- `template/deck-solid.html` — **Solid theme.** Deep-black base with aurora gradient, frosted-glass cards (backdrop-blur), Inter Tight + JetBrains Mono, numbered hairline markers. No chromatic accent. Same 21 base components.
- `reference/COMPONENTS.md` — the full component library (25 components: cover, quote, two-column, three-column, capability list, dark callout, dot flow, stack grid, spec block, product, collage, JEDUF, dark, timeline, stat grid, quote pair, logo grid, code, closing, testimonial grid, logo bar, feature cards, update row, art overlay). **Read this before writing slides.** Copy HTML structures verbatim; change only text content.
- `reference/STORYTELLING.md` — six-beat structure (Open / Act 1 World Before / Act 2 The Turn / Act 3 Evidence / Act 4 Honest Part / Close) and pacing rules.
- `reference/DESIGN.md` — design tokens (colors, type scale, spacing). Stay strictly on-token.
- `reference/USING.md` — keyboard shortcuts, PDF export, embed mode.

## Workflow

When the user asks for a deck:

1. **Ask which theme** (use `AskUserQuestion` with the three options): Default (minimalist), Craft (warm parchment + orange), or Solid (dark frosted-glass). Skip if the user already specified a theme or visual direction that clearly maps to one.
2. **Ask for the story** (one short message): topic, audience/context, rough length, and the closing line. Skip if the user has already given enough.
3. **Read `reference/COMPONENTS.md`** before drafting — copy patterns verbatim. Note: craft adds components 22–26 (testimonial grid, logo bar, art overlay, feature cards, update row).
4. **Sketch the arc** using the six-beat structure from `reference/STORYTELLING.md`. State the beat plan back to the user in 5–10 lines before writing HTML.
5. **Copy the chosen template** to the target location as `deck.html` (default `./deck.html` in the user's cwd unless they specify). Use `cp template/deck-<theme>.html <target>/deck.html` — the template's `<style>` and `<script>` blocks must remain intact.
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

## Reference

- [noskillish/slides](https://github.com/noskillish/slides)
