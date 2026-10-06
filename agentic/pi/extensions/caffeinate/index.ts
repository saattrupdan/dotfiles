/**
 * Keep the Mac awake while an agent run or a /loop is active — even with the
 * lid closed. After a loop finishes with the lid shut, hold until it reopens.
 *
 *   • agent_start → the Mac stays awake; closing the lid no longer sleeps it,
 *                   so a long run keeps going while you walk away.
 *   • agent_end   → normal sleep behaviour is restored unless /loop is still
 *                   active (including its wait and completion check). A stopped
 *                   loop keeps power held until any current run finishes. If
 *                   its lid is still shut, keep holding until it opens.
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
 * A session-lived watcher reconciles the global sleep switch from all live
 * Pi state files under a shared lock. This keeps one session's cleanup from
 * releasing another's hold, and restores normal sleep after the last active
 * session ends or dies. It rechecks the actual pmset setting each second in
 * case another process or a power transition changed it.
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
import { isLoopActive, onLoopChange } from "../_loop_state/state.ts";
import { isLidClosed } from "../_lid_state/lid.ts";
import { PowerLifecycle } from "./lifecycle.ts";
import { watcherShell } from "./watcher.ts";

const IS_MACOS = os.platform() === "darwin";

const STATUS_KEY = "caffeinate";

// The watcher polls this file: "1" → hold the lid open, "0"/absent → let it
// sleep. Keyed by pid so concurrent pi processes don't collide.
const STATE_PATH = path.join(os.tmpdir(), `pi-caffeinate-${process.pid}.state`);

/** Marker written by the shell watcher when the battery hits the thermal
 *  threshold (35 °C). The parent TypeScript side polls for it and calls
 *  `piApi.sendMessage()` once so the user knows sleep was re-enabled. */
const HOT_MARKER_PATH = path.join(os.tmpdir(), `pi-caffeinate-${process.pid}.hot`);

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

// The extension API, captured at load so helpers can post messages.
let piApi: ExtensionAPI | null = null;
// User-facing kill switch for the session (`/caffeinate off`). Defaults on.
let sessionEnabled = true;
// Whether a run or loop is currently being held awake.
let engaged = false;
// Tri-state cache of the passwordless-sudo probe: null = not yet checked.
let sudoOk: boolean | null = null;
// The privileged watcher, launched lazily on the first held run and kept alive
// for the whole session. Self-exits when this pid dies.
let watcherStarted = false;
// Show the "set up sudoers" nudge at most once per session.
let nudged = false;
// The per-run or per-loop `caffeinate` assertion process.
let caffeinateChild: ChildProcess | null = null;
// Interval handle for the battery-hot marker poller.
let hotCheckRef: ReturnType<typeof setInterval> | null = null;

