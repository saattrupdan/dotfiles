#!/bin/sh
set -eu
# This trusted entrypoint runs before any project or profile code.
case "${SANDBOX_UID:-}:${SANDBOX_GID:-}" in *[!0-9:]*|:|0:*) echo 'Invalid sandbox identity' >&2; exit 1;; esac
mkdir -p /home/pi
chown "$SANDBOX_UID:$SANDBOX_GID" /home/pi
printf 'apple-container\n' > /run/pi-sandbox
chmod 444 /run/pi-sandbox
# A separate namespace has no external interfaces, routes, DNS, or host loopback.
# Failure to create it terminates startup rather than exposing ordinary networking.
exec unshare --net -- /usr/local/bin/pi-sandbox-inner "$@"
