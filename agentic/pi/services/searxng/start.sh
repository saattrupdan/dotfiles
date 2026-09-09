#!/usr/bin/env bash
# Start SearXNG and wait until its HTTP listener answers.
set -eu
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"
# shellcheck source=common.sh
. "$SCRIPT_DIR/common.sh"

require_docker
require_command curl
load_secret
compose config --quiet || fail 'compose configuration is invalid'

running_id="$(compose ps --status running --quiet searxng 2>/dev/null || true)"
if [ -z "$running_id" ]; then
  require_command python3
  if ! python3 - "$URL" <<'PY'
import socket
import sys
from urllib.parse import urlsplit

address = urlsplit(sys.argv[1])
try:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind((address.hostname, address.port))
except OSError as exc:
    print(f"searxng: 127.0.0.1:8888 is already occupied ({exc})", file=sys.stderr)
    raise SystemExit(1)
PY
  then
    exit 1
  fi
fi

compose up --detach --remove-orphans

deadline=$(( $(date +%s) + 60 ))
while :; do
  if curl --silent --show-error --fail --max-time 2 "$URL/" >/dev/null 2>&1; then
    printf 'searxng: ready at %s\n' "$URL"
    exit 0
  fi
  if [ "$(date +%s)" -ge "$deadline" ]; then
    compose ps >&2 || true
    fail 'startup timed out after 60 seconds; inspect with `docker compose logs searxng`'
  fi
  sleep 1
done
