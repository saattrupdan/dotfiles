#!/bin/bash
# Setup and start the Telegram Bridge systemd service
# Usage: ./setup-systemd.sh
# Idempotent - safe to run multiple times

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_NAME="pi-telegram-bridge"

echo "=== Telegram Bridge systemd setup ==="

# Check if ~/.env exists with required vars
if [ ! -f "$HOME/.env" ]; then
    echo "Creating $HOME/.env from template..."
    cp "$SCRIPT_DIR/.env.example" "$HOME/.env"
    echo ""
    echo "ERROR: $HOME/.env created but not configured."
    echo "Edit it and set:"
    echo "  TELEGRAM_BRIDGE_ENABLED=true"
    echo "  TELEGRAM_BOT_TOKEN=your-token"
    echo "  ALLOWED_USER_IDS=your-user-id"
    exit 1
fi

# Verify required vars in .env
if ! grep -q "TELEGRAM_BRIDGE_ENABLED=true" "$HOME/.env"; then
    echo "ERROR: TELEGRAM_BRIDGE_ENABLED is not set to 'true' in $HOME/.env"
    exit 1
fi

if ! grep -q "TELEGRAM_BOT_TOKEN=" "$HOME/.env"; then
    echo "ERROR: TELEGRAM_BOT_TOKEN not set in $HOME/.env"
    exit 1
fi

if ! grep -q "ALLOWED_USER_IDS=" "$HOME/.env"; then
    echo "ERROR: ALLOWED_USER_IDS not set in $HOME/.env"
    exit 1
fi

# Check/install uv
if ! command -v uv &> /dev/null && [ ! -f "$HOME/.local/bin/uv" ]; then
    echo "Installing uv..."
    curl -LsSf https://astral.sh/uv/install.sh | sh
fi

UV_BIN="$HOME/.local/bin/uv"
if [ ! -x "$UV_BIN" ]; then
    echo "ERROR: uv not found at $UV_BIN"
    exit 1
fi

# Install dependencies
echo "Installing dependencies..."
cd "$SCRIPT_DIR"
"$UV_BIN" sync

# Setup systemd directory
mkdir -p "$HOME/.config/systemd/user"

# Copy service file
echo "Installing systemd service..."
cp "$SCRIPT_DIR/pi-telegram-bridge.service" "$HOME/.config/systemd/user/"

# Reload and enable
echo "Enabling and starting service..."
systemctl --user daemon-reload
systemctl --user enable "$SERVICE_NAME"
systemctl --user restart "$SERVICE_NAME"

# Wait for service to start
sleep 2

# Check status
if systemctl --user is-active --quiet "$SERVICE_NAME"; then
    echo ""
    echo "✓ Telegram Bridge is running!"
    echo ""
    echo "Useful commands:"
    echo "  systemctl --user status $SERVICE_NAME"
    echo "  journalctl --user -u $SERVICE_NAME -f"
    echo "  systemctl --user stop $SERVICE_NAME"
else
    echo ""
    echo "ERROR: Service failed to start"
    echo "Check logs: journalctl --user -u $SERVICE_NAME -n 20"
    exit 1
fi
