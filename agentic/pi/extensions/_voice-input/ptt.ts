/**
 * Shared push-to-talk core — the recording state machine + the `PttEditor`
 * class, used by BOTH the `voice-input` extension and the `splash` extension so
 * hold-to-talk works everywhere, including on the fresh-session splash screen.
 *
 * This is a shared library, not an extension: it lives in a `_`-prefixed dir and
 * is deliberately NOT named index.ts, so pi's discovery doesn't try to load it
 * as an extension factory. Import it explicitly from the sibling extensions.
 *
 * Behaviour:
 *   • Hold the PTT key (default: space) to record; release to transcribe+paste.
 *   • Space uses tap-vs-hold: a quick tap types a space, a hold past
 *     PI_PTT_HOLD_MS (default 700) records. Needs key-release events.
 *   • Stopping is robust: the held key's auto-repeats act as a keep-alive, and
 *     when they cease (you let go) a watchdog stops recording even if the actual
 *     release event was dropped/batched.
 *   • Transcribe via whisper.cpp (default) or $PI_PTT_TRANSCRIBE_CMD.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { CustomEditor, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, isKeyRepeat, isKittyProtocolActive, matchesKey } from "@earendil-works/pi-tui";

const STATUS_KEY = "voice-input";

/** Resolved once at load — env is stable for the process lifetime. */
export const CONFIG = {
	key: process.env.PI_PTT_KEY?.trim() || "space",
	holdMs: Number(process.env.PI_PTT_HOLD_MS) || 700,
	transcribeCmd: process.env.PI_PTT_TRANSCRIBE_CMD?.trim() || "",
	whisperBin: process.env.PI_PTT_WHISPER_BIN?.trim() || "whisper-cli",
	whisperModel:
		process.env.PI_PTT_WHISPER_MODEL?.trim() ||
		path.join(os.homedir(), ".cache", "whisper", "ggml-base.en.bin"),
	recBin: process.env.PI_PTT_REC_BIN?.trim() || "rec",
};

/** A "typing key" produces text, so it needs tap-vs-hold disambiguation. */
export const KEY_IS_TYPING = CONFIG.key === "space" || CONFIG.key.length === 1;

/** Debounce for legacy toggle mode: auto-repeat is fast (~30-60ms); a deliberate
 *  second tap is far slower, so anything within this window is treated as repeat. */
const TOGGLE_DEBOUNCE_MS = 350;
/** How long after the last held-key event (repeat) with no further activity we
 *  treat the key as released and stop — the safety net for dropped/batched
 *  release events. Must exceed the OS key-repeat interval. */
const HOLD_WATCHDOG_MS = 700;
/** Safety cap: auto-stop recording if everything else somehow misses. */
const MAX_RECORDING_MS = 120_000;

/** The temp WAV for the current/last clip, keyed by pid to avoid collisions. */
const WAV_PATH = path.join(os.tmpdir(), `pi-voice-input-${process.pid}.wav`);

/** Whole-transcript hallucinations whisper emits on silence/noise even with
 *  -sns (real words, so structural checks can't catch them). Matched only when
 *  they are the ENTIRE transcript, so genuine dictation is untouched. */
const NOISE_PHRASES = new Set([
	"you",
	"thank you",
	"thanks for watching",
	"thanks for watching!",
	"bye",
	"bye.",
	"okay",
	"so",
]);

type State = "idle" | "recording" | "transcribing";
let state: State = "idle";
let recorder: ChildProcess | null = null;
let nudged = false;
let lastToggleAt = 0;
let maxDurationTimer: ReturnType<typeof setTimeout> | null = null;
let liveCtx: ExtensionContext | null = null;
let releasesSeen = false;
let statusText: string | undefined;

// Tap-vs-hold state for a typing PTT key (e.g. space).
let holdTimer: ReturnType<typeof setTimeout> | null = null;
let pendingPressData: string | null = null;
// Repeat-gap watchdog: while recording from a hold, the held key keeps firing;
// when it stops, this fires and stops recording (covers dropped release events).
let holdWatchdog: ReturnType<typeof setTimeout> | null = null;

/** Opt-in diagnostic log (PI_PTT_DEBUG=1). */
function dbg(line: string): void {
	if (!process.env.PI_PTT_DEBUG) return;
	try {
		fs.appendFileSync("/tmp/pi-voice-input-debug.log", line + "\n");
	} catch {
		// best effort
	}
}

export function setLiveCtx(ctx: ExtensionContext): void {
	liveCtx = ctx;
}
export function getState(): State {
	return state;
}
/** The live PTT status line, or undefined when idle. */
export function getStatusText(): string | undefined {
	return statusText;
}
export function releasesAvailable(): boolean {
	return isKittyProtocolActive() || releasesSeen;
}

function setStatus(ctx: ExtensionContext, text: string | undefined): void {
	statusText = text;
	// setStatus() calls requestRender() internally, so any custom surface that
	// reads getStatusText() (splash's belowEditor widget) refreshes too.
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
export function checkReady(): string | null {
	if (!haveBinary(CONFIG.recBin)) {
		return `Recorder "${CONFIG.recBin}" not found. Install SoX:\n    brew install sox`;
	}
	if (CONFIG.transcribeCmd) return null; // custom command owns its own deps
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
		// -nt: no timestamps; -np: no progress; -sns: suppress non-speech tokens
		// ("(dramatic music)" / "[BLANK_AUDIO]") that whisper hallucinates on silence.
		raw = await run(
			CONFIG.whisperBin,
			["-m", CONFIG.whisperModel, "-f", WAV_PATH, "-nt", "-np", "-sns"],
			{ timeoutMs: 120_000 },
		);
	}
	return raw.replace(/\s+/g, " ").trim();
}

