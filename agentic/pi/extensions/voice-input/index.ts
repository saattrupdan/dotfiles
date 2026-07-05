/**
 * Push-to-talk voice input — dictate into the input box by holding a key.
 *
 * Hold the PTT key (default: space) to record from the microphone; release to
 * stop, transcribe, and paste the text into the editor at the cursor. `/talk`
 * triggers the same flow for terminals/keys where the hotkey can't be used.
 *
 * ── SPACE as the PTT key (tap vs hold) ───────────────────────────────────────
 * Space is also a typing key, so a *quick tap* inserts a normal space and only a
 * *held* space (past ~250ms) starts recording. This disambiguation needs the
 * terminal to emit key-RELEASE events (Kitty keyboard protocol); in a legacy
 * terminal (no releases) space simply types a space — space-hold PTT is
 * physically impossible there, so use `/talk` or set PI_PTT_KEY to a non-typing
 * key (e.g. f8). Run verify-key-release.py to see which mode your terminal gives.
 *
 * ── How "hold" works across terminals ────────────────────────────────────────
 * pi negotiates the Kitty protocol with flag 7 (includes release reporting), so
 * we key off `isKittyProtocolActive()` at runtime:
 *   • Protocol active  → real hold-to-talk (key-down/up, tap-vs-hold for space).
 *   • Protocol absent  → a NON-typing PTT key degrades to tap-to-toggle; a typing
 *                        key (space) just types normally (no PTT).
 *
 * ── Coexisting with the splash extension ─────────────────────────────────────
 * Both this and `splash` customise the editor via setEditorComponent, and there
 * is only one editor slot. splash owns the editor during the fresh-session
 * splash screen and clears it on first submit. So we DON'T install our editor on
 * a fresh session_start — we wait for the first agent_start (splash is gone by
 * then). On a session that already has messages (splash is skipped) we install
 * immediately. This keeps splash's narrow box intact and lets it dismiss.
 *
 * Implemented by subclassing pi's `CustomEditor` and overriding `handleInput`
 * for the PTT key only — every other key defers to `super`, and pi copies all
 * app handlers (submit/escape/ctrl-d/shortcuts/autocomplete) onto our subclass.
 * The override is try/caught: any failure falls through to normal editing, so a
 * bug here can never brick typing.
 *
 * ── Transcription backend (priority order) ───────────────────────────────────
 *   1. $PI_PTT_TRANSCRIBE_CMD — a `sh -c` command; the WAV path is exported as
 *      $PI_PTT_AUDIO and stdout is used as the transcript (plug in a cloud API).
 *   2. whisper.cpp — $PI_PTT_WHISPER_BIN (default `whisper-cli`) with model
 *      $PI_PTT_WHISPER_MODEL (default ~/.cache/whisper/ggml-base.en.bin).
 *
 * ── Config via environment ───────────────────────────────────────────────────
 *   PI_PTT_KEY             PTT KeyId (default "space"; e.g. "f8", "ctrl+space")
 *   PI_PTT_HOLD_MS         tap-vs-hold threshold for typing keys (default 250)
 *   PI_PTT_TRANSCRIBE_CMD  custom transcription command (see above)
 *   PI_PTT_WHISPER_BIN     whisper.cpp binary (default "whisper-cli")
 *   PI_PTT_WHISPER_MODEL   model path (default ~/.cache/whisper/ggml-base.en.bin)
 *   PI_PTT_REC_BIN         recorder binary (default "rec"; SoX)
 *
 * Interactive + orchestrator only: needs the TUI editor and a real mic, so it
 * stays inert in print/RPC mode and for subagents.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { CustomEditor, type EditorFactory, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, isKeyRepeat, isKittyProtocolActive, matchesKey } from "@earendil-works/pi-tui";

const STATUS_KEY = "voice-input";

/** Resolved once at load — env is stable for the process lifetime. */
const CONFIG = {
	key: process.env.PI_PTT_KEY?.trim() || "space",
	holdMs: Number(process.env.PI_PTT_HOLD_MS) || 250,
	transcribeCmd: process.env.PI_PTT_TRANSCRIBE_CMD?.trim() || "",
	whisperBin: process.env.PI_PTT_WHISPER_BIN?.trim() || "whisper-cli",
	whisperModel:
		process.env.PI_PTT_WHISPER_MODEL?.trim() ||
		path.join(os.homedir(), ".cache", "whisper", "ggml-base.en.bin"),
	recBin: process.env.PI_PTT_REC_BIN?.trim() || "rec",
};

