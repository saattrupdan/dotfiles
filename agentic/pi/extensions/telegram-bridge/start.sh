#!/bin/bash
# Start the Telegram bridge in detached tmux session
# Usage: ./start.sh
# Stop: ./stop.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SESSION_NAME="pi-bridge"

# Check if tmux is available
if ! command -v tmux &> /dev/null; then
    echo "Error: tmux not found. Install tmux or run bridge manually."
    exit 1
fi

# Load environment variables from .env if it exists
if [ -f "$SCRIPT_DIR/.env" ]; then
    set -a
    source "$SCRIPT_DIR/.env"
    set +a
fi

# Check required variables
if [ -z "$TELEGRAM_BRIDGE_ENABLED" ]; then
    echo "Error: TELEGRAM_BRIDGE_ENABLED not set"
    echo "Bridge is disabled by default. Set TELEGRAM_BRIDGE_ENABLED=true in $SCRIPT_DIR/.env"
    exit 1
fi

if [ -z "$TELEGRAM_BOT_TOKEN" ]; then
    echo "Error: TELEGRAM_BOT_TOKEN not set"
    echo "Set it in $SCRIPT_DIR/.env or export it"
    exit 1
fi

if [ -z "$ALLOWED_USER_IDS" ]; then
    echo "Error: ALLOWED_USER_IDS not set"
    echo "Set it in $SCRIPT_DIR/.env or export it"
    exit 1
fi

# Kill existing session if running
tmux kill-session -t "$SESSION_NAME" 2>/dev/null || true

# Start new detached session
tmux new -d -s "$SESSION_NAME" -c "$SCRIPT_DIR"
tmux send-keys -t "$SESSION_NAME" "export TELEGRAM_BOT_TOKEN=$TELEGRAM_BOT_TOKEN" Enter
tmux send-keys -t "$SESSION_NAME" "export ALLOWED_USER_IDS=$ALLOWED_USER_IDS" Enter
tmux send-keys -t "$SESSION_NAME" "uv run src/scripts/bridge.py" Enter

echo "Bridge started in tmux session '$SESSION_NAME'"
echo "Attach with: tmux attach -t $SESSION_NAME"
echo "Detach with: Ctrl+B, then D"
echo "Stop with: $SCRIPT_DIR/stop.sh"
