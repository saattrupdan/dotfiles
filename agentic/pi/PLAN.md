# Pi token-reduction plan

Goal: enforce token limits inside tools (not prompts) so local models can't blow context even if they ignore guidance.

## Status

- ✅ Wave 0: commit agentic/ reorg on main.
- ✅ Wave 1: shared tree-sitter outliner at `agentic/pi/extensions/_outliner/`.
- ✅ Side-fix: `worktree: true` degrades gracefully outside a git repo.
- ⏳ Wave 2 (3 parallel builders, pending).
- ⏳ Wave 3: reviewer.

## Wave 2 (parallel)

**A — `read` rewrite** ✅ (`agentic/pi/extensions/read/`)
- ✅ Fixed: binary delegation to built-in, SYSTEM.md 300-char preview interception.
- 100-line hard cap on every call (model's `limit` can only request less).
- Files ≤100 lines → verbatim; >100 lines → nested outline via `_outliner` (methods under class, indented).
- Outline >100 lines → collapse classes to `(N methods — read offset=… to expand)`; hide `_*`/`__*__`.
- Slice reads (`offset`/`limit`) also capped at 100.
- Strip cat -n gutter; single `# lines A-B of <path> (N total)` header.
- Session dedupe cache (sha-based): repeat call → `unchanged since call #N`.

**B — Repo index + `search` tool** ✅ (`agentic/pi/extensions/search/`)
- ✅ Fixed: SQL injection parameterization, require → import.
- Per-repo SQLite at `~/.pi/index/<repo-id>/index.db` + `meta.json`.
- `repo-id = sha1(abs_repo_root)[:16]`; for git worktrees, resolve to common-dir parent so builders share parent's index.
- Symbols (`name, kind, file, line_start, line_end, parent`) + file manifest (`path, lines, size, language, sha`).
- Lazy build; incremental mtime refresh; opportunistic GC (>30d unused or root missing).
- Single `search(query, kind?)` tool: merges symbol-index + ripgrep results, definitions first, cap ~20 lines. Exact symbol name match → promoted with `→ read(path, offset=…)` hint. No separate `find_symbol`.

**C — Skill scoping** ✅ (`agentic/pi/extensions/subagent/` + agent files + SKILL.md taglines)
- ✅ Fixed: project overlay guard, taglines trimmed to ≤8 words.
- Add `skills: [...]` to agent frontmatter; extend `AgentConfig` + parser in `agents.ts`.
- Initial allow-lists: planner `[]`, reviewer `[commit]`, code-explorer `[]`, web-explorer `[]`, builder `[commit, python, fastapi, vue, sqlmodel, full-stack, slides, recursive-language-model, agent-browser]`.
- Emit only allow-listed skills in child's system prompt, as **name + 6-8 word tagline** (add `tagline:` field to SKILL.md frontmatter; full description stays for on-demand load).
- Mechanism: probe child pi for `--skill-paths` / `PI_SKILL_PATHS`; fallback = temp dir of symlinks to allow-listed SKILL.md's.
- Extend `subagent` tool schema with task-level `skills: [...]` override (additive).
- Repo-level overlay at `.pi/agents/<name>.md` extends user-level skills (additive).

## Wave 3

Reviewer over merged commits from Wave 2. ✅ (2 passes: first Needs changes with 10 issues → fixes → second Pass.)

## Wave 4 — Skill scoping: child-side wiring

**Goal:** Make the child pi process actually respect the allow-list so `<available_skills>` only contains the agent's permitted skills.

### Approach: temp-dir-of-symlinks (no core changes)

1. **Extension creates temp skills dir** — before spawning child, create a temp directory containing symlinks to only the allow-listed SKILL.md files.
2. **Pass `PI_SKILL_PATHS`** — set env var to point to the temp dir. The child's existing `loadSkills` already supports this.
3. **Clean up** — remove temp dir on child exit (or let OS clean up; temp dirs are short-lived).

### Files to change
- `agentic/pi/extensions/subagent/index.ts` — add the temp-dir creation + `PI_SKILL_PATHS` logic in `runSingleAgent`.
- Verify the child's `loadSkills` actually respects `PI_SKILL_PATHS` (probe `$PI/dist/core/skills.js`).

### Files to probe
- `$PI/dist/core/skills.js` L258–279 — where `<available_skills>` is generated.
- Confirm `loadSkills` accepts a `skillPaths` param and filters discovery to that path.

### Acceptance
- Spawn child with empty skill list → `<available_skills>` is empty.
- Spawn builder → only the 9 allow-listed skills appear.
- Pass `skills: ["lex-dk"]` in task → that skill appears additively.

## Wave 5 — Reviewer

Reviewer over Wave 4 commits.
