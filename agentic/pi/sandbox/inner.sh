#!/bin/sh
set -eu
ip link set lo up
[ "$(ip -o link show | wc -l)" -eq 1 ] || { echo 'Unexpected sandbox network interface' >&2; exit 1; }
# Drop root, all capability sets, and setuid/file-capability escalation permanently.
exec setpriv --reuid="$SANDBOX_UID" --regid="$SANDBOX_GID" --clear-groups \
    --bounding-set=-all --inh-caps=-all --ambient-caps=-all --no-new-privs -- "$@"
