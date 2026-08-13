---
name: linkedin-carousel
description: Create a LinkedIn carousel from a blog post or written content, and export it as a downloadable PDF. Use this skill whenever the user wants to turn an article, blog post, or piece of writing into a LinkedIn carousel, slide deck for social media, or multi-slide visual post. Trigger when the user says things like "turn this into a carousel", "make slides from this", "LinkedIn carousel", "social media slides", or pastes content and asks for a visual post. Also trigger when the user wants to repurpose written content for LinkedIn, or asks to export or download a carousel as a PDF.
---

# LinkedIn Carousel Creator

Converts blog posts and written content into polished, on-brand LinkedIn carousels rendered as interactive slide previews using the `visualize:show_widget` tool.

## Output

Two deliverables:

1. **Interactive widget** — An HTML preview showing all carousel slides with a tab-based navigator, rendered inline so the user can review before exporting.
2. **Downloadable PDF** — One square page (540×540pt) per slide, generated with `reportlab` and presented as a `.pdf` file the user can download and upload directly to LinkedIn.

## Step 1: Extract narrative structure

Before writing any code, read the source content and identify:

- **The hook** — the tension, surprising stat, or provocative question that will stop the scroll
- **The core insight** — the single most valuable idea
- **The supporting points** — 2–4 concrete details, blockers, or steps
- **The CTA** — what the reader should do next

Map these to slides. Aim for **5–7 slides**. Fewer is better — each slide should earn its place.

Typical arc:

1. Hook (tension/question)
2. The pattern or problem (relatable friction)
3. Detail slide (blockers, steps, or breakdown — use numbered cards)
4. The insight (contrarian or counterintuitive takeaway)
5. The solution or product (if there is one)
6. CTA

## Step 2: Ask for brand details (if not already known)

Before rendering, confirm:

- **Brand colors** (ask for hex codes if not provided — you need at least a primary and an accent)
- **Font** (default to JetBrains Mono if the user is in tech/dev; otherwise use the system sans)
- **Logo or company name** for the lower-right watermark

If the user is at Kilo Code, use these defaults without asking:

- Colors: `#FAF74F` (yellow), `#1a1a18` (near-black), `#087bc9` (blue)
- Font: JetBrains Mono
- Watermark: "Kilo.ai"

## Step 3: Render the carousel widget

Use `visualize:read_me` with `["mockup", "interactive"]` first, then call `visualize:show_widget`.

### Color rotation strategy

Rotate slide backgrounds to create visual rhythm. Never use the same background on two consecutive slides. A strong default rotation for a 3-color brand:

| Slide        | Background             | Headline color           | Body color  |
| ------------ | ---------------------- | ------------------------ | ----------- |
| 1 (Hook)     | Dark                   | White + accent highlight | Muted white |
| 2 (Problem)  | Accent (yellow/bright) | Dark                     | Dark muted  |
| 3 (Detail)   | White                  | Dark                     | Dark        |
| 4 (Insight)  | Dark                   | Accent                   | Muted white |
| 5 (Solution) | Brand blue/secondary   | White                    | Muted white |
| 6 (CTA)      | Dark                   | White + accent           | Muted white |

### Typography - Start Large, Expect to Reduce

**IMPORTANT**: Typography is the #1 cause of layout issues. Start with larger fonts and be prepared to reduce them iteratively.

- Load JetBrains Mono from Google Fonts if that's the brand font: `https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500&display=swap`
- Apply `font-family` globally via `* { font-family: '...', monospace; }`
- **Headlines**: Start at 42-48px, expect to reduce to 36-42px for readability
- **Body**: Start at 18-20px, but 16px minimum is acceptable if needed
- **Eyebrow/tag labels**: 14-16px (can omit entirely if space is tight)
- **Watermark**: 12-14px works better than smaller sizes
- Font weight: 400 (body) and 500 (headings) only — never 600 or 700

**Text Overflow Strategy**:

- Always test with actual content, not placeholders
- Use `stringWidth()` in PDF to calculate exact text measurements
- Break long text into multiple lines proactively
- Prioritize readability over design complexity

### Slide anatomy

Every slide has:

- **Eyebrow** — small label top-left (e.g. "The pattern", "Introducing", "02") — **OPTIONAL: omit if space is tight**
- **Headline** — large, punchy, 1–2 lines max
- **Body** — 1–3 sentences or a bullet list (use yellow dots `●` for bullets on dark/blue slides)
- **Watermark** — company name, bottom-right, appropriate color for background

### Slide container

```css
.slide-container {
  width: 100%;
  max-width: 540px;
  aspect-ratio: 1 / 1;
  position: relative;
  border-radius: 12px;
  overflow: hidden;
}
```

### Layout spacing - Be Conservative