/** A "typing key" produces text, so it needs tap-vs-hold disambiguation. */
const KEY_IS_TYPING = CONFIG.key === "space" || CONFIG.key.length === 1;

/** Debounce for legacy toggle mode: auto-repeat is fast (~30-60ms); a deliberate
 *  second tap is far slower, so anything within this window is treated as repeat. */
const TOGGLE_DEBOUNCE_MS = 350;
/** Safety cap: auto-stop recording if a release is somehow missed. */
const MAX_RECORDING_MS = 120_000;

/** The temp WAV for the current/last clip, keyed by pid to avoid collisions. */
const WAV_PATH = path.join(os.tmpdir(), `pi-voice-input-${process.pid}.wav`);

type State = "idle" | "recording" | "transcribing";
let state: State = "idle";
let recorder: ChildProcess | null = null;
let nudged = false;
let lastToggleAt = 0;
let maxDurationTimer: ReturnType<typeof setTimeout> | null = null;
/** Latest interactive context, so the editor subclass can drive recording. */
let liveCtx: ExtensionContext | null = null;
/** Whether our PttEditor is currently the installed editor component. */
let editorInstalled = false;
/** Set once we've actually observed a key-release event, so we don't rely solely
 *  on pi's protocol-capability probe (which can under-detect a terminal that
 *  emits releases but doesn't answer the query — e.g. some iTerm2 setups). */
let releasesSeen = false;
/** Are key-release events available? Trust pi's probe, or anything we've seen. */
function releasesAvailable(): boolean {
	return isKittyProtocolActive() || releasesSeen;
}

// Tap-vs-hold state for a typing PTT key (e.g. space).
let holdTimer: ReturnType<typeof setTimeout> | null = null;
let pendingPressData: string | null = null;

function setStatus(ctx: ExtensionContext, text: string | undefined): void {
	if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, text);
}

function notify(ctx: ExtensionContext, msg: string, type: "info" | "error" = "info"): void {
	if (ctx.hasUI) ctx.ui.notify(msg, type);
}

/** Is a binary on PATH (or an absolute path that exists)? */
function haveBinary(bin: string): boolean {
	if (bin.includes("/")) return fs.existsSync(bin);
	try {
		return spawnSync("command", ["-v", bin], { shell: true, stdio: "ignore" }).status === 0;
	} catch {
		return false;
	}
}

/**
 * Preconditions for recording + transcription. Returns an error string to show
 * the user (with setup guidance) or null when everything is in place.
 */
function checkReady(): string | null {
	if (!haveBinary(CONFIG.recBin)) {
		return `Recorder "${CONFIG.recBin}" not found. Install SoX:\n    brew install sox`;
	}
	// A custom transcribe command owns its own dependencies — trust it.
	if (CONFIG.transcribeCmd) return null;

	if (!haveBinary(CONFIG.whisperBin)) {
		return (
			`Transcriber "${CONFIG.whisperBin}" not found. Install whisper.cpp:\n` +
			`    brew install whisper-cpp\n` +
			`Or set PI_PTT_TRANSCRIBE_CMD to use a cloud API.`
		);
	}
	if (!fs.existsSync(CONFIG.whisperModel)) {
		return (
			`Whisper model missing: ${CONFIG.whisperModel}\nDownload one, e.g.:\n` +
			`    mkdir -p ${path.dirname(CONFIG.whisperModel)} && \\\n` +
			`    curl -L -o ${CONFIG.whisperModel} \\\n` +
			`      https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin`
		);
	}
	return null;
}

