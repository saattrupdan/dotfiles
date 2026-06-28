#!/usr/bin/env python3
"""Telegram bridge for Pi agent.

Usage:
    uv add python-telegram-bot aiohttp
    export TELEGRAM_BOT_TOKEN="your-token-here"
    export ALLOWED_USER_IDS="123456789,987654321"
    uv run src/scripts/bridge.py
"""

import asyncio
import json
import logging
import os
import subprocess
import uuid
from pathlib import Path
from typing import Any

from telegram import Update
from telegram.ext import Application, MessageHandler, filters

# Configuration
BOT_TOKEN_ENV = "TELEGRAM_BOT_TOKEN"
ALLOWED_USER_IDS_ENV = "ALLOWED_USER_IDS"
SESSION_FILE = Path(__file__).parent.parent / "sessions.json"
MAX_HISTORY_LENGTH = 20
MAX_RESPONSE_LENGTH = 4096
TELEGRAM_SESSION_ID = "telegram"  # Fixed session ID for Telegram

# Commands (natural language, no slashes)
COMMANDS: set[str] = {"clear"}

logger = logging.getLogger(__name__)


def load_sessions() -> dict[str, dict[str, Any]]:
    """Load session state from disk."""
    if SESSION_FILE.exists():
        with open(SESSION_FILE) as f:
            return json.load(f)
    return {}


def save_sessions(sessions: dict[str, dict[str, Any]]) -> None:
    """Save session state to disk."""
    with open(SESSION_FILE, "w") as f:
        json.dump(sessions, f, indent=2)


def get_session(user_id: int) -> dict[str, Any]:
    """Get or create session for user."""
    sessions = load_sessions()
    user_key = str(user_id)
    if user_key not in sessions:
        sessions[user_key] = {
            "cwd": str(Path.home() / "gitsky" / "dotfiles"),
            "history": [],
            "session_id": TELEGRAM_SESSION_ID,  # Fixed session ID
        }
        save_sessions(sessions)
    return sessions[user_key]


def truncate_response(text: str) -> str:
    """Truncate response for mobile brevity."""
    if len(text) > 300:
        breakpoint_pos = text[:300].rfind("\n")
        if breakpoint_pos == -1:
            breakpoint_pos = 300
        return text[:breakpoint_pos] + "\n\n... (check laptop for full details)"
    return text


def call_pi(
    prompt: str, cwd: str, session_id: str, history: list[dict[str, str]]
) -> str:
    """Call Pi agent with the given prompt and history.

    Args:
        prompt:
            User's message text.
        cwd:
            Working directory for Pi.
        session_id:
            Session ID to use (creates if missing).
        history:
            Conversation history as list of {role, content} dicts.

    Returns:
        Pi's response text.
    """
    full_prompt = []
    for msg in history[-MAX_HISTORY_LENGTH:]:
        role = "User" if msg["role"] == "user" else "Assistant"
        full_prompt.append(f"{role}: {msg['content']}")
    full_prompt.append(f"User: {prompt}")

    full_text = "\n".join(full_prompt)

    try:
        result = subprocess.run(
            ["pi", "--no-interactive", "--session-id", session_id],
            input=full_text,
            capture_output=True,
            text=True,
            cwd=cwd,
            timeout=120,
        )
        return result.stdout.strip() or result.stderr.strip() or "No response from Pi"
    except subprocess.TimeoutExpired:
        return "Pi timed out (took too long)"
    except FileNotFoundError:
        return "Error: 'pi' command not found. Ensure Pi CLI is installed."
    except Exception as e:
        return f"Error calling Pi: {e}"


async def handle_command(update: Update, context: Any) -> None:
    """Handle natural language commands."""
    if not update.effective_user or not update.message:
        return

    user_id = update.effective_user.id if update.effective_user else None
    if user_id is None:
        return

    allowed_ids_str = os.environ.get(ALLOWED_USER_IDS_ENV, "")
    allowed_ids = {int(x.strip()) for x in allowed_ids_str.split(",") if x.strip()}

    if user_id not in allowed_ids:
        await update.message.reply_text("Not authorised")
        return

    text_raw = update.message.text
    if not text_raw:
        return

    text = text_raw.strip().lower()
    session = get_session(user_id)

    if text == "clear":
        # Generate new session ID to start fresh
        new_session_id = str(uuid.uuid4())
        session["history"] = []
        session["session_id"] = new_session_id
        save_sessions({str(user_id): session})
        await update.message.reply_text(
            f"✓ History cleared (new session: {new_session_id[:8]}...)"
        )
        return

    # Not a recognised command - forward to Pi
    await handle_message_to_pi(update, context)


async def handle_message_to_pi(update: Update, context: Any) -> None:
    """Forward message to Pi and reply with response."""
    if not update.effective_user or not update.message:
        return

    user_id = update.effective_user.id if update.effective_user else None
    if user_id is None:
        return

    allowed_ids_str = os.environ.get(ALLOWED_USER_IDS_ENV, "")
    allowed_ids = {int(x.strip()) for x in allowed_ids_str.split(",") if x.strip()}

    if user_id not in allowed_ids:
        return

    text_raw = update.message.text
    if not text_raw:
        return

    session = get_session(user_id)

    await update.message.reply_chat_action(action="typing")

    loop = asyncio.get_event_loop()
    response = await loop.run_in_executor(
        None,
        lambda: call_pi(
            text_raw, session["cwd"], session["session_id"], session["history"]
        ),
    )

    response = truncate_response(response)
    await update.message.reply_text(response)

    session["history"].append({"role": "user", "content": text_raw})
    session["history"].append({"role": "assistant", "content": response})
    save_sessions({str(user_id): session})


async def main() -> None:
    """Initialise and run the bot."""
    bot_token = os.environ.get(BOT_TOKEN_ENV)
    if not bot_token:
        logger.error("TELEGRAM_BOT_TOKEN not set")
        return

    allowed_ids_str = os.environ.get(ALLOWED_USER_IDS_ENV, "")
    allowed_ids = {int(x.strip()) for x in allowed_ids_str.split(",") if x.strip()}
    if not allowed_ids:
        logger.error("ALLOWED_USER_IDS not set")
        return

    app = Application.builder().token(bot_token).build()
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_command))

    logger.info(f"Starting bot... (allowed users: {allowed_ids})")

    await app.initialize()
    await app.start()
    if app.updater:
        await app.updater.start_polling(allowed_updates=Update.ALL_TYPES)

    logger.info("Bot is running. Press Ctrl+C to stop.")
    try:
        while True:
            await asyncio.sleep(1)
    except KeyboardInterrupt:
        pass
    finally:
        if app.updater:
            await app.updater.stop()
        await app.stop()
        await app.shutdown()


if __name__ == "__main__":
    asyncio.run(main())
