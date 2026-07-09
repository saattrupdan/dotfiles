# Claude Code Provider Extension

Provides Claude Code CLI as a Pi provider backend.

## Features

- Uses `claude -p <prompt>` command for LLM inference
- **Uses Claude Code's native session mechanism** for conversation continuity
- `--system-prompt` — Pi's system prompt (from `SYSTEM.md`) is passed to Claude Code **only via this flag** (not duplicated in the prompt)
- `--dangerously-skip-permissions` enabled by default
- Model selection via `--model` flag
- `--output-format json` for accurate token/cost tracking in footer
- **Deterministic session ID per process + cwd** — isolated across subagents/parallel calls
- Context progress bar shows token usage vs model's context window
- Cost tracking in footer (from Claude Code JSON usage)
- Session/weekly subscription usage bars via the statusline extension's Claude `/usage` parser

## Session Strategy

The extension uses a **deterministic UUID v4 session ID** derived from `process.pid` + `cwd`:

```
<uuid-v4-format-derived-from-pid-and-cwd>
```

This ensures:

- **Parent process and subagents have different session IDs** (different PIDs)
- **Different working directories get different session IDs**
- **Session ID does NOT persist across process restarts** (new PID = new session ID)

**Important semantics:** This is **process-level isolation only**, not Pi session persistence. A `pi --continue` that spawns a new process will get a new session ID. Claude Code's session storage persists on disk, but Pi does not track or reuse session IDs across its own session boundaries.

Claude Code maintains conversation history in its session storage on disk. Each Pi turn sends only the latest user message (not the full conversation history), relying on Claude Code's session mechanism for context continuity.

## Models

Available models match what Claude Code CLI provides:

- `claude-sonnet-5` - Claude Sonnet 5
- `claude-opus-4-8` - Claude Opus 4.8
- `claude-fable-5` - Claude Fable 5
- `claude-haiku-4-5-20251001` - Claude Haiku 4.5

## Usage

1. Ensure Claude Code CLI is installed and authenticated:
   ```bash
   claude --version
   claude login  # if needed
   ```

2. Load the extension:
   ```bash
   pi -e ~/.pi/agent/extensions/claude-code-provider
   ```

3. Select a model:
   ```bash
   /model claude-code/claude-sonnet-5
   ```

## Important Notes

### No Pi Tool Integration

Claude Code has its own built-in tools. This provider:
- Does NOT pass Pi tool definitions to Claude Code
- Does NOT execute Pi tools from Claude Code responses
- Parses Claude Code tool call syntax but doesn't action them

### System Prompt

The Pi system prompt is passed **only via `--system-prompt`** to avoid duplication. Claude Code may not follow it exactly as it has its own identity and instructions.

### Session Management

- Session ID is a deterministic UUID v4 per process + working directory
- Claude Code maintains conversation history in its session storage (`~/.claude/` by default)
- Only the latest user message is sent per turn (not full Pi history)
- Parallel subagents get isolated sessions (different PIDs + worktrees)
- **Session ID does not persist across `pi --continue` or process restarts** (new PID = new session)

## Requirements

- Claude Code CLI installed (`npm install -g @anthropic-ai/claude-code` or via Homebrew)
- Claude Code authenticated for your account

## Notes on Usage Tracking

### Context Progress Bar (Footer)
✅ Working — Shows current session token usage vs context window. Updates automatically as you use the model.

### Session/Weekly Usage Bars (like Codex)
Implemented by `agentic/pi/extensions/statusline`: when a `claude-code/*` model is active, the footer runs Claude Code's local `/usage` command, parses the current session and all-models weekly percentages, caches them separately from Codex quota, and renders them with the same Codex-style remaining-quota bars.

This extension itself only returns per-request usage from Claude Code JSON output (visible in footer stats ↑input ↓output and used for context accounting).