/** Run a command to completion, capturing stdout. Rejects on non-zero exit. */
function run(
	cmd: string,
	args: string[],
	opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(cmd, args, {
			stdio: ["ignore", "pipe", "pipe"],
			env: opts.env ?? process.env,
		});
		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (d) => (stdout += d.toString()));
		child.stderr?.on("data", (d) => (stderr += d.toString()));
		const timer = opts.timeoutMs
			? setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs)
			: null;
		child.on("error", (err) => {
			if (timer) clearTimeout(timer);
			reject(err);
		});
		child.on("close", (code) => {
			if (timer) clearTimeout(timer);
			if (code === 0) resolve(stdout);
			else reject(new Error(stderr.trim() || `${cmd} exited with code ${code}`));
		});
	});
}

/** Transcribe the recorded WAV to text using the configured backend. */
async function transcribe(): Promise<string> {
	let raw: string;
	if (CONFIG.transcribeCmd) {
		raw = await run("sh", ["-c", CONFIG.transcribeCmd], {
			env: { ...process.env, PI_PTT_AUDIO: WAV_PATH },
			timeoutMs: 120_000,
		});
	} else {
		// whisper.cpp prints the transcription (no timestamps with -nt) to stdout.
		raw = await run(
			CONFIG.whisperBin,
			["-m", CONFIG.whisperModel, "-f", WAV_PATH, "-nt", "-np"],
			{ timeoutMs: 120_000 },
		);
	}
	return raw.replace(/\s+/g, " ").trim();
}

/** Start recording. Assumes preconditions were already checked. */
function startRecording(ctx: ExtensionContext): void {
	fs.rmSync(WAV_PATH, { force: true });
	try {
		recorder = spawn(
			CONFIG.recBin,
			["-q", "-c", "1", "-r", "16000", "-b", "16", WAV_PATH],
			{ stdio: "ignore" },
		);
	} catch (err) {
		notify(ctx, `voice-input: failed to start recorder: ${String(err)}`, "error");
		state = "idle";
		setStatus(ctx, undefined);
		return;
	}
	recorder.on("error", (err) => {
		notify(ctx, `voice-input: recorder error: ${err.message}`, "error");
		recorder = null;
		state = "idle";
		setStatus(ctx, undefined);
	});
	state = "recording";
	setStatus(ctx, "🎙 recording…");
	maxDurationTimer = setTimeout(() => {
		if (state === "recording") void stopAndTranscribe(ctx);
	}, MAX_RECORDING_MS);
}

/** Stop recording (finalising the WAV), then transcribe and paste. */
async function stopAndTranscribe(ctx: ExtensionContext): Promise<void> {
	if (maxDurationTimer) {
		clearTimeout(maxDurationTimer);
		maxDurationTimer = null;
	}
	state = "transcribing";
	setStatus(ctx, "⏳ transcribing…");

	// SoX flushes and writes the WAV trailer on SIGINT; wait for it to exit.
	if (recorder) {
		const proc = recorder;
		await new Promise<void>((resolve) => {
			const done = () => resolve();
			proc.once("close", done);
			try {
				proc.kill("SIGINT");
			} catch {
				done();
			}
			// Backstop: don't hang forever if the recorder ignores the signal.
			setTimeout(done, 3000);
		});
		recorder = null;
	}

	if (!fs.existsSync(WAV_PATH) || fs.statSync(WAV_PATH).size < 1024) {
		notify(ctx, "voice-input: no audio captured.", "error");
		state = "idle";
		setStatus(ctx, undefined);
		return;
	}

	try {
		const text = await transcribe();
		if (text) {
			ctx.ui.pasteToEditor(text);
		} else {
			notify(ctx, "voice-input: nothing was transcribed.", "info");
		}
	} catch (err) {
		notify(ctx, `voice-input: transcription failed: ${String(err)}`, "error");
	} finally {
		fs.rmSync(WAV_PATH, { force: true });
		state = "idle";
		setStatus(ctx, undefined);
	}
}

