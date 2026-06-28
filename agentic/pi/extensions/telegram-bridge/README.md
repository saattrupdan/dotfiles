# Telegram Bridge for Pi

Bridge Telegram messages to/from your local Pi agent.

## Setup

### 1. Create Telegram Bot

1. Open Telegram, search for **@BotFather**
2. Send `/newbot`
3. Choose a name (e.g., "Pi Assistant")
4. Choose a username (e.g., `pi_yourname_bot`)
5. Save the token (looks like:
   `123456789:ABCdefGHIjklMNOpqrsTUVwxyz`)

### 2. Get Your Telegram User ID

1. Search for **@userinfobot** in Telegram
2. Send any message
3. It replies with your user ID (e.g., `123456789`)

### 3. Install and Run

```bash
cd agentic/pi/extensions/telegram-bridge

# Set environment variables
export TELEGRAM_BOT_TOKEN="123456789:ABCdefGHIjklMNOpqrsTUVwxyz"
export ALLOWED_USER_IDS="123456789"

# Run the bridge
uv run src/scripts/bridge.py
```

## Commands

| Command | Description |
|---------|-------------|
| `clear` | Reset history (creates new session ID) |
| `status` | Show cwd, session ID, message count |
| `cwd <path>` | Change working directory |
| `help` | List available commands |

Any other text is forwarded to Pi.

## Session Handling

The bridge uses a **fixed session ID** (`telegram`) for all Telegram
conversations. When you send `clear`:

1. A new UUID session ID is generated
2. Conversation history is reset
3. Pi starts fresh with the new session

This gives you a clean slate without carrying over old context.

## Mobile UX

Responses over 300 characters are truncated with a note to check your
laptop for full details. This keeps conversations brief and mobile-friendly.

## Gotchas

- **Keep the bridge running** — it polls every 2 seconds
- **Your Mac must be awake** — bridge runs locally
- **One chat thread** — use `clear` to reset context when switching topics
- **Authorisation** — only configured user IDs can interact

## Stop

Press `Ctrl+C` to stop the bridge.
