---
name: create-a-skill
description: Template and conventions for creating new skills — SKILL.md structure, CLI patterns, test harness, and gotchas.
last-updated: 2026-06-02
---

# Creating a New Skill

This skill documents the standard framework for creating skills in the Pi agent system. Use it as a checklist and template when adding new capabilities.

## Skill Structure

A complete skill has these components:

```
skills/your-skill-name/
├── SKILL.md              # Procedural instructions, API reference, examples
├── README.md             # User docs: requirements, quickstart, commands
├── your_skill/           # Python CLI package (standard library only)
│   ├── __init__.py
│   └── main.py
├── pyproject.toml        # Package metadata
└── tests/
    └── test.ts           # Automated test harness (Bun)
```

**Naming convention** (from existing skills):

| Skill | Package | CLI |
|-------|---------|-----|
| `bolig-dk` | `bolig_dk` | `bolig` |
| `transport-dk` | `transport_dk` | `transport` |
| `lex-dk` | `lex_dk` | `lexdk` |
| `dmi-dk` | `dmi_dk` | `dmi` |

---

## 1. SKILL.md — Procedural Instructions

### Frontmatter

```yaml
---
name: your-skill-name
description: One-line description of when the agent should use this skill.
last-updated: YYYY-MM-DD
---
```

### Body Structure

| Section | Purpose |
|---------|---------|
| **CLI** | How to install/run (`which <cmd>`, `pipx install -e`), standard library note |
| **Prerequisites** | Dependencies, auth requirements, VPN needs |
| **Commands** | Table: command → purpose; then subsections with examples |
| **Common tasks** | "How do I X?" patterns (optional, for complex skills) |
| **How it works** | API endpoints, auth models, robustness notes |
| **Limits** | What's out of scope, rate limits, known issues |
| **Etiquette / Licence** | If applicable (robots.txt, TDM opt-out, etc.) |

### Writing Guidelines

- **Trigger clarity**: Make it obvious when this skill should fire (specific keywords, domains, use cases)
- **Procedural, not declarative**: Tell the agent *how* to do things, not just *what* exists
- **Include verification commands**: `which <cmd>`, `curl -I <endpoint>`, etc.
- **Document auth models**: Session-bound vs anonymous, OAuth flows, VPN requirements
- **Note rate limits and quotas**: So agents can handle errors gracefully

---

## 2. README.md — User Documentation (Concise)

```markdown
# <skill-name>

One-line pitch — what domain it covers, which APIs/sources it merges.

## Requirements

- `<cmd>` CLI — standard library only (`pipx install -e .`)
- Internet access to `api.example.com`, `www.example.dk`
- Any auth/VPN requirements (document here)

## Quick start

```bash
<cmd> foo --option value        # brief comment
<cmd> bar -k keyword --limit 5  # another example
<cmd> baz                       # third example
```

Add `--raw` to any command for unformatted JSON.

## Commands

| Command | Purpose |
|---|---|
| `foo` | Does X |
| `bar` | Does Y with Z |
| `baz` | Lists all Q |

## Notes

- API endpoint details if relevant (e.g., `https://api.example.com/v1/...`)
- What's out of scope
- Known limitations or gotchas
- Auth requirements if any (session-bound endpoints, OAuth flows, etc.)

## Development

```bash
# Format code
uv run ruff format .

# Lint code
uv run ruff check .

# Run tests
bun run tests/test.ts
```
```

**Keep README concise** — detailed API reference, auth models, and gotchas belong in SKILL.md.

---

## 3. CLI Implementation

### Package Structure

```
your_skill/
├── __init__.py  # Version, exports
└── main.py      # argparse, commands, API clients
```

### Conventions

- **Standard library only** unless external deps are essential
- **argparse** for CLI, with subcommands
- **User-Agent header** on all HTTP requests
- **`--raw` flag** on every command for unformatted JSON output
- **Graceful degradation**: If API fails, explain why and suggest alternatives
- **No hardcoded credentials**: Use environment variables or explicit auth flows

### CLI Entry Point

```python
from __future__ import annotations
import argparse
import sys

def main() -> None:
    parser = argparse.ArgumentParser(prog="<cmd>", description="...")
    sub = parser.add_subparsers(dest="cmd", required=True)
    # ... add subcommands
    args = parser.parse_args()
    args.func(args)

if __name__ == "__main__":
    main()
```

### pyproject.toml

```toml
[project]
name = "your-skill-name"
version = "1.0.0"
description = "CLI for ..."
requires-python = ">=3.12"

[project.scripts]
your-cmd = "your_skill.main:main"

[build-system]
requires = ["setuptools>=68.0", "wheel"]
build-backend = "setuptools.build_meta"
```

---

## 4. Test Harness (tests/test.ts)

### Structure

```typescript
#!/usr/bin/env bun

import { $ } from "bun";
import { readFileSync } from "fs";
import { join, dirname } from "path";

const SKILL_DIR = join(dirname(import.meta.path), "..");
const SKILL_FILE = join(SKILL_DIR, "SKILL.md");
const SKILL_NAME = "your-skill-name";

