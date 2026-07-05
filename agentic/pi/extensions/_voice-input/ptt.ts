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
 *     PI_PTT_HOLD_MS (default 700) records. Two mechanisms cover both terminals:
 *     a release-driven one where key releases arrive (iTerm2), and an OS
 *     auto-repeat fallback where they don't (Neovim's :terminal reports the
 *     Kitty protocol active but forwards only bare press bytes).
 *   • Stopping is robust: the held key's auto-repeats act as a keep-alive, and
 *     when they cease (you let go) a watchdog stops recording — this is also how
 *     dictation ends in terminals that never send a release event.
 *   • Transcribe via whisper.cpp (default) or $PI_PTT_TRANSCRIBE_CMD.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { CustomEditor, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	isKeyRelease,
	isKeyRepeat,
	isKittyProtocolActive,
	type KeyId,
	matchesKey,
} from "@earendil-works/pi-tui";

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
/** Repeat-only fallback (Neovim's :terminal): a gap between two Space bytes
 *  longer than this means the key was physically released between them — the OS
 *  auto-repeat interval is well under this, a human's repeated taps are not
 *  always, so it also caps how long a broken run stays "held". */
const REPEAT_MAX_GAP_MS = 300;
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

// Tap-vs-hold state for a typing PTT key (e.g. space). The space is inserted
// immediately on press (so typing feels instant); textBeforeSpace snapshots the
// editor so we can remove that space again if the press turns into a hold.
let holdTimer: ReturnType<typeof setTimeout> | null = null;
let textBeforeSpace: string | null = null;
// Repeat-only fallback state (terminals that report the key event but never a
// release, e.g. Neovim's :terminal). A held key streams auto-repeat bytes; a tap
// is a single byte. We treat a run of same-key bytes (gaps < REPEAT_MAX_GAP_MS)
// held past CONFIG.holdMs as a hold. spaceRunStartAt anchors the run; spaceRunLen
// counts its bytes (≥2 proves auto-repeat, so a lone tap can never record).
let spaceRunStartAt = 0;
let spaceRunLen = 0;
let lastSpaceAt = 0;
// Repeat-gap watchdog: while recording from a hold, the held key keeps firing;
// when it stops, this fires and stops recording (covers dropped release events).
let holdWatchdog: ReturnType<typeof setTimeout> | null = null;

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
	// True once we have ACTUALLY observed a key-release event — not merely
	// because the terminal *claims* the Kitty protocol is active. iTerm2 delivers
	// releases; Neovim's :terminal answers the Kitty negotiation (so
	// isKittyProtocolActive() reports true) yet forwards every key as a bare press
	// byte — no release, no repeat. So this selects the tap/hold ALGORITHM: a
	// release-driven one when releases arrive, else the auto-repeat fallback.
	return releasesSeen;
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

/** Abandon a pending hold (the space was a tap): keep the already-typed space. */
function cancelHoldDetection(): void {
	if (holdTimer) {
		clearTimeout(holdTimer);
		holdTimer = null;
	}
	textBeforeSpace = null;
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
	setStatus(ctx, "🎙 recording…");
	maxDurationTimer = setTimeout(() => {
		if (state === "recording") void stopAndTranscribe(ctx);
	}, MAX_RECORDING_MS);
}

