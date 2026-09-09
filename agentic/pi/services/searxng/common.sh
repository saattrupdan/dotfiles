#!/usr/bin/env bash
# Shared, deliberately quiet helpers for the private SearXNG service.
set -eu

SERVICE_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
COMPOSE_FILE="$SERVICE_DIR/compose.yml"
SECRET_FILE="${PI_HOME:-$HOME/.pi/agent}/secrets/searxng-secret"
PROJECT_NAME="searxng-local"
URL="http://127.0.0.1:8888"

fail() {
  printf 'searxng: %s\n' "$*" >&2
  exit 1
}

require_docker() {
  command -v docker >/dev/null 2>&1 || fail 'Docker is not installed or not on PATH'
  docker compose version >/dev/null 2>&1 || fail 'Docker Compose is not available (need `docker compose`)'
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command is missing: $1"
}

load_secret() {
  [ -f "$SECRET_FILE" ] || fail "secret is missing; run $SERVICE_DIR/setup.sh"
  [ -s "$SECRET_FILE" ] || fail "secret is empty: $SECRET_FILE"
  # Do not echo or interpolate the value into diagnostics. Compose receives it
  # through this process environment only.
  SEARXNG_SECRET="$(cat "$SECRET_FILE")"
  [ "${#SEARXNG_SECRET}" -ge 32 ] || fail "secret is too short: $SECRET_FILE"
  export SEARXNG_SECRET
}

compose() {
  docker compose --project-name "$PROJECT_NAME" --file "$COMPOSE_FILE" "$@"
}
