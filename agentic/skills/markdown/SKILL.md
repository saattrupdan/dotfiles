---
name: markdown
description: Markdown conventions including line width and formatting
tagline: Markdown formatting conventions
last-updated: 2026-06-02
autoload:
  tools:
    - read
    - write
    - edit
    - bash
  extensions:
    - .md
---

# Markdown Conventions

## Line Width

All markdown files should have lines of at most 88 characters. This fits nicely in
split-screen Neovim, matches Python's default line length, and works well with GitHub
diff views.

### Using Prettier

Format markdown files in place with Prettier:

```bash
prettier --print-width 88 --prose-wrap always --write file.md
```

This enforces:
- 88-character line width
- Always wrap prose (no long lines)
- In-place editing

## Writing Style

### Blog posts

- **First-person, conversational.** Use contractions (I've, it's, doesn't).
- **Humour:** Light self-deprecation, emoji sparingly (🙃, 🙂, 😊, 🎉).
- **Framing:** Personal journey ("I decided to…", "I found…", "I wanted to…").
  Even technical posts are _your_ exploration, not a textbook.
- **Hooks:** Start with motivation or problem, not definitions.
- **Direct address:** "Let's get crackin'" / "Let's dive in" / "Let's start by…"
- **Technical posts:** Brief disclaimer if you're new to the topic
  ("take with grains of salt", "I'm still a beginner").
- **Headings:** Use sentence fragments or questions.
- **Code:** Fenced blocks with language tag. Use `>>>` prefix for REPL-style Python.
- **Links:** `<router-link to="…">` for internal SPA navigation, `[text](url)` for external.
- **Closing:** "And that's it!" / "Hope it was useful!" + GitHub link if applicable.

### READMEs and project documentation

- **Direct and concise.** State what the project does in the opening paragraph.
- **Third-person or neutral tone** — no personal journey framing.
- **Structure:** Standard sections (Installation, Usage, Features, API, etc.).
- **Include:** Badges, maintainer info, license, quick-start examples.
- **Code:** Minimal, copy-pasteable examples with clear context.
- **No emoji, no humour** — focus on clarity and usability.
