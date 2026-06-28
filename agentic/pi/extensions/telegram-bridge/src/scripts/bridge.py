#!/usr/bin/env python3
"""Telegram bridge for Pi agent.

Usage:
    # Configure ~/.env with TELEGRAM_BRIDGE_ENABLED=true, token, and user ID
    uv run src/scripts/bridge.py

Or use the setup script for systemd deployment:
    ./setup-systemd.sh
"""

import asyncio
import json
import logging
import math
import os
import subprocess
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from dotenv import load_dotenv
from telegram import Update
from telegram.ext import Application, MessageHandler, filters

# Load environment variables from ~/.env (global config)
HOME_ENV_FILE = Path.home() / ".env"
if HOME_ENV_FILE.exists():
    load_dotenv(HOME_ENV_FILE)

# Configuration
BOT_TOKEN_ENV = "TELEGRAM_BOT_TOKEN"
ALLOWED_USER_IDS_ENV = "ALLOWED_USER_IDS"
ENABLE_BRIDGE_ENV = "TELEGRAM_BRIDGE_ENABLED"
SESSION_FILE = Path(__file__).parent.parent / "sessions.json"
MAX_HISTORY_LENGTH = 20
MAX_RESPONSE_LENGTH = 4096
TELEGRAM_SESSION_ID = "telegram"  # Fixed session ID for Telegram

# Commands (natural language, no slashes)
COMMANDS: set[str] = {"clear", "status", "compact"}

# Enable logging to stderr for systemd journal
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)

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
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        save_sessions(sessions)
    return sessions[user_key]


def truncate_response(text: str) -> str:
    """Truncate response for mobile brevity."""
    if len(text) > 500:
        breakpoint_pos = text[:500].rfind("\n")
        if breakpoint_pos == -1:
            breakpoint_pos = 500
        return text[:breakpoint_pos] + "\n\n… (ask for more)"
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
    # Telegram-specific system instruction: prioritise brevity for mobile
    telegram_instruction = """[Telegram mode: You're chatting with a user on mobile via Telegram. Keep responses short and scannable – aim for 2-4 sentences max unless they explicitly ask for details. Use bullet points over paragraphs. Skip explanations of obvious steps. End with an offer to expand if needed (e.g. "Want more detail?"). Never send walls of text.]"""
    
    full_prompt = [telegram_instruction]
    for msg in history[-MAX_HISTORY_LENGTH:]:
        role = "User" if msg["role"] == "user" else "Assistant"
        full_prompt.append(f"{role}: {msg['content']}")
    full_prompt.append(f"User: {prompt}")

    full_text = "\n".join(full_prompt)

    # Fix path if sessions.json got synced across machines
    if cwd.startswith("/Users/"):
        # macOS to Linux
        cwd = cwd.replace("/Users/dansmart/gitsky/", str(Path.home()) + "/")
    elif "/gitsky/" in cwd:
        # Linux to Linux (remove gitsky from path)
        cwd = cwd.replace("/gitsky/", "/")

    # Call pi via bash with nvm loaded (handles any node version)
    nvm_dir = Path.home() / ".nvm"
    nvm_script = nvm_dir / "nvm.sh"

    # Debug logging
    logger.info(f"call_pi: nvm_dir={nvm_dir}, exists={nvm_dir.exists()}")
    logger.info(f"call_pi: nvm_script={nvm_script}, exists={nvm_script.exists()}")

    if not nvm_script.exists():
        return "Error: nvm not found."

    # Find latest node 24.x version (compatible with native modules)
    nvm_versions = nvm_dir / "versions" / "node"
    node_version = None
    if nvm_versions.exists():
        # Prefer v24.x for compatibility, otherwise latest
        v24_versions = [d.name for d in nvm_versions.iterdir() if d.is_dir() and d.name.startswith("v24.")]
        all_versions = [d.name for d in nvm_versions.iterdir() if d.is_dir()]
        if v24_versions:
            node_version = sorted(v24_versions, reverse=True)[0]
        elif all_versions:
            node_version = sorted(all_versions, reverse=True)[0]

    logger.info(f"call_pi: nvm_versions={nvm_versions}, exists={nvm_versions.exists()}, node_version={node_version}")

    if not node_version:
        return "Error: No node version found in nvm."

    # Build bash command that loads nvm and runs pi
    # nvm output goes to stderr (2>&1), pi output is captured in stdout
    pi_cmd = f"""source {nvm_script} >/dev/null 2>&1 && nvm use {node_version} >/dev/null 2>&1 && pi -p --session-id {session_id}"""

    logger.info(f"call_pi: cwd={cwd}, pi_cmd={pi_cmd[:100]}...")

    try:
        result = subprocess.run(
            ["bash", "-c", pi_cmd],
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
        return "Error: 'pi' command not found. Check nvm/node installation."
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
        session["created_at"] = datetime.now(timezone.utc).isoformat()
        save_sessions({str(user_id): session})
        await update.message.reply_text(
            f"✓ History cleared (new session: {new_session_id[:8]}...)"
        )
        return

    if text == "status":
        history = session.get("history", [])
        history_count = len(history)
        usage_pct = (history_count / MAX_HISTORY_LENGTH) * 100

        created_at_str = session.get("created_at")
        if created_at_str:
            try:
                created_at = datetime.fromisoformat(created_at_str)
                start_time = created_at.strftime("%Y-%m-%d %H:%M UTC")
            except ValueError:
                start_time = "Unknown"
        else:
            start_time = "Unknown"

        # Round usage to nearest 5% for cleaner display
        usage_rounded = math.ceil(usage_pct / 5) * 5 if usage_pct > 0 else 0

        status_msg = (
            f"📊 Session status\n"
            f"Messages: {history_count}/{MAX_HISTORY_LENGTH} ({usage_rounded}%)\n"
            f"Started: {start_time}"
        )
        await update.message.reply_text(status_msg)
        return

    if text == "compact":
        # Run /compact command in Pi to compress session history
        await update.message.reply_chat_action(action="typing")
        loop = asyncio.get_event_loop()
        call_pi(
            "/compact", session["cwd"], session["session_id"], session["history"]
        )
        # Just acknowledge - don't show Pi's full output on mobile
        await update.message.reply_text("Compacted session.")
        # Don't add /compact to history - it's a meta-command
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
    # Write debug info to a file since journal might not capture it
    debug_file = Path.home() / ".telegram-bridge-debug.log"
    with open(debug_file, "w") as f:
        f.write(f"PATH: {os.environ.get('PATH', 'NOT SET')}\n")
        f.write(f"NVM_DIR: {os.environ.get('NVM_DIR', 'NOT SET')}\n")
        f.write(f"NODE_BIN: {os.environ.get('NODE_BIN', 'NOT SET')}\n")

    # Check if bridge is explicitly enabled (defaults to disabled)
    enabled = os.environ.get(ENABLE_BRIDGE_ENV, "").lower()
    if enabled not in ("1", "true", "yes"):
        logger.error(
            f"{ENABLE_BRIDGE_ENV} not set to 'true'. "
            "Bridge is disabled by default. "
            f"Set {ENABLE_BRIDGE_ENV}=true to enable."
        )
        return

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
