/**
 * Keep the Mac awake *while an agent run is in progress* — even with the lid
 * closed — then let it sleep normally once the run finishes.
 *
 *   • agent_start → the Mac stays awake; closing the lid no longer sleeps it,
 *                   so a long run keeps going while you walk away.
 *   • agent_end   → normal sleep behaviour is restored. If the lid is shut at
 *                   that point the Mac sleeps right away; if it's open nothing
 *                   changes (the usual idle timer applies).
 *
 * Two macOS mechanisms, combined, because neither is sufficient alone:
 *
 *   1. `caffeinate -dimsu` — asserts that work is happening, so the system
 *      won't idle-sleep, dim the display, spin down disks, or system-sleep
 *      during the run. No privileges. But macOS *still* clamshell-sleeps the
 *      moment the lid shuts, regardless of any caffeinate assertion.
 *
 *   2. `pmset -a disablesleep 1` — the only switch that actually prevents
 *      lid-close (clamshell) sleep, and `… 0` restores it. Requires root.
 *      Per the approach in https://apple.stackexchange.com/questions/219885,
 *      that's unavoidable.
 *
 * Re-prompting for a password on every run would be miserable, so the privilege
 * is acquired *once per session* by a long-lived watcher launched on the first
 * run. The watcher polls a tiny state file and flips `disablesleep` to match
 * (1 while a run is active, 0 when idle); pi just writes "1"/"0" to that file at
 * agent_start / agent_end. The watcher also self-restores `disablesleep 0` and
 * exits if this pi process dies, so a crash never leaves the Mac unable to
 * sleep.
 *
 * How root is obtained, preferring the least intrusive:
 *   • If `sudo -n /usr/bin/pmset` works (you've added a NOPASSWD sudoers line —
 *     see the README), the watcher runs unprivileged and shells out with
 *     `sudo -n` — zero prompts, ever.
 *   • Otherwise it's launched via `osascript … with administrator privileges`,
 *     which pops one native auth dialog on the first run and then holds root
 *     for the rest of the session.
 *
 * macOS-only and orchestrator-only: subagents share the parent's machine and
 * the parent's run already brackets their work, so they never touch power. On
 * other platforms the extension loads but is inert.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const IS_MACOS = os.platform() === "darwin";

const STATUS_KEY = "caffeinate";

// The watcher polls this file: "1" → hold the lid open, "0"/absent → let it
// sleep. Keyed by pid so concurrent pi processes don't collide.
const STATE_PATH = path.join(os.tmpdir(), `pi-caffeinate-${process.pid}.state`);

// User-facing kill switch for the session (`/caffeinate off`). Defaults on.
let sessionEnabled = true;
// Whether a run is currently being held awake.
let engaged = false;
// The privileged watcher, launched lazily on the first run and kept alive for
// the whole session. Self-exits when this pid dies.
let watcherStarted = false;
// True once the watcher is confirmed to be holding root (sudo -n probe passed,
// or the osascript dialog wasn't declined). Drives the status label.
let lidCovered = false;
// The per-run `caffeinate` assertion process.
let caffeinateChild: ChildProcess | null = null;

function escapeForAppleScript(s: string): string {
	return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function setStatus(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	if (!engaged) {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		return;
	}
	ctx.ui.setStatus(STATUS_KEY, lidCovered ? "☕ awake (lid ok)" : "☕ awake (idle only)");
}

function writeState(value: "1" | "0"): void {
	try {
		fs.writeFileSync(STATE_PATH, value);
	} catch {
		// best effort
	}
}

/** Does `sudo -n /usr/bin/pmset` work without a password (NOPASSWD sudoers)? */
function sudoPmsetNoPassword(): boolean {
	try {
		const r = spawnSync("sudo", ["-n", "/usr/bin/pmset", "-g"], {
			stdio: "ignore",
			timeout: 2000,
		});
		return r.status === 0;
	} catch {
		return false;
	}
}

/**
 * The watcher loop, parameterised by how it invokes pmset. Polls the state file
 * every second, mirrors it into `disablesleep`, and restores `disablesleep 0`
 * when either the state file is removed or this pi process exits.
 */
function watcherShell(pmset: string): string {
	const state = STATE_PATH.replace(/'/g, `'\\''`);
	return (
		`prev=; ` +
		`while /bin/kill -0 ${process.pid} 2>/dev/null; do ` +
		`if [ -f '${state}' ]; then s=\`/bin/cat '${state}'\`; else s=0; fi; ` +
		`if [ "$s" != "$prev" ]; then ${pmset} -a disablesleep "$s" 2>/dev/null; prev="$s"; fi; ` +
		`/bin/sleep 1; ` +
		`done; ` +
		`${pmset} -a disablesleep 0 2>/dev/null; ` +
		`/bin/rm -f '${state}'`
	);
}