/** Begin recording if idle and the toolchain is ready; otherwise nudge. */
function beginIfReady(ctx: ExtensionContext): void {
	if (!ctx.hasUI || state !== "idle") return;
	const problem = checkReady();
	if (problem) {
		nudge(ctx, problem);
		return;
	}
	startRecording(ctx);
}

/** Tap-to-toggle entry point (legacy terminals with a non-typing key, `/talk`). */
function toggle(ctx: ExtensionContext): void {
	if (!ctx.hasUI || state === "transcribing") return;
	if (state === "recording") void stopAndTranscribe(ctx);
	else beginIfReady(ctx);
}

/** Show a setup hint (at most once per session) as an error toast. */
function nudge(ctx: ExtensionContext, msg: string): void {
	if (!nudged) nudged = true;
	notify(ctx, msg, "error");
}

/**
 * Editor that turns the PTT key into hold-to-talk. Every non-PTT key defers to
 * CustomEditor untouched; the PTT branch is try/caught by the caller.
 */
class PttEditor extends CustomEditor {
	// Opt into key-release delivery — the TUI otherwise filters releases out
	// before handleInput, so key-up (which stops a hold) would never arrive.
	wantsKeyRelease = true;

	override handleInput(data: string): void {
		// Learn the terminal's capability from real traffic: any release event
		// (for any key) proves hold-to-talk is possible.
		if (!releasesSeen && isKeyRelease(data)) releasesSeen = true;
		try {
			if (liveCtx && matchesKey(data, CONFIG.key)) {
				if (this.handlePtt(data, liveCtx)) return; // fully handled → consume
			} else {
				// A different key arrived while a space press was deferred → the
				// space was a tap, not a hold. Flush it in order, THEN this key,
				// so fast typing (space+letter rollover) is never transposed.
				if (holdTimer) this.flushPendingSpace();
				// We only want the PTT key's release; every OTHER release must be
				// dropped, because the base editor never normally receives releases
				// and could double-process a keystroke if handed one.
				if (isKeyRelease(data)) return;
			}
		} catch {
			// Never let a PTT bug break typing — fall through to normal editing.
		}
		super.handleInput(data);
	}

	/** Returns true if the key was consumed; false to let it type normally. */
	private handlePtt(data: string, ctx: ExtensionContext): boolean {
		const releases = releasesAvailable();

		// A typing key (space) can only be PTT where releases exist; otherwise it
		// must type normally.
		if (KEY_IS_TYPING) {
			if (!releases) return false; // let space type
			return this.handleTypingHold(data, ctx);
		}

		// Non-typing key (f8, etc.).
		if (releases) {
			if (isKeyRelease(data)) {
				if (state === "recording") void stopAndTranscribe(ctx);
			} else if (!isKeyRepeat(data)) {
				beginIfReady(ctx);
			}
			return true;
		}
		// Legacy: toggle, debouncing auto-repeat bursts.
		const now = Date.now();
		if (now - lastToggleAt >= TOGGLE_DEBOUNCE_MS) {
			lastToggleAt = now;
			toggle(ctx);
		} else {
			lastToggleAt = now;
		}
		return true;
	}

	/** Insert a deferred (tapped) space press in order and clear the pending state. */
	private flushPendingSpace(): void {
		if (holdTimer) {
			clearTimeout(holdTimer);
			holdTimer = null;
		}
		const press = pendingPressData;
		pendingPressData = null;
		if (press) super.handleInput(press);
	}

