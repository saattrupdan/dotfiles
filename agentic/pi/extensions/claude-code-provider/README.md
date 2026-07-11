# Claude Code Provider Extension

Provides Claude Code CLI as a Pi provider backend.

## Features

- Uses `claude -p <prompt>` command for LLM inference
- **Uses Claude Code's native session mechanism** for conversation continuity
- `--system-prompt` — Pi's system prompt (from `SYSTEM.md`) is passed to Claude Code **only via this flag** (not duplicated in the prompt)
- `--tools ""` — Disables Claude Code's built-in tools
- **Pi's tools passed via system prompt augmentation** so the model can call them
- `--dangerously-skip-permissions` enabled by default
- Model selection via `--model` flag
- `--output-format stream-json --verbose --include-partial-messages` for realtime
  streaming and token/cost tracking in footer
- **Session ID keyed to the first user message and cwd** for conversation continuity
- **Per-session mutex queue** prevents concurrent session ID conflicts
- **Retry order: `--resume` first, then `--session-id` on "No conversation found"**
- Context progress bar shows token usage vs model's context window
- Cost tracking in footer (from Claude Code stream result usage)
- Session/weekly subscription usage bars via the statusline extension's Claude `/usage` parser

## Session Strategy

The extension generates a **Claude Code session ID per Pi conversation** using the
provider context available to `streamSimple`:

1. First user message timestamp and content hash
2. Current working directory
3. SHA256 hash → UUID v4-shaped string

```text
<uuid-v4-format-derived-from-first-user-message+cwd>
```

`streamSimple` receives `pi-ai`'s provider `Context`, not Pi's
`ExtensionContext`, so it cannot read `ctx.sessionManager` or the Pi session file.
Keying from the first user message isolates `/new` sessions while still allowing
`pi --continue` to reuse the same Claude Code session when Pi preserves the saved
message timestamps.

This ensures:

- **Different `/new` sessions get different IDs** — the first user message changes
- **Different working directories get different IDs** — cwd is mixed into the hash
- **Process restarts can reuse the same ID** — no PID or process salt is required
- **Concurrent calls with the same ID are serialised** — a mutex queue prevents
  active-session conflicts

### Retry Order

For follow-up turns, the provider tries to resume an existing session first:

1. **First attempt:** `--resume <session-id>` — continues an existing session
2. **On "No conversation found":** retries with `--session-id <session-id>` — creates a new session
3. **On "already in use"** (rare with resume-first): also retries with `--session-id`
4. **Other errors:** surfaced immediately

The retry only happens if the first attempt emitted **no Pi events or text**. If
anything was streamed before the error, the original error is surfaced to avoid
duplicating output. The per-session mutex is held across both attempts.

**Why resume-first?** Most turns are follow-ups to an existing Claude session. Trying
`--resume` first avoids an unnecessary failed `--session-id` attempt in the common case.

### Continuity Limits

**Important:** Claude Code continuity only exists after this provider has handled a
turn for the derived session ID:

- ✅ **Same Pi conversation, multiple Claude Code turns** — Claude Code retains
  history
- ✅ **`pi --continue` with preserved message timestamps** — derives the same ID
- ❌ **Provider switch before Claude Code has seen the conversation** — old Pi
  history is not replayed
- ❌ **`/new` or session switch** — new first user message = fresh Claude Code
  session
- ❌ **Previous Pi history not already in Claude Code** — only the latest user
  message is sent per turn

The extension does **not** replay full Pi conversation history to Claude Code on
every turn. It sends only the latest user message, relying on Claude Code's session
storage for continuity after the first provider-handled turn.

## Models

Available models match what Claude Code CLI provides:

- `claude-sonnet-5` - Claude Sonnet 5
- `claude-opus-4-8` - Claude Opus 4.8
- `claude-fable-5` - Claude Fable 5
- `claude-haiku-4-5-20251001` - Claude Haiku 4.5

## Usage

1.  Ensure Claude Code CLI is installed and authenticated:
   ```bash
   claude --version
   claude login  # if needed
   ```

2.  Load the extension:

    ```bash
    pi -e ~/.pi/agent/extensions/claude-code-provider
    ```

3.  Select a model:

    ```bash
    /model claude-code/claude-sonnet-5
    ```

## Streaming

The provider streams Claude Code output in real time using JSONL format.

### CLI Flags

Streaming requires three flags:

- `--output-format stream-json` — enables JSONL streaming output
- `--verbose` — required when using `stream-json` in `--print` mode
- `--include-partial-messages` — required for token-level text deltas