/** Launch the session-lived privileged watcher exactly once. */
function startWatcher(ctx: ExtensionContext): void {
	if (watcherStarted) return;
	watcherStarted = true;

	let child: ChildProcess;
	try {
		if (sudoPmsetNoPassword()) {
			// Zero-prompt path: unprivileged loop, `sudo -n` per pmset call.
			child = spawn("sh", ["-c", watcherShell("sudo -n /usr/bin/pmset")], {
				stdio: "ignore",
				detached: true,
			});
			lidCovered = true;
		} else {
			// One-prompt path: the whole loop runs as root via a native dialog.
			const shell = watcherShell("/usr/bin/pmset");
			const appleScript = `do shell script "${escapeForAppleScript(shell)}" with administrator privileges`;
			child = spawn("osascript", ["-e", appleScript], { stdio: "ignore", detached: true });
			lidCovered = true;
		}
	} catch {
		watcherStarted = false;
		lidCovered = false;
		setStatus(ctx);
		return;
	}

	child.on("error", () => {
		watcherStarted = false;
		lidCovered = false;
		setStatus(ctx);
	});
	child.on("exit", (code) => {
		// The watcher should outlive every run. An early exit means the admin
		// dialog was declined (or sudo failed): the lid is no longer covered.
		watcherStarted = false;
		if (code !== 0) {
			lidCovered = false;
			if (engaged && ctx.hasUI) {
				ctx.ui.notify(
					"Couldn't disable lid-close sleep (admin not granted). The run is " +
						"held awake while the lid is open, but closing it will sleep the Mac. " +
						"See the caffeinate extension README to set up passwordless pmset.",
					"warning",
				);
			}
			setStatus(ctx);
		}
	});
	child.unref();
}

function engage(ctx: ExtensionContext): void {
	if (!IS_MACOS || !sessionEnabled || engaged) return;
	engaged = true;

	// Tell the watcher to hold the lid open, launching it on the first run.
	writeState("1");
	startWatcher(ctx);

	// Idle/display/system assertions for the duration of the run. Dies with us
	// as an extra backstop even if the watcher is somehow lost.
	try {
		const p = spawn("caffeinate", ["-dimsu"], { stdio: "ignore", detached: true });
		p.on("error", () => {});
		caffeinateChild = p;
	} catch {
		caffeinateChild = null;
	}

	setStatus(ctx);
}

function release(ctx: ExtensionContext): void {
	if (!engaged) return;
	engaged = false;

	// Let the lid sleep again. The watcher sees "0" within ~1s and runs
	// `pmset disablesleep 0`; if the lid is shut, the Mac sleeps then.
	writeState("0");

	if (caffeinateChild) {
		try {
			caffeinateChild.kill();
		} catch {
			// already gone
		}
		caffeinateChild = null;
	}

	setStatus(ctx);
}

export default function (pi: ExtensionAPI) {
	// Subagents share the parent's machine; only the orchestrator manages power.
	if (process.env.PI_SUBAGENT_CHILD === "1") return;

	// Engage for the lifetime of each agent run, release when it ends.
	pi.on("agent_start", async (_event, ctx) => {
		engage(ctx);
	});
	pi.on("agent_end", async (_event, ctx) => {
		release(ctx);
	});

	// Teardown: drop the state file and kill caffeinate. The watcher restores
	// `disablesleep 0` either on the missing state or on this pid dying.
	pi.on("session_shutdown", async (_event, ctx) => {
		release(ctx);
		try {
			fs.rmSync(STATE_PATH, { force: true });
		} catch {
			// best effort — the watcher resets on pid death regardless
		}
	});

	// Manual session-level control + introspection.
	pi.registerCommand("caffeinate", {
		description: "Keep-awake-while-running control: on | off | status.",
		async handler(args, ctx) {
			const arg = args.trim().toLowerCase();
			if (arg === "off") {
				sessionEnabled = false;
				release(ctx);
			} else if (arg === "on") {
				sessionEnabled = true;
			} else if (arg !== "" && arg !== "status") {
				pi.sendMessage({
					customType: "caffeinate:error",
					content: "Usage: /caffeinate [on|off|status]",
					display: true,
				});
				return;
			}

			let state: string;
			if (!IS_MACOS) {
				state = "unavailable — macOS only.";
			} else if (!sessionEnabled) {
				state = "disabled for this session (runs will not hold the Mac awake).";
			} else if (engaged) {
				state = lidCovered
					? "active — this run keeps the Mac awake, even with the lid closed."
					: "active — idle sleep is held off, but lid-close will still sleep (admin not granted).";
			} else {
				state = "armed — the Mac will stay awake (lid-close included) while a run is in progress.";
			}
			pi.sendMessage({
				customType: "caffeinate:status",
				content: `Caffeinate: ${state}`,
				display: true,
			});
		},
	});
}