/** True if the transcript is a non-speech artefact rather than dictated words. */
function isNonSpeech(text: string): boolean {
	if (!text) return true;
	if (/^[[(].*[)\]]$/.test(text)) return true; // wholly bracketed/parenthesised
	if (!/[\p{L}\p{N}]/u.test(text)) return true; // punctuation-only
	const norm = text.toLowerCase().replace(/[\s.!?,]+$/u, "").trim();
	return NOISE_PHRASES.has(norm);
}

function clearHoldWatchdog(): void {
	if (holdWatchdog) {
		clearTimeout(holdWatchdog);
		holdWatchdog = null;
	}
}

/** (Re)arm the watchdog that stops recording once the held key stops repeating. */
function armHoldWatchdog(ctx: ExtensionContext): void {
	clearHoldWatchdog();
	holdWatchdog = setTimeout(() => {
		holdWatchdog = null;
		if (state === "recording") {
			dbg("WATCHDOG stop (held key stopped repeating)");
			void stopAndTranscribe(ctx);
		}
	}, HOLD_WATCHDOG_MS);
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
	dbg("REC START");
	setStatus(ctx, "🎙 recording…");
	maxDurationTimer = setTimeout(() => {
		if (state === "recording") void stopAndTranscribe(ctx);
	}, MAX_RECORDING_MS);
}

/** Stop recording (finalising the WAV), then transcribe and paste. */
async function stopAndTranscribe(ctx: ExtensionContext): Promise<void> {
	dbg("STOP called");
	clearHoldWatchdog();
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
			setTimeout(done, 3000); // backstop if the recorder ignores the signal
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
		if (isNonSpeech(text)) {
			notify(ctx, "voice-input: no speech detected.", "info");
		} else {
			ctx.ui.pasteToEditor(text);
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
		if (!nudged) nudged = true;
		notify(ctx, problem, "error");
		return;
	}
	startRecording(ctx);
}

/** Tap-to-toggle entry point (legacy terminals with a non-typing key, `/talk`). */
export function toggle(ctx: ExtensionContext): void {
	if (!ctx.hasUI || state === "transcribing") return;
	if (state === "recording") void stopAndTranscribe(ctx);
	else beginIfReady(ctx);
}

/** Kill any in-flight recording and clear timers (call on session_shutdown). */
export function cleanup(): void {
	if (holdTimer) {
		clearTimeout(holdTimer);
		holdTimer = null;
	}
	clearHoldWatchdog();
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
}

/**
 * Editor that turns the PTT key into hold-to-talk. Every non-PTT key defers to
 * CustomEditor untouched; the PTT branch is try/caught so a bug can't break
 * typing. Used directly by voice-input (post-splash) and wrapped by splash.
 */
export class PttEditor extends CustomEditor {
	// Opt into key-release delivery — the TUI otherwise filters releases out
	// before handleInput, so key-up (which stops a hold) would never arrive.
	wantsKeyRelease = true;

	override handleInput(data: string): void {
		if (!releasesSeen && isKeyRelease(data)) releasesSeen = true;
		dbg(
			`in ${JSON.stringify(data)} rel=${isKeyRelease(data)} rep=${isKeyRepeat(data)}` +
				` match=${matchesKey(data, CONFIG.key)} state=${state} kitty=${isKittyProtocolActive()}` +
				` hold=${holdTimer !== null} wd=${holdWatchdog !== null}`,
		);
		try {
			if (liveCtx && matchesKey(data, CONFIG.key)) {
				if (this.handlePtt(data, liveCtx)) return; // fully handled → consume
			} else {
				// A different key arrived while a space press was deferred → the
				// space was a tap, not a hold. Flush it in order, THEN this key,
				// so fast typing (space+letter rollover) is never transposed.
				if (holdTimer) this.flushPendingSpace();
				// We only want the PTT key's release; drop every other release,
				// because the base editor never normally receives releases and
				// could double-process a keystroke if handed one.
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
		if (KEY_IS_TYPING) {
			if (!releases) return false; // let space type (can't PTT without releases)
			return this.handleTypingHold(data, ctx);
		}
		// Non-typing key (f8, etc.).
		if (releases) {
			if (isKeyRelease(data)) {
				if (state === "recording") void stopAndTranscribe(ctx);
			} else if (state === "recording") {
				armHoldWatchdog(ctx); // held-key repeat keep-alive
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

	/** Insert a deferred (tapped) space press in order and clear pending state. */
	private flushPendingSpace(): void {
		if (holdTimer) {
			clearTimeout(holdTimer);
			holdTimer = null;
		}
		const press = pendingPressData;
		pendingPressData = null;
		if (press) super.handleInput(press);
	}

	/** Tap-vs-hold for a typing key, using key-release events + a repeat watchdog. */
	private handleTypingHold(data: string, ctx: ExtensionContext): boolean {
		if (isKeyRelease(data)) {
			if (holdTimer) {
				this.flushPendingSpace(); // released before threshold → it was a TAP
			} else if (state === "recording") {
				void stopAndTranscribe(ctx); // released after a hold → stop dictation
			}
			return true;
		}
		// Press or repeat of the held key while recording → keep-alive: the
		// watchdog stops recording once these cease, even if the release is lost.
		if (state === "recording") {
			armHoldWatchdog(ctx);
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
