#!/usr/bin/env bash
# Provision the local-only SearXNG secret. This never starts Docker.
set -eu
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"
# shellcheck source=common.sh
. "$SCRIPT_DIR/common.sh"

mkdir -p "$(dirname "$SECRET_FILE")"
chmod 700 "$(dirname "$SECRET_FILE")"

if [ -e "$SECRET_FILE" ]; then
  [ -f "$SECRET_FILE" ] || fail "secret path is not a regular file: $SECRET_FILE"
  [ -s "$SECRET_FILE" ] || fail "secret exists but is empty: $SECRET_FILE"
  [ "$(wc -c < "$SECRET_FILE")" -ge 32 ] || fail "secret is too short: $SECRET_FILE"
  chmod 600 "$SECRET_FILE"
  printf 'searxng: secret already present; left its contents unchanged\n'
else
  umask 077
  temporary="$(mktemp "${SECRET_FILE}.XXXXXX")"
  trap 'rm -f "$temporary"' EXIT
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 48 > "$temporary"
  elif command -v python3 >/dev/null 2>&1; then
    python3 -c 'import secrets; print(secrets.token_hex(48), end="")' > "$temporary"
  else
    fail 'cannot generate secret: install openssl or python3'
  fi
  chmod 600 "$temporary"
  # noclobber makes concurrent setup invocations safe; an existing secret is
  # never replaced.
  if (set -C; cat "$temporary" > "$SECRET_FILE") 2>/dev/null; then
    chmod 600 "$SECRET_FILE"
    printf 'searxng: generated secret at %s\n' "$SECRET_FILE"
  else
    [ -s "$SECRET_FILE" ] || fail "could not create secret: $SECRET_FILE"
    chmod 600 "$SECRET_FILE"
    printf 'searxng: secret was created concurrently; left it unchanged\n'
  fi
fi

# Keep direct setup useful on machines without Docker, while making a direct
# invocation fail clearly when Docker is expected. The top-level Pi setup calls
# this script in a non-fatal prerequisite step.
require_docker
load_secret
compose config --quiet
printf 'searxng: Docker and compose configuration are ready\n'
