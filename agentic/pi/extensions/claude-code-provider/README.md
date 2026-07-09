# Claude Code Provider Extension

Provides Claude Code CLI as a Pi provider backend.

## Features

- Uses `claude -p <prompt>` command for LLM inference
- **Uses Claude Code's native session mechanism** for conversation continuity
- `--system-prompt` — Pi's system prompt (from `SYSTEM.md`) is passed to Claude Code **only via this flag** (not duplicated in the prompt)
- `--dangerously-skip-permissions` enabled by default
- Model selection via `--model` flag
- `--output-format json` for accurate token/cost tracking in footer
- **Session ID keyed to Pi session file** — isolated across Pi sessions, subagents, parallel calls
- **Process-start random salt** prevents PID reuse collisions
- **Per-session mutex queue** prevents concurrent session ID conflicts
- Context progress bar shows token usage vs model's context window
- Cost tracking in footer (from Claude Code JSON usage)
- Session/weekly subscription usage bars via the statusline extension's Claude `/usage` parser

## Session Strategy

The extension generates a **session ID per Pi session** using:

1. **Pi session file path** (primary) or `sessionId` (fallback) — not PID
2. **Process-start random salt** — prevents collisions when PIDs are reused
3. **SHA256 hash** → UUID v4 format

```
<uuid-v4-format-derived-from-session-file+cwd+salt>
```

This ensures:

- **Different Pi sessions get different session IDs** — keyed to session file, not process
- **Parent process and subagents share the same Pi session ID** — same session file
- **Different working directories get different session IDs** — cwd mixed into hash
- **Process restarts with same Pi session get same ID** — session file unchanged
- **Process-start salt prevents PID reuse attacks** — fresh salt each module load
- **Concurrent calls with same session ID are serialised** — mutex queue prevents conflicts

### Continuity Limits

**Important:** Conversation continuity is **limited to the current Pi session**:

- ✅ **Same Pi session, multiple turns** — Claude Code retains history
- ✅ **Subagents in same Pi session** — share Claude Code session via same session file
- ❌ **Provider switch** — switching to a different provider breaks continuity
- ❌ **`pi --continue` in new process** — if it loads a different Pi session file, new Claude Code session
- ❌ **`/new` or session switch** — new Pi session file = fresh Claude Code session
- ❌ **Previous Pi session history** — not sent to Claude Code (only latest message per turn)

The extension does **not** attempt to replay full Pi conversation history to Claude Code. It sends only the latest user message per turn, relying on Claude Code's session storage for continuity within the same active session.

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

### Error Handling

Nonzero exit codes from Claude Code CLI are treated as errors. JSON error output is parsed and surfaced in the error message. The extension does not treat Claude Code error responses as normal assistant messages.

### Session Management

- Session ID is keyed to Pi session file path (not PID)
- Process-start random salt prevents PID reuse collisions
- Per-session mutex queue serialises concurrent calls
- Claude Code maintains conversation history in its session storage (`~/.claude/` by default)
- Only the latest user message is sent per turn (not full Pi history)
- Continuity limited to current Pi session — provider switches or session changes break continuity

## Requirements

- Claude Code CLI installed (`npm install -g @anthropic-ai/claude-code` or via Homebrew)
- Claude Code authenticated for your account

## Notes on Usage Tracking

### Context Progress Bar (Footer)
✅ Working — Shows current session token usage vs context window. Updates automatically as you use the model.

### Session/Weekly Usage Bars (like Codex)
Implemented by `agentic/pi/extensions/statusline`: when a `claude-code/*` model is active, the footer runs Claude Code's local `/usage` command, parses the current session and all-models weekly percentages, caches them separately from Codex quota, and renders them with the same Codex-style remaining-quota bars.

This extension itself only returns per-request usage from Claude Code JSON output (visible in footer stats ↑input ↓output and used for context accounting).
