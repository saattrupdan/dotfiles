#!/bin/bash
# Stop the Telegram bridge tmux session
# Usage: ./stop.sh

set -e

SESSION_NAME="pi-bridge"

if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
    tmux kill-session -t "$SESSION_NAME"
    echo "Bridge stopped"
else
    echo "Bridge not running"
fi
