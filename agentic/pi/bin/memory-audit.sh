#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────
# memory-audit.sh — Background memory-save audit
#
# Pipeline:
#   1. Extract conversation from latest session file
#   2. Pipe to `pi --print` (no memory tools) for analysis
#   3. Parse structured output and write memory files directly
#
# Usage:
#   memory-audit.sh                  # audit current cwd session
#   memory-audit.sh /some/path       # audit a specific cwd session
#   memory-audit.sh --last           # audit the most recently-used session
#
# Designed to be run detached:
#   nohup memory-audit.sh &>/dev/null &
# ──────────────────────────────────────────────────────────

set -euo pipefail

SESSION_DIR="${SESSION_DIR:-$HOME/.pi/agent/sessions}"
MEMORY_DIR="${MEMORY_DIR:-$HOME/.pi/agent/memories}"
AUDIT_CWD="${1:-$(pwd)}"
MODE="${2:-}"

# ── Session resolution ──────────────────────────────────────

resolve_session_dir() {
  local target="$1"
  local encoded
  encoded="--$(echo "$target" | sed 's|^/||' | tr '/' '-')--"

  if [[ -d "$SESSION_DIR/$encoded" ]]; then
    echo "$SESSION_DIR/$encoded"
    return 0
  fi
  if [[ -d "$SESSION_DIR/$target" ]]; then
    echo "$SESSION_DIR/$target"
    return 0
  fi
  return 1
}

if [[ "$MODE" == "--last" ]]; then
  SESSION_PATH=$(ls -td "$SESSION_DIR"/ 2>/dev/null | head -1)
elif [[ -n "$AUDIT_CWD" ]]; then
  SESSION_PATH=$(resolve_session_dir "$AUDIT_CWD") || {
    echo "No session found for: $AUDIT_CWD" >&2
    exit 1
  }
else
  echo "Usage: memory-audit.sh [cwd|--last|--quick]" >&2
  exit 1
fi

# ── Transcript extraction ───────────────────────────────────

# Extract text content from session JSONL, producing a readable transcript
extract_transcript() {
  local session_file="$1"
  jq -r '
    select(.type == "message") |
    .message.role as $role |
    .message.content[] |
    select(.type == "text") |
    "\($role): \(.text)\n"
  ' "$session_file" 2>/dev/null || true
}

# ── Memory file writing ─────────────────────────────────────

# Write a memory file directly (bypasses memory_save tool which hangs via CLI)
write_memory() {
  local scope="$1"      # system | project
  local name="$2"        # kebab-case slug
  local description="$3" # one-line summary
  local content="$4"     # markdown body

  local dir
  if [[ "$scope" == "system" ]]; then
    dir="$MEMORY_DIR/system"
  else
    # Derive project ID from cwd
    local project_root
    project_root=$(git rev-parse --show-toplevel 2>/dev/null || echo "$PWD")
    local base hash
    base=$(basename "$project_root")
    hash=$(echo -n "$project_root" | shasum -a 256 | cut -c1-10)
    dir="$MEMORY_DIR/projects/${base}-${hash}"
  fi

  mkdir -p "$dir"
  local filepath="$dir/${name}.md"

  # Check for duplicates
  if [[ -f "$filepath" ]]; then
    return 0
  fi

  cat > "$filepath" <<MEMEOF
---
name: $name
description: $description
created_at: $(date -u +"%Y-%m-%dT%H:%M:%S.000Z")
---

$content
MEMEOF

  echo "$scope/$name"
}

# ── Main ────────────────────────────────────────────────────

# Get the latest session file
LATEST_SESSION=$(ls -1 "$SESSION_PATH"/*.jsonl 2>/dev/null | sort | tail -1)
if [[ ! -f "$LATEST_SESSION" ]]; then
  echo "No session file found in $SESSION_PATH" >&2
  exit 0
fi

# Extract transcript
TRANSCRIPT=$(extract_transcript "$LATEST_SESSION")

if [[ -z "$TRANSCRIPT" ]]; then
  echo "No transcript content" >&2
  exit 0
fi

# Run pi for analysis — no memory tools, just text analysis
# Force machine-parseable output with strict format
ANALYSIS=$(pi \
  --no-session \
  --no-extensions \
  --no-skills \
  --no-context-files \
  --print \
  "OUTPUT FORMAT RULES:
- Output ONLY pipe-delimited lines: scope|name|description|content
- No markdown, no explanations, no headers
- If nothing to save, output exactly: NONE
- Each line: scope|name|description|content
- scope: system or project
- name: lowercase kebab-case (a-z 0-9 - _), max 64 chars
- description: one-line summary (<80 chars)
- content: markdown body (may contain pipes escaped as |)

EXAMPLE OUTPUT:
system|tool-error-cli-memory-tools|memory_* unavailable via direct CLI|The memory tools work in orchestrator context but hang when invoked via pi --print.
system|preference-delegation|Prefer subagent delegation for non-trivial work|User prefers delegating work to subagents rather than doing it themselves.

Conversation:
$TRANSCRIPT" 2>&1)

# Parse results — filter for valid pipe-delimited lines only
# Strip blank lines, comments, and non-conforming lines
CLEAN=$(echo "$ANALYSIS" | grep -E '^[a-z]+\|[a-z0-9_-]+\|.*\|' 2>/dev/null || true)

if [[ -z "$CLEAN" ]]; then
  echo "Nothing to save"
  exit 0
fi

SAVED=0
while IFS='|' read -r scope name description content; do
  # Validate format: scope must be system or project
  if [[ "$scope" != "system" ]] && [[ "$scope" != "project" ]]; then
    continue
  fi
  if [[ -z "$name" ]] || [[ -z "$description" ]]; then
    continue
  fi
  result=$(write_memory "$scope" "$name" "$description" "$content" 2>/dev/null) && {
    echo "Saved: $result"
    SAVED=$((SAVED + 1))
  }
done <<< "$CLEAN"

if [[ $SAVED -eq 0 ]]; then
  echo "No items saved (no valid items found)"
fi
