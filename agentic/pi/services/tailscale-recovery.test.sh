#!/bin/bash
set -euo pipefail
root=$(mktemp -d)
trap 'rm -rf "$root"' EXIT
script="$(dirname "$0")/tailscale-recovery.sh"
cat > "$root/tailscale" <<'MOCK'
#!/bin/bash
case "$1" in
  status)
    if [ "${MOCK_STOPPED:-0}" = 0 ]; then
      echo '100.102.237.34 spark-0774 user linux active'
      [ "${MOCK_JOB_OFFLINE:-0}" = 1 ] || echo '100.121.48.91 job-bot user linux active'
    fi ;;
  debug) echo rebind >> "$MOCK_LOG" ;;
  down) echo down >> "$MOCK_LOG" ;;
  up) echo up >> "$MOCK_LOG"; [ "${MOCK_UP_FAIL:-0}" = 0 ] ;;
esac
MOCK
cat > "$root/nc" <<'MOCK'
#!/bin/bash
case "$*" in
  *100.121.48.91*) echo jobbot >> "$MOCK_LOG"; [ "${MOCK_JOB_OK:-0}" = 1 ] ;;
  *) echo sparkie >> "$MOCK_LOG"; [ "${MOCK_SPARKIE_OK:-0}" = 1 ] ||
    { [ "${MOCK_RECOVER_ON_REBIND:-0}" = 1 ] && grep -q '^rebind$' "$MOCK_LOG"; } ;;
esac
MOCK
cat > "$root/curl" <<'MOCK'
#!/bin/bash
[ "${MOCK_NET_OK:-0}" = 1 ]
MOCK
cat > "$root/sleep" <<'MOCK'
#!/bin/bash
exit 0
MOCK
chmod +x "$root/tailscale" "$root/nc" "$root/curl" "$root/sleep"
export TAILSCALE_BIN="$root/tailscale" NC_BIN="$root/nc" CURL_BIN="$root/curl" SLEEP_BIN="$root/sleep"
export STATE_DIR="$root/state" MOCK_LOG="$root/actions"

: > "$MOCK_LOG"
MOCK_SPARKIE_OK=1 MOCK_NET_OK=1 "$script"
! grep -qE 'rebind|down|up' "$MOCK_LOG" || { echo 'Healthy tailnet was disrupted' >&2; exit 1; }

: > "$MOCK_LOG"
MOCK_SPARKIE_OK=0 MOCK_NET_OK=0 "$script"
! grep -qE 'rebind|down|up' "$MOCK_LOG" || { echo 'No-internet case was disrupted' >&2; exit 1; }

: > "$MOCK_LOG"
MOCK_STOPPED=1 MOCK_SPARKIE_OK=0 MOCK_NET_OK=1 "$script"
[ ! -s "$MOCK_LOG" ] || { echo 'Intentionally stopped Tailscale was restarted' >&2; exit 1; }

: > "$MOCK_LOG"
MOCK_RECOVER_ON_REBIND=1 MOCK_SPARKIE_OK=0 MOCK_NET_OK=1 "$script"
grep -q '^rebind$' "$MOCK_LOG"
! grep -qE '^down$|^up$' "$MOCK_LOG" || { echo 'Recovery rebind still cycled the tunnel' >&2; exit 1; }
rm -rf "$STATE_DIR"

: > "$MOCK_LOG"
MOCK_SPARKIE_OK=0 MOCK_JOB_OK=1 MOCK_NET_OK=1 "$script"
grep -q '^rebind$' "$MOCK_LOG"
! grep -qE '^down$|^up$' "$MOCK_LOG" || { echo 'Healthy second peer was disconnected' >&2; exit 1; }
rm -rf "$STATE_DIR"

: > "$MOCK_LOG"
MOCK_SPARKIE_OK=0 MOCK_JOB_OK=0 MOCK_NET_OK=1 MOCK_UP_FAIL=1 "$script"
[ "$(grep -c '^rebind$' "$MOCK_LOG")" = 1 ]
[ "$(grep -c '^down$' "$MOCK_LOG")" = 1 ]
[ "$(grep -c '^up$' "$MOCK_LOG")" = 1 ]
[ -e "$STATE_DIR/pending-up" ]
: > "$MOCK_LOG"
MOCK_STOPPED=1 MOCK_NET_OK=1 "$script"
grep -q '^up$' "$MOCK_LOG"
[ ! -e "$STATE_DIR/pending-up" ]
: > "$MOCK_LOG"
MOCK_SPARKIE_OK=0 MOCK_JOB_OK=0 MOCK_NET_OK=1 "$script"
! grep -qE 'rebind|down|up' "$MOCK_LOG" || { echo 'Cooldown did not apply' >&2; exit 1; }
echo 'tailscale-recovery: OK'