/** Stop recording (finalising the WAV), then transcribe and paste. */
async function stopAndTranscribe(ctx: ExtensionContext): Promise<void> {
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
		try {
			if (liveCtx && matchesKey(data, CONFIG.key as KeyId)) {
				if (this.handlePtt(data, liveCtx)) return; // fully handled → consume
			} else {
				// A different key arrived while a space's hold timer was pending →
				// the space was a tap. It's already inserted, so just cancel the
				// hold detection and let this key type normally.
				if (holdTimer) cancelHoldDetection();
				// A different key also ends any in-progress Space auto-repeat run
				// (fallback path) — so the next Space starts fresh and types.
				spaceRunLen = 0;
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
		if (KEY_IS_TYPING) {
			// Space needs a terminal that at least negotiated the Kitty protocol,
			// so we get a discrete event per keystroke to time (iTerm2 AND Neovim's
			// :terminal both qualify). In a bare legacy terminal it just types — use
			// /talk. The tap/hold ALGORITHM then adapts to whether releases arrive.
			if (!isKittyProtocolActive()) return false;
			return this.handleTypingHold(data, ctx);
		}
		// Non-typing key (f8, etc.).
		if (releasesAvailable()) {
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

	/**
	 * Tap-vs-hold for a typing key, with two mechanisms because terminals differ:
	 *
	 *   • Release-driven (iTerm2, Kitty flag 2): the space is inserted on press
	 *     so typing feels instant; a release before CONFIG.holdMs is a TAP (keep
	 *     the space), a release after is the end of dictation. Flicker-free.
	 *   • Auto-repeat fallback (Neovim's :terminal reports the protocol active but
	 *     never sends releases): a held key streams repeat bytes, a tap is one
	 *     byte. We require a run of same-key bytes (gaps < REPEAT_MAX_GAP_MS) held
	 *     past CONFIG.holdMs — i.e. ≥2 bytes AND enough elapsed — before recording.
	 *     A lone tap (one byte, then a pause) can never satisfy that, and stopping
	 *     falls back to the repeat keep-alive watchdog.
	 */
	private handleTypingHold(data: string, ctx: ExtensionContext): boolean {
		if (isKeyRelease(data)) {
			if (holdTimer) {
				cancelHoldDetection(); // released before threshold → it was a TAP
			} else if (state === "recording") {
				void stopAndTranscribe(ctx); // released after a hold → stop dictation
			}
			spaceRunLen = 0;
			return true;
		}
		// Repeat/press of the held key while recording → keep-alive; the watchdog
		// stops recording once these cease (covers terminals with no release event).
		if (state === "recording") {
			armHoldWatchdog(ctx);
			return true;
		}

		if (releasesSeen) {
			// Release-driven path: the release above cancels a tap or ends a hold.
			if (holdTimer) return true; // repeat within the press window → suppress
			if (isKeyRepeat(data)) return true; // kitty repeat safety
			textBeforeSpace = this.getText();
			super.handleInput(data); // insert the space immediately
			holdTimer = setTimeout(() => {
				holdTimer = null;
				// Became a hold: remove the space we optimistically typed, then record.
				if (textBeforeSpace !== null) {
					this.setText(textBeforeSpace);
					textBeforeSpace = null;
				}
				beginIfReady(ctx);
			}, CONFIG.holdMs);
			return true;
		}

		// Auto-repeat fallback: no releases, so infer hold from a sustained run.
		const now = Date.now();
		if (now - lastSpaceAt > REPEAT_MAX_GAP_MS) {
			spaceRunLen = 0; // gap too long → the previous run ended (key was up)
		}
		lastSpaceAt = now;
		spaceRunLen += 1;
		if (spaceRunLen === 1) {
			// First byte of a run: type the space (a normal space until proven a
			// hold) and anchor the run. Extra bytes below are auto-repeat, so we
			// suppress them — consecutive spaces are meaningless in the input box,
			// which also means a stray tap-run leaves just the one typed space.
			spaceRunStartAt = now;
			textBeforeSpace = this.getText();
			super.handleInput(data);
			return true;
		}
		// spaceRunLen ≥ 2 → the key auto-repeated (it is genuinely held). Once the
		// run has lasted past the hold threshold, it's a hold: strip the space we
		// typed on the first byte and start recording.
		if (now - spaceRunStartAt >= CONFIG.holdMs) {
			if (textBeforeSpace !== null) {
				this.setText(textBeforeSpace);
				textBeforeSpace = null;
			}
			spaceRunLen = 0;
			beginIfReady(ctx);
			// In the no-release fallback, this first recording frame may also be the
			// last repeat before the user lets go. Arm immediately so release is still
			// inferred from silence rather than waiting for one more repeat byte.
			if (getState() === "recording") armHoldWatchdog(ctx);
		}
		return true;
	}
}
