---
name: agent-browser
description: >-
  Chromium-specific agent-browser CLI. Use only when a task explicitly requires
  agent-browser, Chromium/CDP, Electron desktop automation, Slack automation, Vercel
  Sandbox browsers, AWS Bedrock AgentCore browsers, or maintenance of a CLI that
  already shells out to agent-browser (such as the LinkedIn skill). For ordinary
  websites, forms, logins, testing, and headed/headless browsing, use the web-browse
  skill and Pi's native Firefox web_browse tool instead.
hidden: true
tagline: Browser automation CLI for AI agents
---

# agent-browser

> **Not Pi's default web browser.** For ordinary web automation, load the
> `web-browse` skill and use Pi's Firefox-backed `web_browse` tool. This skill is
> retained for specialized Chromium/CDP, Electron, and existing CLI workflows.

Fast browser automation CLI for AI agents. Chrome/Chromium via CDP with
accessibility-tree snapshots and compact `@eN` element refs.

Install: `npm i -g agent-browser && agent-browser install`

## Start here

This file is a discovery stub, not the usage guide. Before running any
`agent-browser` command, load the actual workflow content from the CLI:

```bash
agent-browser skills get core             # start here — workflows, common patterns, troubleshooting
agent-browser skills get core --full      # include full command reference and templates
```

The CLI serves skill content that always matches the installed version,
so instructions never go stale. The content in this stub cannot change
between releases, which is why it just points at `skills get core`.

## Specialized skills

Load a specialized skill when the task falls outside browser web pages:

```bash
agent-browser skills get electron          # Electron desktop apps (VS Code, Slack, Discord, Figma, ...)
agent-browser skills get slack             # Slack workspace automation
agent-browser skills get dogfood           # Exploratory testing / QA / bug hunts
agent-browser skills get vercel-sandbox    # agent-browser inside Vercel Sandbox microVMs
agent-browser skills get agentcore         # AWS Bedrock AgentCore cloud browsers
```

Run `agent-browser skills list` to see everything available on the
installed version.

## Why agent-browser

- Fast native Rust CLI, not a Node.js wrapper
- Works with any AI agent (Cursor, Claude Code, Codex, Continue, Windsurf, etc.)
- Chrome/Chromium via CDP with no Playwright or Puppeteer dependency
- Accessibility-tree snapshots with element refs for reliable interaction
- Sessions, authentication vault, state persistence, video recording
- Specialized skills for Electron apps, Slack, exploratory testing, cloud providers

## Observability Dashboard

The dashboard runs independently of browser sessions on port 4848 and can also be opened through a proxied or forwarded URL such as `https://dashboard.agent-browser.127.0.0.1`. Agents should stay on the dashboard origin: session tabs, status, and stream traffic are proxied internally, so session ports do not need to be exposed.

## Gotcha: `wait` takes milliseconds

`agent-browser wait N` expects **just a number** — no unit suffix. The number is interpreted as **milliseconds**, not seconds. So `wait 10` waits 10 ms, `wait 10000` waits 10 s. This is unlike `sleep 10s` or `timeout 10s` which accept suffixes.