function setStatus(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	if (!engaged) {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		return;
	}
	ctx.ui.setStatus(STATUS_KEY, "☕");
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

function isSleepDisabled(): boolean {
	try {
		const result = spawnSync("/usr/bin/pmset", ["-g", "custom"], { encoding: "utf8", timeout: 2000 });
		return result.status === 0 && /^\s*(?:SleepDisabled|disablesleep)\s+1\s*$/im.test(result.stdout);
	} catch {
		return false;
	}
}

/**
 * One-time hint telling the user how to enable the extension. Posted as a
 * displayed message (not a transient toast) so it persists in the transcript
 * and the install command can be copied. Shown at most once per session.
 */
function nudge(): void {
	if (nudged) return;
	nudged = true;
	piApi?.sendMessage({
		customType: "caffeinate:setup",
		content:
			"caffeinate: to keep runs going with the lid closed, grant passwordless " +
			"pmset access. Run this once in a terminal:\n\n    " +
			installCommand(currentUser()) +
			"\n\nUntil then this extension stays off — it never prompts for a password. " +
			"(`/caffeinate status` shows this again.)",
		display: true,
	});
}

/** Launch the session-lived watcher exactly once. */
function startWatcher(): void {
	if (watcherStarted) return;
	watcherStarted = true;
	try {
		const child = spawn("sh", ["-c", watcherShell(process.pid, STATE_PATH, HOT_MARKER_PATH)], { stdio: "ignore", detached: true });
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
	// RPC loops are live sessions too, even though RPC has no TUI.
	if (!ctx.hasUI && !isLoopActive()) return;

	// Clean up any stale hot-marker left from a prior crashed session.
	fs.rmSync(HOT_MARKER_PATH, { force: true });

	// No passwordless pmset → stay inert and nudge once. Never prompt.
	if (!hasPasswordlessPmset()) {
		nudge();
		return;
	}

	engaged = true;

	// Tell the watcher to hold the lid open, launching it on the first run.
	writeState("1");
	startWatcher();

	// Idle/display/system assertions for the duration of the work. Dies with us
	// as an extra backstop even if the watcher is somehow lost.
	try {
		const p = spawn("caffeinate", ["-dimsu"], { stdio: "ignore", detached: true });
		p.on("error", () => {});
		caffeinateChild = p;
	} catch {
		caffeinateChild = null;
	}

	// Poll for the hot-marker file so we can notify the user once the shell
	// watcher has re-enabled sleep due to battery temperature.
	hotCheckRef = setInterval(() => {
		if (fs.existsSync(HOT_MARKER_PATH)) {
			piApi?.sendMessage({
				customType: "caffeinate:battery-warning",
				content:
					"Battery temperature reached 35 °C — sleep mode re-enabled to protect the battery. The agent run will continue.",
				display: true,
			});
			// Remove the marker so we don't re-notify.
			fs.rmSync(HOT_MARKER_PATH, { force: true });
		}
	}, 5000);
	// Safety cap: clear the interval after 24h even if release is never called.
	setTimeout(() => {
		if (hotCheckRef) {
			clearInterval(hotCheckRef);
			hotCheckRef = null;
		}
	}, 24 * 60 * 60 * 1000);

	setStatus(ctx);
}

function release(ctx: ExtensionContext): void {
	if (!engaged) return;
	engaged = false;

	// The watcher reconciles all live sessions within ~1s; when this was the
	// last hold and the lid is shut, the Mac sleeps then.
	writeState("0");

	if (caffeinateChild) {
		try {
			caffeinateChild.kill();
		} catch {
			// already gone
		}
		caffeinateChild = null;
	}

	// Clean up any in-flight hot-check interval.
	if (hotCheckRef) {
		clearInterval(hotCheckRef);
		hotCheckRef = null;
	}

	setStatus(ctx);
}

export default function (pi: ExtensionAPI) {
	// Subagents share the parent's machine; only the orchestrator manages power.
	if (process.env.PI_SUBAGENT_CHILD === "1") return;

	piApi = pi;
	const lifecycle = new PowerLifecycle<ExtensionContext>(engage, release, () => engaged, isLidClosed);

	// Surface the setup hint right when Pi opens, before any message is sent, so
	// it's discoverable. Only when unconfigured, and only once per session.
	pi.on("session_start", async () => {
		if (!IS_MACOS || !sessionEnabled) return;
		if (!hasPasswordlessPmset()) nudge();
	});

	// Hold power across the entire loop, including delays and checker calls.
	onLoopChange("caffeinate", (active, ctx) => lifecycle.loopChanged(active, ctx));
	pi.on("agent_start", async (_event, ctx) => lifecycle.agentStarted(ctx));
	pi.on("agent_end", async (_event, ctx) => lifecycle.agentEnded(ctx));

	// Teardown: drop the state file and kill caffeinate. The watcher reconciles
	// the global sleep setting on missing state or this pid dying.
	pi.on("session_shutdown", async (_event, ctx) => {
		lifecycle.stop(ctx);
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
				lifecycle.stop(ctx);
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
			} else if (engaged && !isSleepDisabled()) {
				state = "run active, but lid-close protection is off — check battery temperature or power settings.";
			} else if (engaged) {
				state = lifecycle.waitingForLid
					? "active — loop finished with the lid shut; staying awake until it opens."
					: "active — this run or loop keeps the Mac awake, even with the lid closed.";
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