**CRITICAL**: Start with conservative spacing and adjust as needed:

- **Slide padding**: Start with 30px, not 40px
- **Element margins**: Use 10-15px between elements initially
- **Line height**: 1.4-1.5 for body text to prevent cramping

### Navigator

Simple tab buttons above the slide. Active tab: dark background + accent text. Inactive: system secondary background + muted text. Show `"Slide N of M — [Label]"` below the slide in small monospaced text.

### Detail slides - Avoid Complex Cards When Possible

**WARNING**: Numbered cards are prone to alignment issues. Consider alternatives:

**Simple approach (recommended)**:

```html
<strong>Point 1:</strong> Description text here <br /><br />
<strong>Point 2:</strong> More description text
```

**Card approach (use only if essential)**:

```html
<div class="block" style="background: #f5f5f3; border-radius: 10px; padding: 15px 18px;">
  <div class="block-num">01</div>
  <div class="block-title">Title</div>
  <div class="block-body">Body text</div>
</div>
```

On dark/colored backgrounds, use `rgba(255,255,255,0.1)` as card background.

**When to abandon cards**: If alignment becomes problematic, switch to simple text with bold headers.

### Watermark Color Logic

**CRITICAL**: Watermark must be visible on all backgrounds:

- **Dark backgrounds** (dark, blue): Use white watermark
- **Light backgrounds** (white, yellow): Use dark watermark
- **Implementation**: Add CSS classes or conditional logic for watermark color

### Price / metric callout

If the content has a price, stat, or key number, give it its own line:

- Font size: 34–38px, font-weight: 500
- Color: accent (yellow or white)
- Sub-label below: 11px, muted

### CTA slide

Center-aligned. Include a styled button element in the accent color (yellow background, dark text). Use the post's own closing line as the headline if it's sharp — don't invent generic copy.

## Step 4: Copy guidance

- **Pull copy directly from the source** — don't paraphrase into generic LinkedIn-speak
- The hook headline should create tension or surprise, not describe the post
- Quote blocks work well on slide 2: `border-left: 3px solid [dark]; padding-left: 16px`
- Keep each slide to one idea — if you need more than 3 sentences, split into two slides

## Step 5: Generate the PDF

After the widget is approved (or immediately if the user asks for a PDF directly), generate a downloadable PDF using `reportlab`.

### Setup

```python
pip install reportlab --break-system-packages -q
```

Register a monospace font. JetBrains Mono is preferred — if it's not available on the system, fall back to DejaVu Sans Mono:

```python
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
import os

jbm_path = '/path/to/JetBrainsMono-Regular.ttf'
fallback = '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf'
font_path = jbm_path if os.path.exists(jbm_path) else fallback
pdfmetrics.registerFont(TTFont('Mono', font_path))

jbm_bold = '/path/to/JetBrainsMono-Medium.ttf'
fallback_bold = '/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf'
font_bold = jbm_bold if os.path.exists(jbm_bold) else fallback_bold
pdfmetrics.registerFont(TTFont('MonoBold', font_bold))
```

### Canvas setup

Each slide is a 540×540pt square page:

```python
from reportlab.pdfgen import canvas
import os

CAROUSELS_DIR = 'public/carousels'
os.makedirs(CAROUSELS_DIR, exist_ok=True)

# Use a descriptive filename based on the content
filename = 'carousel.pdf'  # Or derive from content topic
output_path = os.path.join(CAROUSELS_DIR, filename)

SIZE = 540
c = canvas.Canvas(output_path, pagesize=(SIZE, SIZE))
```

Call `c.showPage()` between slides. Call `c.save()` at the end.

### Typography rules (PDF) - Conservative Sizing

**UPDATED APPROACH**: Start with smaller, more reliable font sizes:

- **Headlines**: `MonoBold`, 32–42pt (reduced from previous guidance)
- **Body**: `Mono`, 16–18pt, manual word-wrap at ~480pt width, line height 20–24pt
- **Eyebrow labels**: `Mono`, 14–16pt, uppercase (or omit if space is tight)
- **Watermark**: `Mono`, 12–14pt, `setFillAlpha(0.3)`, bottom-right via `drawRightString`

### Word wrap helper - Enhanced with Measurements

ReportLab doesn't wrap text automatically. Use this enhanced pattern:

```python
def wrap_text(c, text, x, y, max_width, font, size, color, line_height=20):
    c.setFont(font, size)
    c.setFillColor(color)
    words = text.split()
    lines, current = [], ''
    for word in words:
        test = (current + ' ' + word).strip()
        if c.stringWidth(test, font, size) < max_width:
            current = test
        else:
            if current:  # Avoid empty lines
                lines.append(current)
            current = word
    if current:
        lines.append(current)
    for i, line in enumerate(lines):
        c.drawString(x, y - i * line_height, line)
    return len(lines) * line_height  # Return total height used
```