// Test prompts (natural user questions, NOT CLI documentation)
const TEST_PROMPTS: string[] = [
  // English prompts with strong triggers (locations, site names, currency)
  "I need X in Copenhagen",
  "Find Y under 10,000 kr",
  
  // Danish prompts with strong triggers
  "Jeg leder efter X i København",
  "Find Y under 10.000 kr",
];

// Pre-flight checks, runPrompt, evaluateResults, runTestIteration, printResults, main
```

### Test Prompt Guidelines

| Do | Don't |
|----|-------|
| "I need a rental apartment in Frederiksberg with a bathtub" | "Can I find rentals?" (too generic) |
| "Looking for a house in Odense, budget 3 million kr" | "Show me houses for sale" (no location) |
| "Find listings on boligportal.dk mentioning 'badekar'" | "Search with keywords" (no site context) |

**Rule**: Every prompt must have at least one strong trigger:
- Danish city/municipality (Frederiksberg, Odense, Gentofte)
- Explicit site name (boligportal.dk, boligsiden.dk)
- Danish currency (kr, kroner)
- Danish language + Denmark context

### Pre-flight Checks

```typescript
async function preflightChecks() {
  const errors: string[] = [];
  
  // Skill file exists
  readFileSync(SKILL_FILE, "utf-8");
  
  // CLI installed
  await $`which your-cmd`.quiet();
  await $`your-cmd --help`.quiet();
  
  // Python code quality
  await $`uv run ruff format --check your_skill/`.quiet();
  await $`uv run ruff check your_skill/`.quiet();
  
  return { ok: errors.length === 0, errors };
}
```

### Evaluation Flow

1. Run all prompts through `pi -p "<prompt>"`
2. Collect (prompt, response) pairs
3. Call evaluator: `pi -p "<eval-prompt>"` with SKILL.md + results
4. Evaluator returns JSON: `[{test, passed, reason}, ...]`
5. 100% pass required, reset counter on any failure
6. 3 consecutive clean runs = APPROVED

### Run It

```bash
cd skills/your-skill-name
bun run tests/test.ts
```

---

## 5. Skill Autoload

Add frontmatter to SKILL.md:

```yaml
autoload:
  tools:
    - read
    - write
    - bash
  extensions:
    - .py
  files:
    - pyproject.toml
  paths:
    - your_skill/**/*.py
```

Or use `files:` for basename matching, `paths:` for globs. See `system/skill-autoload-path-matching` memory.

---

## Checklist

Before considering a skill "done":

- [ ] SKILL.md with procedures, API docs, examples, gotchas
- [ ] README.md with install + quickstart
- [ ] CLI package with `--help` on all commands
- [ ] `--raw` flag on every command
- [ ] Python code passes `ruff format` and `ruff check`
- [ ] 22 test prompts (11 English + 11 Danish) with strong triggers
- [ ] Test harness runs 3 iterations, 100% pass each
- [ ] Skill autoload frontmatter configured
- [ ] Restricted access documented (VPN, auth, local-only)

---

## Gotchas

### CLI Hangs on API Calls

If keyword search hangs, the `--max-scan` default is too high. Start with 30–50 for rent, 50–100 for buy.

```python
_add_keyword_opts(p, default_scan=30)  # Not 100!
```

### Test Prompts Too Generic

Prompts without location or site context may not trigger the skill. Always include:
- City names
- Site domains
- Currency markers
- Language context

### Worktree Memory Scope

If testing in builder worktrees, project-scoped memories may not resolve. Use `system` scope for cross-cutting test config.

### ToolCallId in Regex

Never interpolate raw toolCallId values into RegExp — escape them first. Some IDs contain `|`, `+`, `/`, `=` which break regex.

---

## Example Skills

Study these for reference:

| Skill | Domain | Notes |
|-------|--------|-------|
| `bolig-dk` | Housing | Full example with rent + buy, keyword search |
| `transport-dk` | Public transit | Multiple APIs merged (Rejseplanen, DSB, Metro) |
| `lex-dk` | Encyclopedia | Read-only, anonymous API |
| `email` | Email | Requires auth (IMAP/SMTP or OAuth) |
| `agent-browser` | Browser automation | Headless browser, JavaScript-heavy sites |

---

## TODOs for New Skills

- [ ] Define the domain: What questions should trigger this skill?
- [ ] Identify APIs/data sources: Public, authenticated, or scraped?
- [ ] Design CLI commands: What subcommands make sense?
- [ ] Write SKILL.md: Procedures first, reference second
- [ ] Implement CLI: argparse, HTTP client, `--raw` flag
- [ ] Write README.md: Install, quickstart, examples
- [ ] Create test.ts: 22 prompts (EN + DK), pre-flight, evaluator
- [ ] Tune defaults: `--max-scan`, timeout, match mode
- [ ] Run tests: 3 clean iterations required
- [ ] Configure autoload: `files:`, `paths:`, `extensions:`
- [ ] Document restrictions: VPN, auth, rate limits
