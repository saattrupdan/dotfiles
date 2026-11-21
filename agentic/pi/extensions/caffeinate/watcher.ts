// Session watchers share one macOS sleep switch. Reconcile all live sessions
// under a lock so an idle/ending session cannot undo another session's hold.
export function watcherShell(
	pid: number,
	statePath: string,
	hotMarkerPath: string,
	options: { directory?: string; pmset?: string; sudo?: string; battery?: string; lid?: string; lockf?: string } = {},
): string {
	const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
	const directory = options.directory ?? statePath.slice(0, statePath.lastIndexOf("/"));
	const pmset = quote(options.pmset ?? "/usr/bin/pmset");
	const sudo = quote(options.sudo ?? "/usr/bin/sudo");
	const battery = quote(options.battery ?? "/usr/sbin/ioreg");
	const lid = quote(options.lid ?? "/usr/sbin/ioreg");
	const lockf = quote(options.lockf ?? "/usr/bin/lockf");
	const state = quote(statePath);
	const marker = quote(hotMarkerPath);
	const lock = quote(`${directory}/pi-caffeinate.lock`);
	// ioreg prefixes tree properties with "|"; find the exact key rather than
	// assuming it is the first whitespace-delimited field.
	const lidReading = `${lid} -r -l -k AppleClamshellState 2>/dev/null | /usr/bin/awk '{ for (i = 1; i + 2 <= NF; i++) if ($i == "\\"AppleClamshellState\\"" && $(i + 1) == "=") { print $(i + 2); exit } }'`;

	// The latch survives cooling and watcher replacement while the lid remains
	// closed. Only opening the lid permits the active sessions to hold it awake
	// again. Sleep requests are serialized and retried at most once per 5s,
	// including after an unsolicited wake while the laptop is still closed.
	const reconcile = [
		"dir=$1; held=0; status=; setting_failed=0",
		'for file in "$dir"/pi-caffeinate-*.state; do',
		'  [ -f "$file" ] || continue',
		'  owner=${file##*/pi-caffeinate-}; owner=${owner%.state}',
		"  case \"$owner\" in ''|*[!0-9]*) continue ;; esac",
		'  if [ "$(/bin/cat "$file" 2>/dev/null)" = 1 ] && /bin/kill -0 "$owner" 2>/dev/null; then held=1; break; fi',
		"done",
		`temp=$(${battery} -rn AppleSmartBattery 2>/dev/null | /usr/bin/awk '$1 == "\\"Temperature\\"" && $2 == "=" { print $3; exit }')`,
		"case \"$temp\" in ''|*[!0-9]*) temp=unknown ;; esac",
		// Bound shell integer input; out-of-range telemetry is unavailable,
		// never permission to continue closed-lid work without monitoring.
		'[ "${#temp}" -le 6 ] || temp=unknown',
		`lid=$(${lidReading})`,
		'case "$lid" in Yes|No) ;; *) lid=unknown ;; esac',
		'latch="$dir/pi-caffeinate-thermal-latch"',
		'attempt="$dir/pi-caffeinate-sleep-attempt"',
		'result="$dir/pi-caffeinate-sleep-result"',
		'if [ "$lid" = No ]; then /bin/rm -f "$latch" "$attempt" "$result"; fi',
		'if [ "$held" = 1 ]; then',
		'  if [ "$lid" = unknown ]; then status=lid-unavailable',
		'  elif [ "$temp" = unknown ]; then status=temperature-unavailable',
		'  elif [ "$temp" -ge 3500 ]; then status=hot-open; fi',
		'  if [ "$lid" = Yes ] && { [ "$temp" = unknown ] || [ "$temp" -ge 3500 ]; }; then',
		'    printf "1\\n" > "$latch"',
		'  fi',
		'  if [ -f "$latch" ]; then status=latched; fi',
		"fi",
		'wanted=$held; [ -z "$status" ] || wanted=0',
		// SleepDisabled is global; `-g custom` omits it entirely.
		`if output=$(${pmset} -g 2>/dev/null); then`,
		'  actual=$(printf "%s\\n" "$output" | /usr/bin/awk \'tolower($1) == "sleepdisabled" || tolower($1) == "disablesleep" { print $2; exit }\')',
		'  actual=${actual:-unknown}',
		"else actual=unknown; fi",
		`if [ "$actual" != "$wanted" ]; then ${sudo} -n ${pmset} -a disablesleep "$wanted" >/dev/null 2>&1 || setting_failed=1; fi`,
		'if [ "$held" = 1 ] && [ "$lid" = Yes ] && { [ -f "$latch" ] || [ "$temp" = unknown ] || [ "$temp" -ge 3500 ]; }; then',
		'  now=$(/bin/date +%s); last=$(/bin/cat "$attempt" 2>/dev/null)',
		"  case \"$last\" in ''|*[!0-9]*) last=0 ;; esac",
		'  [ "${#last}" -le 12 ] || last=0',
		'  if [ "$now" -lt "$last" ] || [ "$((now - last))" -ge 5 ]; then',
		// Recheck immediately before the disruptive operation: never use
		// an earlier closed-lid observation to authorize sleeping an open Mac.
		`    current_lid=$(${lidReading})`,
		'    if [ "$current_lid" = Yes ]; then',
		'      printf "%s\\n" "$now" > "$attempt"',
		`      if ${sudo} -n ${pmset} sleepnow >/dev/null 2>&1; then`,
		'        printf "sleep-requested\\n" > "$result"',
		'      else printf "sleep-failed\\n" > "$result"; fi',
		"    fi",
		"  fi",
		'  status=$(/bin/cat "$result" 2>/dev/null); status=${status:-latched}',
		"fi",
		'[ "$setting_failed" = 0 ] || status=setting-failed',
		'printf "%s" "$status"',
	].join("\n");

	return [
		"umask 077; previous=",
		`reconcile() { ${lockf} -k ${lock} /bin/sh -c ${quote(reconcile)} sh ${quote(directory)}; }`,
		`notice() { printf '%s\\n' "$1" > ${quote(`${hotMarkerPath}.tmp`)} && /bin/mv -f ${quote(`${hotMarkerPath}.tmp`)} ${marker}; }`,
		`cleanup() { /bin/rm -f ${state} ${marker} ${quote(`${hotMarkerPath}.tmp`)}; reconcile >/dev/null; }`,
		"trap cleanup EXIT",
		"trap 'exit 0' HUP INT TERM",
		`while /bin/kill -0 ${pid} 2>/dev/null; do`,
		"  if status=$(reconcile); then :; else status=watcher-failed; fi",
		'  if [ "$status" != "$previous" ]; then',
		'    if [ -n "$status" ]; then notice "$status" && previous=$status',
		'    elif [ -n "$previous" ]; then notice resumed && previous=; fi',
		"  fi",
		"  /bin/sleep 1",
		"done",
	].join("\n");
}