### Event Format

Claude Code writes newline-delimited JSON records. The provider parses and
filters these events:

- **`stream_event`** — streaming delta records. The provider yields visible text
  from records where:
  - `event.type === "content_block_delta"`
  - `event.delta.type === "text_delta"`
  - `event.delta.text` contains the text to display
- **`assistant`** — snapshot records. Ignored by the provider to avoid duplicate
  output alongside streaming deltas.
- **`result`** — final record containing usage, cost, result, and stop reason.
  Used for footer stats and context accounting.

### Limitations

- Streaming currently exposes only visible text deltas.
- Thinking trace events and tool-call stream events from Claude Code are not
  surfaced as Pi thinking or tool calls. This may be added in a future version.
- The provider sends only the latest user message per turn, using Claude Code's
  `--session-id` for history continuity (see Session Strategy).
- On follow-up turns, if Claude rejects `--resume` with "No conversation found", the
  provider automatically retries with `--session-id` **only if the failed attempt emitted
  no Pi events or text**. If anything was streamed before the error, the original
  error is surfaced to avoid duplicating output.

## Important Notes

### Pi Tool Integration

Claude Code's built-in tools are disabled via `--tools ""`. Pi's tools are passed to the model via system prompt augmentation:
- Pi tool definitions are appended to the system prompt
- Model sees Pi's tools and can call them
- Tool calls in Claude Code format are parsed and returned to Pi
- Pi executes the actual tool calls

### System Prompt

The Pi system prompt is passed **only via `--system-prompt`** to avoid duplication. Claude Code may not follow it exactly as it has its own identity and instructions.

### Error Handling

Nonzero exit codes from Claude Code CLI are treated as errors. Stream `result`
records with `is_error` are surfaced as errors rather than normal assistant messages.

### Session Management

- Session ID is keyed to the first user message and cwd, not PID
- Per-session mutex queue serialises concurrent calls
- First attempt uses `--resume`; follow-ups create new sessions with `--session-id` when
  Claude reports "No conversation found" **and the failed attempt emitted nothing**
- Retry logic keeps the per-session mutex held across both attempts to prevent race
  conditions
- If the failed `--resume` attempt emitted any Pi events or text, the retry is
  skipped and the original error is surfaced (avoids output duplication)
- Claude Code maintains conversation history in its session storage (`~/.claude/` by
  default)
- Only the latest user message is sent per turn (not full Pi history)
- Continuity is limited to turns Claude Code has already handled for the derived
  session ID

### Slash Commands

The provider automatically forwards slash commands to Claude Code CLI when using a `claude-code` model.

**How it works:**
- Messages starting with `/command` (like `/help`, `/editor`, `/plan`) are detected in `streamClaudeCode()` and sent to Claude Code
- The detection regex `/^\/[A-Za-z][\w:-]*(?:\s|$)/` matches slash commands while avoiding absolute paths like `/tmp/foo`
- Claude Code's response (including `type: "assistant"` stream records) is extracted from `message.content[]` blocks and displayed in Pi

**Commands that work:**
- `/help`, `/editor`, `/plan`, `/context`, and other Claude Code commands that Pi doesn't intercept
- `/cc-compact` — compacts the Claude Code conversation context (uses `/cc-` prefix to avoid Pi's built-in `/compact`)

**Commands that DON'T work (`/new`):**

Pi's built-in slash commands are intercepted by Pi's TUI **before** reaching the provider:
- `/new` in Pi starts a new Pi session (not a Claude Code session)

These cannot be overridden by the extension because Pi processes them at the orchestrator level.

**Workaround for `/new`:**

Use Claude Code CLI directly in a terminal:
```bash
claude                     # Start interactive session
# Then type: /new          # Start new session
```

Claude Code slash commands require an interactive terminal - they don't work with piped input or `--print` mode.

## Requirements

- Claude Code CLI installed (`npm install -g @anthropic-ai/claude-code` or via Homebrew)
- Claude Code authenticated for your account

## Notes on Usage Tracking

### Context Progress Bar (Footer)
✅ Working — Shows current session token usage vs context window. Updates automatically as you use the model.

### Session/Weekly Usage Bars (like Codex)
Implemented by `agentic/pi/extensions/statusline`: when a `claude-code/*` model is active, the footer runs Claude Code's local `/usage` command, parses the current session and all-models weekly percentages, caches them separately from Codex quota, and renders them with the same Codex-style remaining-quota bars.

This extension itself only returns per-request usage from the Claude Code stream result
(visible in footer stats ↑input ↓output and used for context accounting).
