#!/bin/bash
# Recover a stuck Mac Tailscale tunnel after Wi-Fi -> iPhone hotspot handoffs.
# Only cycle the tunnel when two independent tailnet SSH routes fail and the
# physical Wi-Fi still has internet. Retry `up` after a failed cycle.
set -u

TS="${TAILSCALE_BIN:-/Applications/Tailscale.app/Contents/MacOS/Tailscale}"
CURL="${CURL_BIN:-/usr/bin/curl}"
NC="${NC_BIN:-/usr/bin/nc}"
SLEEP="${SLEEP_BIN:-/bin/sleep}"
STATE_DIR="${STATE_DIR:-$HOME/Library/Caches/io.pi.tailscale-recovery}"
SPARKIE=100.102.237.34
JOB_BOT=100.121.48.91
COOLDOWN=600

log() { /usr/bin/logger -t io.pi.tailscale-recovery "$*"; }
online() { printf '%s\n' "$status" | /usr/bin/awk -v ip="$1" '$1 == ip && !/offline/ {found=1} END {exit !found}'; }
reachable() { "$NC" -G 3 -w 3 -z "$1" 22 >/dev/null 2>&1; }
internet() {
  # IP literal avoids DNS; bind to the physical Wi-Fi, not the tailnet.
  "$CURL" --interface en0 --connect-timeout 3 --max-time 5 --fail --silent \
    https://1.1.1.1/cdn-cgi/trace >/dev/null 2>&1
}

[ -x "$TS" ] || exit 0
if [ -e "$STATE_DIR/pending-up" ]; then
  # We turned Tailscale off ourselves. Keep restoring it after internet returns,
  # even when `status` shows no peers. Never do this for a user-initiated stop.
  internet || exit 0
  if "$TS" up >/dev/null 2>&1; then
    /bin/rm -f "$STATE_DIR/pending-up"
    log "Tailscale restored after interrupted recovery"
  fi
  exit 0
fi
status=$("$TS" status 2>/dev/null) || exit 0
# Respect a deliberate user disconnect or an offline Sparkie.
online "$SPARKIE" || exit 0
reachable "$SPARKIE" && exit 0
internet || exit 0
"$SLEEP" 8
reachable "$SPARKIE" && exit 0

/bin/mkdir -p "$STATE_DIR" || exit 0
now=$(/bin/date +%s)
last=$(/bin/cat "$STATE_DIR/last-attempt" 2>/dev/null || echo 0)
case "$last" in *[!0-9]*|'') last=0;; esac
[ $((now - last)) -ge "$COOLDOWN" ] || exit 0
printf '%s\n' "$now" > "$STATE_DIR/last-attempt" || exit 0

log "Sparkie SSH unreachable despite working internet; forcing Tailscale rebind"
"$TS" debug rebind >/dev/null 2>&1 || true
"$SLEEP" 5
reachable "$SPARKIE" && { log "Tailscale recovered after rebind"; exit 0; }
# One peer could have an SSH outage. Never cycle a tunnel that reaches another peer.
internet || exit 0
status=$("$TS" status 2>/dev/null) || exit 0
online "$SPARKIE" && online "$JOB_BOT" || exit 0
reachable "$JOB_BOT" && exit 0
log "Both tailnet SSH peers unreachable; cycling Tailscale once (10-minute cooldown)"
: > "$STATE_DIR/pending-up" || exit 0
if "$TS" down >/dev/null 2>&1; then
  if "$TS" up >/dev/null 2>&1; then
    /bin/rm -f "$STATE_DIR/pending-up"
  else
    log "Tailscale up failed; will retry when the underlay is available"
  fi
else
  /bin/rm -f "$STATE_DIR/pending-up"
fi
exit 0
