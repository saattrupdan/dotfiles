# Telegram Bot for Pi Agent

A personal Telegram bot that forwards messages to Pi and returns responses.

## Architecture

```
Telegram Bot (Python) → Pi CLI (subprocess) → Response → Telegram
       │                      │
       │                      └─► Session file per user
       │
       └─► Polling (no webhook needed)
```

## Design decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| **Language** | Python | `python-telegram-bot` is mature, well-maintained, async-ready |
| **Pi invocation** | CLI (`pi -p --no-session`) | Simpler than library import; avoids TS/Node dependency conflicts; stateless per-request |
| **Communication** | Polling | Works behind NAT, no public URL/ngrok needed |
| **Session handling** | Per-user session dir | Each Telegram user gets isolated Pi sessions in `~/.pi/agent/telegram-sessions/<user_id>/` |

## Requirements

- Python 3.10+
- `python-telegram-bot` (async)
- Pi CLI installed and configured
- Telegram Bot Token (from @BotFather)

## Setup

```bash
cd agentic/telegram-bot
python3 -m venv venv
source venv/bin/activate
pip install python-telegram-bot
```

Create `config.py`:

```python
TELEGRAM_BOT_TOKEN = "your-bot-token-from-botfather"
ALLOWED_USERS = [123456789]  # Your Telegram user ID(s)
PI_SESSION_DIR = "/Users/dansmart/.pi/agent/telegram-sessions"
```

## Usage

```bash
python bot.py
```

## Files

- `bot.py` — Main bot entry point
- `config.py` — Configuration (create from `config.example.py`)
- `requirements.txt` — Python dependencies
