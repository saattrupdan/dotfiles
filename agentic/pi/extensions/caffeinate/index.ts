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
 * We refuse to prompt for a password — ever. The extension only activates if
 * `sudo -n /usr/bin/pmset` already works, i.e. you've granted passwordless
 * access to *that one binary* via sudoers (see the nudge / README). If you
 * haven't, the extension stays completely inert and, on the first run, prints a
 * one-time hint showing the exact line to add. No prompts, no half-measures.
 *
 * When it is active, a session-lived watcher process holds the privilege for
 * the whole session and toggles `disablesleep` 1/0 from a tiny state file that
 * pi writes at agent_start / agent_end — so the lid switch tracks the run
 * without pi itself needing root. The watcher also restores `disablesleep 0`
 * and exits if this pi process dies, so a crash never leaves the Mac unable to
 * sleep.
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

/** Drop-in sudoers file that unlocks the extension — scoped to pmset alone. */
const SUDOERS_FILE = "/etc/sudoers.d/pi-caffeinate";

function currentUser(): string {
	try {
		return os.userInfo().username;
	} catch {
		return "<you>";
	}
}

/**
 * The one-shot command that grants passwordless pmset access: write a scoped
 * drop-in, lock its perms, and validate the syntax before it can take effect.
 * `user` is baked in so the nudge shows a ready-to-paste line.
 */
function installCommand(user: string): string {
	return (
		`echo "${user} ALL=(ALL) NOPASSWD: /usr/bin/pmset" | sudo tee ${SUDOERS_FILE} >/dev/null && ` +
		`sudo chmod 440 ${SUDOERS_FILE} && sudo visudo -cf ${SUDOERS_FILE}`
	);
}

// User-facing kill switch for the session (`/caffeinate off`). Defaults on.
let sessionEnabled = true;
// Whether a run is currently being held awake.
let engaged = false;
// Tri-state cache of the passwordless-sudo probe: null = not yet checked.
let sudoOk: boolean | null = null;
// The privileged watcher, launched lazily on the first held run and kept alive
// for the whole session. Self-exits when this pid dies.
let watcherStarted = false;
// Show the "set up sudoers" nudge at most once per session.
let nudged = false;
// The per-run `caffeinate` assertion process.
let caffeinateChild: ChildProcess | null = null;

function setStatus(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	if (!engaged) {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		return;
	}
	ctx.ui.setStatus(STATUS_KEY, "☕ awake (lid ok)");
}

function writeState(value: "1" | "0"): void {
	try {
		fs.writeFileSync(STATE_PATH, value);
	} catch {
		// best effort
	}
}

/**
 * Does `sudo -n /usr/bin/pmset` work without a password? `-n` means
 * non-interactive: sudo fails fast instead of prompting, so this never blocks
 * and never pops a dialog. Cached after the first probe.
 */
function hasPasswordlessPmset(): boolean {
	if (sudoOk !== null) return sudoOk;
	try {
		const r = spawnSync("sudo", ["-n", "/usr/bin/pmset", "-g"], {
			stdio: "ignore",
			timeout: 2000,
		});
		sudoOk = r.status === 0;
	} catch {
		sudoOk = false;
	}
	return sudoOk;
}

/** One-time hint telling the user how to enable the extension. */
function nudge(ctx: ExtensionContext): void {
	if (nudged) return;
	nudged = true;
	if (!ctx.hasUI) return;
	ctx.ui.notify(
		"caffeinate: to keep runs going with the lid closed, grant passwordless " +
			"pmset access. Run this once in a terminal:\n    " +
			installCommand(currentUser()) +
			"\nUntil then this extension stays off — it never prompts for a password.",
		"info",
	);
}

/**
 * The watcher loop: poll the state file every second, mirror it into
 * `disablesleep` via `sudo -n` (passwordless, already verified), and restore
 * `disablesleep 0` when either the state file is removed or this pi process
 * exits.
 */
function watcherShell(): string {
	const state = STATE_PATH.replace(/'/g, `'\\''`);
	const pmset = "sudo -n /usr/bin/pmset";
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

/** Launch the session-lived watcher exactly once. */
function startWatcher(): void {
	if (watcherStarted) return;
	watcherStarted = true;
	try {
		const child = spawn("sh", ["-c", watcherShell()], { stdio: "ignore", detached: true });
		child.on("error", () => {
			watcherStarted = false;
		});
		child.on("exit", () => {
			watcherStarted = false;
		});
		child.unref();
	} catch {
		watcherStarted = false;
	}
}

function engage(ctx: ExtensionContext): void {
	if (!IS_MACOS || !sessionEnabled || engaged) return;

	// No passwordless pmset → stay inert and nudge once. Never prompt.
	if (!hasPasswordlessPmset()) {
		nudge(ctx);
		return;
	}

	engaged = true;

	// Tell the watcher to hold the lid open, launching it on the first run.
	writeState("1");
	startWatcher();

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
				state = "disabled for this session (`/caffeinate on` to re-arm).";
			} else if (!hasPasswordlessPmset()) {
				state =
					"off — needs passwordless pmset. Run this once in a terminal:\n    " +
					installCommand(currentUser());
			} else if (engaged) {
				state = "active — this run keeps the Mac awake, even with the lid closed.";
			} else {
				state = "armed — runs will keep the Mac awake (lid-close included) while in progress.";
			}
			pi.sendMessage({
				customType: "caffeinate:status",
				content: `Caffeinate: ${state}`,
				display: true,
			});
		},
	});
}