### Text positioning with measurements

For bullet points or mixed formatting, measure text width to prevent overlap:

```python
# Example: Bold label + regular text on same line
label = "Bold text:"
c.setFont('MonoBold', 16)
c.setFillColor(YELLOW)  # Use defined color constant
c.drawString(x, y, label)
label_width = c.stringWidth(label, 'MonoBold', 16)

c.setFont('Mono', 16)
c.setFillColor(MUTED_WHITE)  # Use defined color constant
c.drawString(x + label_width + 10, y, "Regular text follows")  # 10pt gap
```

### Numbered card helper - Simplified

**WARNING**: Use sparingly. Consider simple text formatting instead.

```python
def card(c, x, y, w, h, bg_color, num, title, body_text):
    c.setFillColor(bg_color)
    c.roundRect(x, y, w, h, 8, fill=1, stroke=0)
    c.setFont('MonoBold', 16); c.setFillColor(BLUE)
    c.drawString(x+15, y+h-25, num)
    c.setFont('MonoBold', 20); c.setFillColor(DARK)
    c.drawString(x+15, y+h-48, title)
    wrap_text(c, body_text, x+15, y+h-70, w-30, 'Mono', 16, MUTED_DARK, line_height=18)
```

### Bullet item helper - with proper spacing

```python
def bullet_item(c, text, x, y, dot_color, text_color, size=16):
    c.setFillColor(dot_color)
    c.circle(x+4, y+6, 3, fill=1, stroke=0)
    wrap_text(c, text, x+20, y, 460, 'Mono', size, text_color, line_height=20)
```

### Color constants (Kilo Code defaults)

```python
from reportlab.lib.colors import HexColor
DARK    = HexColor('#1a1a18')
YELLOW  = HexColor('#FAF74F')
BLUE    = HexColor('#087bc9')
WHITE   = HexColor('#FFFFFF')
LIGHT_BG = HexColor('#F5F5F3')
MUTED_WHITE = HexColor('#CCCCCC')
MUTED_DARK = HexColor('#666660')
```

### Slide structure - Iterative Approach

**CRITICAL**: Be prepared to adjust layouts multiple times.

Reproduce each slide from the widget, but be ready to modify:

1. Fill background with `c.rect(0, 0, SIZE, SIZE, fill=1, stroke=0)`
2. Draw eyebrow (top-left, 14-16pt, muted) — **OMIT if space is tight**
3. Draw headline (MonoBold, large but conservative)
4. Draw body / cards / bullets — **SIMPLIFY if alignment issues occur**
5. Draw watermark (bottom-right, correct color for background)
6. Call `c.showPage()`

**When layouts break**:

- Reduce font sizes by 2-4pt
- Increase line spacing
- Convert cards to simple text
- Omit eyebrow text
- Break long text into multiple lines

### Watermark helper - Color-aware

```python
def draw_watermark(c, watermark_text, color=DARK):
    """Draw bottom-right watermark with appropriate color"""
    c.setFont('Mono', 14)
    c.setFillAlpha(0.3)
    c.setFillColor(color)
    c.drawRightString(SIZE - 15, 15, watermark_text)
    c.setFillAlpha(1.0)

# Usage:
draw_watermark(c, "Kilo.ai", WHITE)  # For dark backgrounds
draw_watermark(c, "Kilo.ai", DARK)   # For light backgrounds
```

### Output and delivery

Save the PDF directly to the `public/carousels/` directory:

```python
# The PDF is already saved to public/carousels/carousel.pdf via the canvas setup above
# The file is automatically tracked in the repo under the carousels directory
```

Use `present_files` to make the PDF downloadable from `public/carousels/`.

Note for users: if JetBrains Mono isn't available server-side, the PDF will use DejaVu Sans Mono as a fallback. For the final version with the exact brand font, run the script locally with JetBrains Mono installed.

## Step 6: Follow-up and Iteration

After delivering both the widget and the PDF:

- Briefly note the narrative logic (why each slide is in that position)
- **Expect iteration**: Font sizes, spacing, and layouts often need adjustment
- Offer to adjust copy, swap slide order, or change colors
- **Be ready to simplify**: Complex layouts may need to become simple text
- Do not explain rendering mechanics or mention font loading details

### Common Issues and Solutions

**Text overflow**: Reduce font sizes, break into multiple lines, or shorten copy
**Card alignment**: Switch to simple bold text with line breaks
**Watermark invisible**: Check background color and adjust watermark color
**Cramped layout**: Reduce padding, omit eyebrow text, increase line spacing
**Bullet overlap**: Use `stringWidth()` to calculate proper positioning
