# `_outliner`

Shared tree-sitter based source outliner used by the `read` and `search` pi
extensions. This directory is a **pure library** - it does **not** register any
pi tools. Sibling extensions import it via relative paths, e.g.

```ts
import { outline, collapsedView } from "../_outliner/outliner.ts";
```

## Purpose

Given a file path and its contents, `outline()` returns an ordered list of
structural entries (classes, functions, methods, headings, ...). `collapsedView()`
renders those entries as an indented text listing that fits a caller-specified
line budget, collapsing the largest classes first when over budget.

The library is designed for two consumers:

- `extensions/read/` - shows an outline when a file is too large to read in
  full, and lets the user expand classes/functions on demand.
- `extensions/search/` - builds and queries a repo-wide outline index.

## Public API

```ts
export type OutlineEntry = {
  line: number;          // 1-indexed
  kind: "class" | "function" | "method" | "heading" | "block";
  name: string;
  parent?: string;       // enclosing class, when applicable
  docFirstLine?: string; // first line of docstring/JSDoc, <= 80 chars
};

export function outline(path: string, source: string): OutlineEntry[];

export type CollapsedViewOpts = {
  maxLines?: number;     // default 100
  hidePrivate?: boolean; // default true
};

export function collapsedView(
  entries: OutlineEntry[],
  opts?: CollapsedViewOpts,
): string[];
```

`outline()` never throws: parse errors fall back to the heuristic outliner in
`fallback.ts`.

## Supported languages

| Extension(s)              | Strategy                                                    |
|---------------------------|-------------------------------------------------------------|
| `.py`                     | `tree-sitter-python`                                        |
| `.ts`                     | `tree-sitter-typescript` (typescript grammar)               |
| `.tsx`                    | `tree-sitter-typescript` (tsx grammar)                      |
| `.js`, `.jsx`, `.mjs`, `.cjs` | `tree-sitter-javascript`                                |
| `.vue`                    | One `block` entry per top-level SFC section (`template`, `script`/`script-setup`, `style`, with `style-2`… for repeats) so the markup and styles are reachable on large files; plus the symbols inside each `<script>` block, parsed as TS (if `lang="ts"`/`"typescript"`) or JS, with line numbers offset back to the original file. |
| `.md`, `.markdown`        | Headings extracted by regex on `^(#{1,6})\s+(.+)$`, skipping fenced code blocks. |
| anything else             | Heuristic fallback (see below).                             |

Docstring extraction:

- **Python**: triple-quoted (or single-quoted) string as the first statement of
  the body of a `def`/`class`.
- **TS/JS**: nearest `/** ... */` block immediately above the declaration
  (blank lines between are tolerated).
- First non-empty line only, trimmed, capped at 80 characters
  (truncated with `...` when longer).

## Fallback behaviour

For unknown extensions, `fallback.ts` splits the file on blank lines and emits
one entry per non-empty block whose first non-whitespace character is an ASCII
letter or underscore (`/^[A-Za-z_]/`). Each entry has `kind: "block"` and uses
the trimmed first line as `name`. The fallback never throws and is also used
as a safety net if a tree-sitter parse fails.

## `hidePrivate` rule

When `hidePrivate` is true (the default), entries whose `name` starts with `_`
are dropped from the collapsed view. This is intentionally a blunt rule: it
hides both single-underscore protected names (`_foo`) and dunder names
(`__init__`, `__repr__`, ...). The motivation is that the collapsed view is
optimised for "what does this file expose?" - if a caller needs to see private
members they can either pass `hidePrivate: false` or read the relevant offset.

## Collapsed view format

Each entry renders as one line, roughly:

```
  12  class UserRepo                    Persistence for User aggregate.
  18    def get(id)                     Fetch by primary key.
```

- Line number is left-padded to align across all visible entries.
- Methods are indented by two spaces relative to their class.
- Functions and methods get a `()` suffix; classes get a `class ` prefix;
  markdown entries get a `# ` prefix.
- The doc column follows a 40-character name cell.

If the total line count would exceed `maxLines`, classes are collapsed one at
a time (largest first by method count) and replaced with:

```
  12  class UserRepo                    Persistence for User aggregate.  (8 methods - read offset=12 to expand)
```

## Local install

```bash
cd agentic/pi/extensions/_outliner
npm install
```

`node_modules/` and `package-lock.json` are git-ignored. The native tree-sitter
grammars compile during `npm install`; on a fresh machine you need a working C
toolchain.

## Consumers

- `agentic/pi/extensions/read/` - file reader with outline-on-overflow.
- `agentic/pi/extensions/search/` - repo index + structural search.