	/** Tap-vs-hold for a typing key, using key-release events. */
	private handleTypingHold(data: string, ctx: ExtensionContext): boolean {
		if (isKeyRelease(data)) {
			if (holdTimer) {
				// Released before the threshold → it was a TAP: type the key.
				this.flushPendingSpace();
			} else if (state === "recording") {
				// Released after a hold → stop dictation.
				void stopAndTranscribe(ctx);
			}
			return true;
		}
		if (isKeyRepeat(data)) return true; // held; the timer decides. Consume.
		// Press: defer. Start recording only if still held past the threshold.
		if (state === "idle" && !holdTimer) {
			pendingPressData = data;
			holdTimer = setTimeout(() => {
				holdTimer = null;
				pendingPressData = null;
				beginIfReady(ctx);
			}, CONFIG.holdMs);
		}
		return true;
	}
}

function installEditor(ctx: ExtensionContext): void {
	liveCtx = ctx;
	if (!ctx.hasUI || editorInstalled) return;
	const factory: EditorFactory = (tui, theme, keybindings) =>
		new PttEditor(tui, theme, keybindings);
	ctx.ui.setEditorComponent(factory);
	editorInstalled = true;
}

/** Does the current session already contain messages? (splash is skipped then.) */
function sessionHasMessages(ctx: ExtensionContext): boolean {
	try {
		return ctx.sessionManager.getEntries().some((e) => e.type === "message");
	} catch {
		return false;
	}
}

export default function (pi: ExtensionAPI) {
	// Subagents share the parent's machine and have no interactive editor.
	if (process.env.PI_SUBAGENT_CHILD === "1") return;

	pi.on("session_start", async (_event, ctx) => {
		liveCtx = ctx;
		// A reset cleared any editor we installed; if splash is skipped (session
		// already has messages) we can safely own the editor now. On a fresh
		// session we wait for agent_start so splash keeps its splash-screen editor.
		editorInstalled = false;
		if (sessionHasMessages(ctx)) installEditor(ctx);
	});
	pi.on("agent_start", async (_event, ctx) => {
		// By the first agent_start the splash has dismissed its editor, so it's
		// safe to install ours.
		installEditor(ctx);
	});

	pi.registerCommand("talk", {
		description: "Voice dictation: toggle recording (or `status`).",
		async handler(args, ctx) {
			liveCtx = ctx;
			const arg = args.trim().toLowerCase();
			if (arg === "status") {
				const problem = checkReady();
				const backend = CONFIG.transcribeCmd
					? "custom command ($PI_PTT_TRANSCRIBE_CMD)"
					: `whisper.cpp (${CONFIG.whisperBin}, model ${CONFIG.whisperModel})`;
				const releases = releasesAvailable();
				const mode = KEY_IS_TYPING
					? releases
						? `hold-to-talk (tap "${CONFIG.key}" = type, hold = record)`
						: `typing only — "${CONFIG.key}" can't be PTT without key-releases; use /talk`
					: releases
						? "hold-to-talk (terminal reports key releases)"
						: "tap-to-toggle (terminal has no key-release events)";
				const lines = [
					`Voice input — PTT key: ${CONFIG.key}`,
					`Mode: ${mode}`,
					`Backend: ${backend}`,
					`State: ${state}`,
					problem ? `⚠ Not ready:\n${problem}` : "✓ Ready.",
				];
				pi.sendMessage({
					customType: "voice-input:status",
					content: lines.join("\n"),
					display: true,
				});
				return;
			}
			toggle(ctx);
		},
	});

	// Clean up any in-flight recording on shutdown.
	pi.on("session_shutdown", async () => {
		if (holdTimer) {
			clearTimeout(holdTimer);
			holdTimer = null;
		}
		if (maxDurationTimer) {
			clearTimeout(maxDurationTimer);
			maxDurationTimer = null;
		}
		if (recorder) {
			try {
				recorder.kill("SIGKILL");
			} catch {
				// already gone
			}
			recorder = null;
		}
		fs.rmSync(WAV_PATH, { force: true });
	});
}
