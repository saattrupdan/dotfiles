#!/usr/bin/env bash
# Verify the loopback-only publication and a live JSON search response.
set -eu
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"
# shellcheck source=common.sh
. "$SCRIPT_DIR/common.sh"

require_docker
require_command curl
require_command jq
load_secret
compose config --quiet || fail 'compose configuration is invalid'
container_id="$(compose ps --status running --quiet searxng 2>/dev/null || true)"
[ -n "$container_id" ] || fail 'SearXNG is not running; run start.sh first'

binding="$(docker inspect "$container_id" | jq -r '.[0].HostConfig.PortBindings["8080/tcp"][]? | "\(.HostIp):\(.HostPort)"')"
[ "$binding" = '127.0.0.1:8888' ] || fail "unexpected listener binding: ${binding:-none} (expected 127.0.0.1:8888)"
printf 'searxng: listener binding is 127.0.0.1:8888\n'

response="$(mktemp)"
trap 'rm -f "$response"' EXIT
if ! curl --silent --show-error --fail --max-time 30 --get "$URL/search" \
  --data-urlencode 'q=SearXNG privacy' \
  --data-urlencode 'format=json' > "$response"; then
  fail 'live JSON search request failed or returned a non-2xx response'
fi
jq -e 'type == "object" and (.results | type) == "array"' "$response" >/dev/null \
  || fail 'live search returned malformed JSON or no results array'
result_count="$(jq -r '.results | length' "$response")"
[ "$result_count" -gt 0 ] || fail 'live JSON search returned an empty result set'
printf 'searxng: live JSON search passed (%s results)\n' "$result_count"
