# Claude Code Provider Extension

Provides Claude Code CLI as a Pi provider backend.

## Features

- Uses `claude -p <prompt>` command for LLM inference
- `--system-prompt` — Pi's system prompt (from `SYSTEM.md`) is passed to Claude Code
- `--dangerously-skip-permissions` enabled by default
- Model selection via `--model` flag
- `--output-format json` for accurate token/cost tracking in footer
- Full conversation history sent in prompt for context continuity
- Session ID managed per-call to avoid conflicts
- Context progress bar shows token usage vs model's context window
- Cost tracking in footer (from Claude Code JSON usage)
- Session/weekly subscription usage bars via the statusline extension's Claude `/usage` parser

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

The Pi system prompt is included in the conversation context, but Claude Code may not follow it exactly as it has its own identity and instructions.

### Session Management

Each Pi conversation turn uses a fresh Claude Code session ID. Context continuity is maintained by sending the full conversation history in the prompt.

## Requirements

- Claude Code CLI installed (`npm install -g @anthropic-ai/claude-code` or via Homebrew)
- Claude Code authenticated for your account

## Notes on Usage Tracking

### Context Progress Bar (Footer)
✅ Working — Shows current session token usage vs context window. Updates automatically as you use the model.

### Session/Weekly Usage Bars (like Codex)
Implemented by `agentic/pi/extensions/statusline`: when a `claude-code/*` model is active, the footer runs Claude Code's local `/usage` command, parses the current session and all-models weekly percentages, caches them separately from Codex quota, and renders them with the same Codex-style remaining-quota bars.

This extension itself only returns per-request usage from Claude Code JSON output (visible in footer stats ↑input ↓output and used for context accounting).
