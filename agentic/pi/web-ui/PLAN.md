# Pi Web UI — Implementation Plan

## Architecture

```
~/.pi/agent/web-ui/
├── server/
│   ├── index.ts          # FastAPI server (via Bun/FastHTML or plain FastAPI)
│   └── streams.ts        # SSE/WebSocket streaming logic
└── public/
    └── index.html        # Single-file chat UI with embedded CSS/JS
```

## Tasks

### 1. Backend Setup (server/index.ts)
- Create FastAPI app with SSE support
- Endpoint: `POST /api/chat` — submit a message, returns session ID
- Endpoint: `GET /api/stream/{session_id}` — SSE stream for token responses
- Endpoint: `GET /api/sessions` — list available sessions (from ~/.pi/agent/sessions/)
- Endpoint: `POST /api/session/{id}/switch` — switch active session
- Integrate with `pi-coding-agent` to spawn Pi processes
- Store active sessions in-memory with cleanup on disconnect

### 2. Frontend (public/index.html)
- Single HTML file with embedded CSS/JS (no build step)
- Chat interface: message list, input textarea, send button
- Syntax highlighting via Prism.js CDN
- SSE connection for streaming responses
- Session selector dropdown
- Auto-scroll, typing indicator, error handling

### 3. Integration Points
- Use existing `~/.pi/agent/sessions/` structure
- Call `pi` CLI or use `pi-coding-agent` library directly
- Respect existing `settings.json` for model/provider config
- Support worktree mode for builders (via existing subagent extension)

### 4. Configuration
- Add `webui.port` to `settings.json` (default: 8765)
- Optional: `webui.host` (default: "127.0.0.1")

## Tech Choices

**Backend:** FastHTML (bun + FastHTML) for minimal boilerplate, or plain FastAPI
- FastHTML gives us SSE out of the box
- Single-file server possible

**Frontend:** Vanilla JS + Alpine.js (optional for reactivity) + Prism.js
- Keep it under 500 lines total
- No npm install, no build step

**Streaming:** SSE (simpler than WebSocket, works over HTTP/1.1)

## Gotchas to Avoid

1. **Don't duplicate session state** — Pi already manages sessions in `~/.pi/agent/sessions/`
2. **Don't replace CLI** — web UI should be an alternative interface, not a replacement
3. **Streaming is critical** — users expect to see tokens stream in real-time
4. **Worktree isolation** — if spawning builders, ensure worktree logic is preserved
5. **Auth** — keep it local-only by default (127.0.0.1), optional config for LAN access

##下一步

Start with task 1 (backend), then task 2 (frontend), wire them together.
