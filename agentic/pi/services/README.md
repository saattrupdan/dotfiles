# MacBook Tailscale recovery

On Dan's MacBook (`100.64.176.114`), `setup.sh` links this directory and loads
`io.pi.tailscale-recovery` as a user LaunchAgent (every 30 seconds). The watchdog
checks actual SSH connectivity to Sparkie over the tailnet. If it fails twice
while internet works on Wi-Fi, it asks Tailscale to rebind. It cycles Tailscale
only if both Sparkie and job-bot are listed online but unreachable through the
Mac's tailnet route. Cycles are limited to once per ten minutes. A failed `up`
is retried when internet returns, via `~/Library/Caches/io.pi.tailscale-recovery/pending-up`.
It does not act when Tailscale is intentionally stopped or the hotspot has no
internet. Logs use the `io.pi.tailscale-recovery` syslog tag.

Check: `launchctl print gui/$(id -u)/io.pi.tailscale-recovery` and
`bash ~/.pi/agent/services/tailscale-recovery.test.sh`.
Disable: `launchctl bootout gui/$(id -u)/io.pi.tailscale-recovery`.
Re-enable: `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/io.pi.tailscale-recovery.plist`.
