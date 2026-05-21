# commit

Reference for commit message conventions following the Conventional Commits specification.

## Requirements

- Git installed and configured
- Familiarity with Conventional Commits specification

## Quick Start

```bash
# Basic commit with type and description
git commit -m "feat: add user authentication"

# Bug fix
git commit -m "fix: resolve null pointer in login handler"

# Documentation update
git commit -m "docs: update API reference"

# Large change with body
git commit -m "feat: implement search functionality

Add full-text search across all resources with pagination
and relevance scoring."
```

## Commit Message Format

```
<type>: <description>

[optional body]
```

The description should be short and concise, not exceeding 50 characters.

## Commit Types

| Type | Meaning |
|---|---|
| `fix` | Fixed a bug |
| `feat` | Added a new feature |
| `docs` | Documentation only changes |
| `tests` | Added or modified tests |
| `style` | Changes that do not affect the meaning of the code (e.g., formatting) |
| `chore` | Changes that don't modify src or test files (e.g., dependencies, makefile) |

## Examples

```bash
# Feature addition
git commit -m "feat: add export to CSV functionality"

# Bug fix
git commit -m "fix: handle empty results in search"

# Documentation
git commit -m "docs: add contributing guidelines"

# Tests
git commit -m "tests: add unit tests for auth module"

# Formatting
git commit -m "style: format code with ruff"

# Chore
git commit -m "chore: update dependencies"
```
