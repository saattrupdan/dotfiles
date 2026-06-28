"""
Pi Web UI — FastAPI server with SSE streaming

Provides a minimal web interface for interacting with the Pi agent harness.
"""

import asyncio
import json
import os
import sys
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import AsyncGenerator, Dict, Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLFileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
import uvicorn

# Pi agent config location
PI_AGENT_DIR = Path(os.environ.get("PI_AGENT_DIR", Path.home() / ".pi/agent"))
SESSIONS_DIR = PI_AGENT_DIR / "sessions"
SETTINGS_FILE = PI_AGENT_DIR / "settings.json"

# Import pi-coding-agent for actual Pi execution
try:
    from pi_coding_agent import PicodingAgent
    PI_AVAILABLE = True
except ImportError:
    PI_AVAILABLE = False
    print("Warning: pi-coding-agent not installed, running in mock mode")

@dataclass
class SessionState:
    """Tracks state for an active web session."""
    id: str
    cwd: str  # Working directory for this session
    created_at: datetime = field(default_factory=datetime.now)
    last_activity: datetime = field(default_factory=datetime.now)
    message_history: list[dict] = field(default_factory=list)


class SessionManager:
    """Manages active web UI sessions."""
    
    def __init__(self):
        self.sessions: Dict[str, SessionState] = {}
        self.stream_queues: Dict[str, asyncio.Queue] = {}
    
    def create_session(self, cwd: str) -> SessionState:
        session_id = str(uuid.uuid4())[:8]
        session = SessionState(id=session_id, cwd=cwd)
        self.sessions[session_id] = session
        self.stream_queues[session_id] = asyncio.Queue()
        return session
    
    def get_session(self, session_id: str) -> Optional[SessionState]:
        return self.sessions.get(session_id)
    
    def get_queue(self, session_id: str) -> Optional[asyncio.Queue]:
        return self.stream_queues.get(session_id)
    
    async def put_token(self, session_id: str, token: str):
        """Push a token to a session's stream queue."""
        if session_id in self.stream_queues:
            await self.stream_queues[session_id].put(token)
    
    async def put_done(self, session_id: str):
        """Signal end of stream."""
        if session_id in self.stream_queues:
            await self.stream_queues[session_id].put(None)
    
    def list_sessions(self) -> list[dict]:
        """List all active sessions with metadata."""
        return [
            {
                "id": s.id,
                "cwd": s.cwd,
                "created": s.created_at.isoformat(),
                "last_activity": s.last_activity.isoformat(),
                "message_count": len(s.message_history),
            }
            for s in self.sessions.values()
        ]
    
    def cleanup(self, session_id: str):
        """Remove a session."""
        self.sessions.pop(session_id, None)
        self.stream_queues.pop(session_id, None)


# Initialize FastAPI app
app = FastAPI(title="Pi Web UI", version="0.1.0")

# Enable CORS for local development
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Session manager
session_manager = SessionManager()


def load_settings() -> dict:
    """Load Pi settings.json."""
    if SETTINGS_FILE.exists():
        with open(SETTINGS_FILE) as f:
            return json.load(f)
    return {}


async def run_pi_message(session_id: str, message: str, cwd: str) -> None:
    """Run a Pi agent message and stream tokens."""
    try:
        if PI_AVAILABLE:
            # Use pi-coding-agent library
            agent = PicodingAgent(cwd=cwd)
            # This is a simplified integration - real implementation would need
            # to hook into the agent's token stream
            response = await agent.run(message)
            for token in response:
                await session_manager.put_token(session_id, token)
        else:
            # Mock mode: simulate streaming response
            mock_response = f"[Mock Pi] Received: {message}\n\nThis is a placeholder response. Install pi-coding-agent for real functionality."
            for char in mock_response:
                await session_manager.put_token(session_id, char)
                await asyncio.sleep(0.01)  # Simulate token delay
    except Exception as e:
        error_msg = f"\n\n**Error:** {type(e).__name__}: {e}"
        for char in error_msg:
            await session_manager.put_token(session_id, char)
            await asyncio.sleep(0.01)
    finally:
        await session_manager.put_done(session_id)


@app.get("/")
async def serve_index():
    """Serve the main chat UI."""
    index_path = Path(__file__).parent / "public" / "index.html"
    if not index_path.exists():
        raise HTTPException(status_code=404, detail="index.html not found")
    return HTMLFileResponse(index_path)


@app.get("/api/sessions")
async def list_sessions():
    """List all active sessions."""
    return {"sessions": session_manager.list_sessions()}


@app.post("/api/session")
async def create_session(request: dict):
    """Create a new session."""
    cwd = request.get("cwd", str(Path.home()))
    session = session_manager.create_session(cwd)
    return {"session_id": session.id, "cwd": session.cwd}


@app.post("/api/chat")
async def chat(request: dict):
    """Submit a message and start streaming response."""
    session_id = request.get("session_id")
    message = request.get("message", "").strip()
    
    if not message:
        raise HTTPException(status_code=400, detail="Message required")
    
    if not session_id:
        # Create a new session if none provided
        cwd = request.get("cwd", str(Path.cwd()))
        session = session_manager.create_session(cwd)
        session_id = session.id
    
    session = session_manager.get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    
    # Add message to history
    session.message_history.append({"role": "user", "content": message})
    session.last_activity = datetime.now()
    
    # Start streaming in background
    asyncio.create_task(run_pi_message(session_id, message, session.cwd))
    
    return {"session_id": session_id, "status": "streaming"}


@app.get("/api/stream/{session_id}")
async def stream_response(session_id: str) -> StreamingResponse:
    """SSE stream for token responses."""
    queue = session_manager.get_queue(session_id)
    if not queue:
        raise HTTPException(status_code=404, detail="Session not found")
    
    async def generate() -> AsyncGenerator[str, None]:
        while True:
            token = await queue.get()
            if token is None:
                yield "data: [DONE]\n\n"
                break
            # Escape data for SSE
            escaped = token.replace("\n", "\\n").replace("\r", "\\r")
            yield f"data: {escaped}\n\n"
    
    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@app.delete("/api/session/{session_id}")
async def delete_session(session_id: str):
    """Delete a session."""
    session_manager.cleanup(session_id)
    return {"status": "deleted"}


def main():
    """Run the server."""
    settings = load_settings()
    webui_config = settings.get("webui", {})
    host = webui_config.get("host", "127.0.0.1")
    port = webui_config.get("port", 8765)
    
    print(f"🚀 Pi Web UI starting on http://{host}:{port}")
    print(f"   Sessions dir: {SESSIONS_DIR}")
    print(f"   PI_AVAILABLE: {PI_AVAILABLE}")
    
    uvicorn.run(app, host=host, port=port, log_level="info")


if __name__ == "__main__":
    main()
