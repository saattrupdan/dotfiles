// Session watchers share one macOS sleep switch. Reconcile all live sessions
// under a lock so an idle/ending session cannot undo another session's hold.
export function watcherShell(
	pid: number,
	statePath: string,
	hotMarkerPath: string,
	options: { directory?: string; pmset?: string; sudo?: string; battery?: string; lockf?: string } = {},
): string {
	const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
	const directory = options.directory ?? statePath.slice(0, statePath.lastIndexOf("/"));
	const pmset = options.pmset ?? "/usr/bin/pmset";
	const sudo = options.sudo ?? "/usr/bin/sudo";
	const battery = options.battery ?? "/usr/sbin/ioreg";
	const lockf = options.lockf ?? "/usr/bin/lockf";
	const state = quote(statePath);
	const marker = quote(hotMarkerPath);
	const lock = quote(`${directory}/pi-caffeinate.lock`);

	// `lockf -k` keeps the lock inode stable across processes. The locked
	// subprocess sees all per-Pi state files, ignores dead PIDs, and compares
	// the *real* global setting (not a per-watcher cached `prev`).
	const reconcile = [
		"dir=$1; wanted=0",
		`temp=$(${quote(battery)} -rn AppleSmartBattery 2>/dev/null | /usr/bin/awk '$1 == "\\"Temperature\\"" && $2 == "=" { print $3; exit }')`,
		"if [ -z \"$temp\" ] || [ \"$temp\" -lt 3500 ] 2>/dev/null; then",
		"  for file in \"$dir\"/pi-caffeinate-*.state; do",
		"    [ -f \"$file\" ] || continue",
		"    owner=${file##*/pi-caffeinate-}; owner=${owner%.state}",
		"    case \"$owner\" in ''|*[!0-9]*) continue ;; esac",
		"    if [ \"$(/bin/cat \"$file\" 2>/dev/null)\" = 1 ] && /bin/kill -0 \"$owner\" 2>/dev/null; then wanted=1; break; fi",
		"  done",
		"fi",
		`actual=$(${quote(pmset)} -g custom 2>/dev/null | /usr/bin/awk 'tolower($1) == "sleepdisabled" || tolower($1) == "disablesleep" { print $2; exit }')`,
		"actual=${actual:-0}",
		`[ "$actual" = "$wanted" ] || ${quote(sudo)} -n ${quote(pmset)} -a disablesleep "$wanted" 2>/dev/null`,
	].join("\n");

	return [
		`reconcile() { ${quote(lockf)} -k ${lock} /bin/sh -c ${quote(reconcile)} sh ${quote(directory)}; }`,
		`cleanup() { /bin/rm -f ${state} ${marker}; reconcile; }`,
		"trap cleanup EXIT",
		"trap 'exit 0' HUP INT TERM",
		`while /bin/kill -0 ${pid} 2>/dev/null; do`,
		`  temp=$(${quote(battery)} -rn AppleSmartBattery 2>/dev/null | /usr/bin/awk '$1 == "\\"Temperature\\"" && $2 == "=" { print $3; exit }')`,
		`  if [ -n "$temp" ] && [ "$temp" -ge 3500 ] 2>/dev/null; then`,
		`    if [ "$hot" != 1 ]; then /usr/bin/touch ${marker}; hot=1; fi`,
		"  else hot=; fi",
		"  reconcile",
		"  /bin/sleep 1",
		"done",
	].join("\n");
}
