# Telegram Bridge for Pi

Bridge Telegram messages to/from your Pi agent. Runs as a background service
on a single machine (recommended: Linux server like DGX Spark).

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

### 3. Configure

**Bridge is disabled by default.** Set `TELEGRAM_BRIDGE_ENABLED=true` in `~/.env` to enable.

```bash
# Copy the template to your home directory
cp .env.example ~/.env
nano ~/.env  # Edit with your token, user ID, and set enabled=true
```

**Important:** Only run the bridge on ONE machine. Running on multiple machines
with the same bot token will cause message routing conflicts.

## Commands

| Command | Description |
|---------|-------------|
| `clear` | Reset history (creates new session ID) |

Any other text is forwarded to Pi.

## Running the Bridge

### Development (tmux)

For testing on macOS or Linux:

```bash
# Ensure ~/.env is configured
nano ~/.env  # Set TELEGRAM_BRIDGE_ENABLED=true, add token and user ID

# Start the bridge
cd agentic/pi/extensions/telegram-bridge
./start.sh

# Attach to see logs
tmux attach -t pi-bridge

# Detach: Ctrl+B, then D

# Stop
./stop.sh
```

### Production (systemd on Linux)

**Recommended for DGX Spark or any Linux server.**

One-time setup:

```bash
cd agentic/pi/extensions/telegram-bridge
./setup-systemd.sh
```

The `setup-systemd.sh` script:
- Installs `uv` if missing
- Installs Python dependencies
- Copies the systemd service file
- Enables and starts the service
- Verifies it's running

**After setup:**

```bash
# Check status
systemctl --user status pi-telegram-bridge.service

# View logs (follow)
journalctl --user -u pi-telegram-bridge.service -f

# Stop
systemctl --user stop pi-telegram-bridge.service

# Restart
systemctl --user restart pi-telegram-bridge.service

# Disable auto-start
systemctl --user disable pi-telegram-bridge.service
```

The service auto-starts on login and restarts on crash.

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

- **Single instance only** — Don't run on multiple machines with the same bot token
- **Polling** — Bridge polls Telegram every 2 seconds
- **One chat thread** — Use `clear` to reset context when switching topics
- **Authorisation** — Only configured user IDs can interact
- **Session persistence** — State stored in `src/sessions.json`

## Stopping the Bridge

**tmux:**
```bash
./stop.sh
# Or: tmux kill-session -t pi-bridge
```

**systemd:**
```bash
systemctl --user stop pi-telegram-bridge.service
```