/** Describe the observed action, never claim an OS sleep request proves sleep. */
export function watcherMessage(status: string): string {
	switch (status.trim()) {
		case "sleep-requested":
			return "Caffeinate requested macOS sleep for the closed laptop. Lid-close protection stays off until you open the lid.";
		case "sleep-failed":
			return "macOS sleep request failed. Caffeinate will retry; check passwordless pmset permission and put the Mac to sleep manually.";
		case "setting-failed":
			return "Caffeinate could not change the sleep setting. It will retry; check passwordless pmset permission and put the Mac to sleep manually.";
		case "hot-open":
			return "Battery temperature reached 35 °C. Lid-close protection is off; an open laptop will not be forced to sleep.";
		case "temperature-unavailable":
			return "Battery temperature could not be read. Lid-close protection is off until temperature monitoring recovers.";
		case "lid-unavailable":
			return "Lid state could not be read. Lid-close protection is off; no forced sleep is requested without a confirmed closed lid.";
		case "latched":
			return "Lid-close protection remains off after a thermal cutoff. Open the lid before continuing closed-lid work.";
		case "resumed":
			return "Power monitoring recovered. Lid-close protection is available again for active work.";
		default:
			return "Caffeinate power monitoring failed. Check the Mac and put it to sleep manually before storing it in a bag.";
	}
}
