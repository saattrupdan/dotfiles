#!/usr/bin/env python3
"""
Telegram Bot for Pi Agent

Forwards messages from allowed Telegram users to Pi CLI and returns responses.
"""

import asyncio
import os
import subprocess
from pathlib import Path

from telegram import Update
from telegram.ext import (
    Application,
    CommandHandler,
    ContextTypes,
    MessageHandler,
    filters,
)

import config

# Per-user session directories
SESSION_DIR = Path(config.PI_SESSION_DIR)
SESSION_DIR.mkdir(parents=True, exist_ok=True)


def get_user_session_dir(user_id: int) -> str:
    """Get the Pi session directory for a Telegram user."""
    return str(SESSION_DIR / str(user_id))


async def run_pi(prompt: str, user_id: int) -> str:
    """Run Pi CLI with the given prompt and return the response."""
    session_dir = get_user_session_dir(user_id)

    cmd = [
        "pi",
        "-p",  # print mode (non-interactive)
        "--no-session",  # ephemeral session per request
        "--mode", "text",
        # Optionally use a session per user for continuity:
        # "--session-dir", session_dir,
        prompt,
    ]

    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=300,  # 5 minute timeout
        )
        if result.returncode != 0:
            return f"Error (exit {result.returncode}):\n{result.stderr}"
        return result.stdout.strip()
    except subprocess.TimeoutExpired:
        return "Pi timed out after 5 minutes."
    except FileNotFoundError:
        return "Error: `pi` command not found. Is Pi installed?"
    except Exception as e:
        return f"Error: {type(e).__name__}: {e}"


async def start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Handle /start command."""
    user = update.effective_user
    if user.id not in config.ALLOWED_USERS:
        await update.message.reply_text("Access denied.")
        return

    await update.message.reply_text(
        f"Hi {user.first_name}! I'm your Pi Agent bot.\n"
        "Send me any message and I'll forward it to Pi."
    )


async def handle_message(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Handle text messages."""
    user = update.effective_user

    # Allowlist check
    if user.id not in config.ALLOWED_USERS:
        print(f"Blocked user {user.id} ({user.username})")
        return

    text = update.message.text
    if not text:
        return

    print(f"User {user.id}: {text[:50]}...")

    # Send typing indicator
    await update.message.chat.send_action(action="typing")

    # Run Pi
    response = await run_pi(text, user.id)

    # Truncate for mobile if needed
    if len(response) > config.RESPONSE_MAX_LENGTH:
        response = response[: config.RESPONSE_MAX_LENGTH] + "\n\n[truncated]"

    await update.message.reply_text(response)
    print(f"Response sent to {user.id}")


async def error_handler(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Log errors."""
    print(f"Update {update} caused error {context.error}")


def main() -> None:
    """Start the bot."""
    # Validate config
    if config.TELEGRAM_BOT_TOKEN == "your-bot-token-from-botfather":
        print("Error: Set TELEGRAM_BOT_TOKEN in config.py")
        return

    if not config.ALLOWED_USERS or config.ALLOWED_USERS == [123456789]:
        print("Error: Set ALLOWED_USERS in config.py (get your ID from @userinfobot)")
        return

    # Create application
    application = Application.builder().token(config.TELEGRAM_BOT_TOKEN).build()

    # Handlers
    application.add_handler(CommandHandler("start", start))
    application.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_message))

    # Error handler
    application.add_error_handler(error_handler)

    # Start polling
    print("Starting bot (Ctrl+C to stop)...")
    application.run_polling(allowed_updates=Update.ALL_TYPES, poll_interval=config.POLL_INTERVAL)


if __name__ == "__main__":
    main()
