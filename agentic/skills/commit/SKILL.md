---
name: commit
description: Conventions for structuring git commit messages using the Conventional Commits specification. Use when writing or reviewing commits.
tagline: Structure git commits with conventional commit message format
last-updated: 2026-06-02
---

## Commit Conventions

The Conventional Commits specification is a lightweight convention on top of commit
messages. Commit messages should be structured as follows:

```text
<type>: <description>

[optional body]
```

The types can be the following:

- `fix`: Fixed a bug
- `feat`: Added a new feature
- `docs`: Documentation only changes
- `tests`: Added or modified tests
- `style`: Changes that do not affect the meaning of the code (e.g., formatting)
- `chore`: Changes that don’t modify src or test files (e.g., dependencies, makefile)

The description should be short and concise, and should not exceed 50 characters.

The optional body can be longer, if it is a large change that requires more explanation.
In almost all cases, this is not used, however.

## Pre-commit checklist

Before committing, check the following:

- [ ] **Run cheap checks**: Formatters and linters first. Python: `ruff check`
      (lint) and `ruff format` (format), plus `ty` for type checking.
      JavaScript/TypeScript: `eslint` and `tsc`. Or `pre-commit run`, `npm run lint`.
      Fix any issues before committing.
- [ ] **Main branch permission**: If on `main`/`master`, verify you can commit directly
      (check AGENTS.md, a memory, or this session). If unsure or not permitted, create a
      feature branch or PR instead.
- [ ] **CHANGELOG.md**: For user-visible changes (fixes, features, behavior changes),
      add an entry under `[Unreleased]` in the appropriate section (`Added`, `Changed`,
      `Fixed`, etc.). Match the existing style: 2-space indentation, ~80 char wrapping.
- [ ] **Commit message**: Follows the conventional commit format with a concise
      subject (≤50 chars after the type prefix).
- [ ] **Push**: In some projects (e.g. pi-agent.nvim), changes should be pushed in
      the same step as committing — check the project's AGENTS.md for conventions.
