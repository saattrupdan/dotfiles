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
 *   • Default: streaming mode using whisper-stream.sh wrapper around whisper-server
 *     (if the wrapper exists). Records raw PCM s16le mono 16 kHz, streams to
 *     whisper-server in chunks, shows partials in status, pastes final on release.
 *   • Fallback: if $PI_PTT_STREAM_CMD is unset or wrapper missing, records a temp
 *     WAV then transcribes via whisper-cli or $PI_PTT_TRANSCRIBE_CMD.
 *   • Streaming backend contract: stdin raw PCM s16le mono 16 kHz,
 *     stdout JSONL events {"type":"partial"|"final","text":"..."}.
 *     Partials are status-only; final is pasted. Failures fall back to WAV path.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
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
	type TUI,
	type EditorTheme,
} from "@earendil-works/pi-tui";
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "voice-input";

/** Resolved once at load — env is stable for the process lifetime. */
const EXTENSION_DIR = path.join(os.homedir(), "gitsky", "dotfiles", "agentic", "pi", "extensions", "_voice-input");
const DEFAULT_STREAM_WRAPPER = path.join(EXTENSION_DIR, "bin", "whisper-stream.sh");
const HAS_STREAM_WRAPPER = fs.existsSync(DEFAULT_STREAM_WRAPPER);

export const CONFIG = {
	key: process.env.PI_PTT_KEY?.trim() || "space",
	holdMs: Number(process.env.PI_PTT_HOLD_MS) || 700,
	transcribeCmd: process.env.PI_PTT_TRANSCRIBE_CMD?.trim() || "",
	streamCmd: process.env.PI_PTT_STREAM_CMD?.trim() || (HAS_STREAM_WRAPPER ? DEFAULT_STREAM_WRAPPER : ""),
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
/** Repeat-only fallback (Neovim's :terminal): the first OS repeat can be
 *  delayed longer than the steady-state repeat cadence, especially with custom
 *  keyboard settings. */
const REPEAT_MAX_INITIAL_GAP_MS = 1_100;
/** The first OS repeat should not arrive immediately; repeated human taps can. */
const REPEAT_MIN_INITIAL_GAP_MS = 250;
/** Once OS repeat starts, following gaps should be much shorter than tap cadence. */
const REPEAT_MAX_CONTINUATION_GAP_MS = 220;
/** If a plausible repeat candidate stalls, flush it back as typed spaces. */
const REPEAT_CANDIDATE_STALL_MS = REPEAT_MAX_CONTINUATION_GAP_MS + 120;
/** Consecutive OS repeat gaps should be reasonably regular. */
const REPEAT_MAX_JITTER_MS = 100;
/** OS continuation repeat should be noticeably faster than its initial delay. */
const REPEAT_MAX_CONTINUATION_TO_INITIAL_RATIO = 0.8;
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
type StreamEvent = { type?: unknown; text?: unknown; partial?: unknown; final?: unknown; is_final?: unknown };
export type ParsedStreamEvent = { kind: "partial" | "final"; text: string } | { kind: "ignore" };
type StreamSession = {
	pcmChunks: Buffer[];
	stdoutBuffer: string;
	partialText: string;
	finalText: string;
	failed: boolean;
	failureReason: string;
	prefixText: string; // text in editor before recording started
	partialStart: number; // character index where partial text starts
	partialLen: number; // length of current partial text in editor
};
let state: State = "idle";
let recorder: ChildProcess | null = null;
let streamBackend: ChildProcess | null = null;
let nudged = false;
let lastToggleAt = 0;
let maxDurationTimer: ReturnType<typeof setTimeout> | null = null;
let liveCtx: ExtensionContext | null = null;
let liveEditor: PttEditor | null = null; // current editor instance for inline updates
let releasesSeen = false;
let statusText: string | undefined;
let streamSession: StreamSession | null = null;

// Tap-vs-hold state for a typing PTT key (e.g. space). The space is inserted
// immediately on press (so typing feels instant); textBeforeSpace snapshots the
// editor so we can remove that space again if the press turns into a hold.
let holdTimer: ReturnType<typeof setTimeout> | null = null;
let textBeforeSpace: string | null = null;
// Repeat-only fallback state (terminals that report the key event but never a
// release, e.g. Neovim's :terminal). A held key streams OS auto-repeat bytes; a
// tap is a single byte. We require the first repeat to arrive after an initial
// repeat delay, then require short/regular continuation gaps. Human tap runs are
// flushed back to normal typed spaces instead of being allowed to become holds.
let spaceRunStartAt = 0;
let spaceRunLen = 0;
let lastSpaceAt = 0;
let spaceRepeatCandidate = false;
let initialRepeatGap = 0;
let lastContinuationGap = 0;
let continuationRepeatCount = 0;
let bufferedSpaceRepeats = 0;
let spaceRepeatFlushTimer: ReturnType<typeof setTimeout> | null = null;
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
function killQuietly(proc: ChildProcess): void {
	try {
		proc.kill("SIGKILL");
	} catch {
		// already gone
	}
}

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


export function writeWavFromPcm(pathname: string, chunks: Buffer[]): void {
	const pcm = Buffer.concat(chunks);
	const header = Buffer.alloc(44);
	header.write("RIFF", 0, "ascii");
	header.writeUInt32LE(36 + pcm.length, 4);
	header.write("WAVE", 8, "ascii");
	header.write("fmt ", 12, "ascii");
	header.writeUInt32LE(16, 16); // PCM fmt chunk length
	header.writeUInt16LE(1, 20); // PCM
	header.writeUInt16LE(1, 22); // mono
	header.writeUInt32LE(16_000, 24);
	header.writeUInt32LE(16_000 * 2, 28); // byte rate
	header.writeUInt16LE(2, 32); // block align
	header.writeUInt16LE(16, 34); // bits/sample
	header.write("data", 36, "ascii");
	header.writeUInt32LE(pcm.length, 40);
	fs.writeFileSync(pathname, Buffer.concat([header, pcm]));
}

function streamText(value: unknown): string | null {
	return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : null;
}

export function parseStreamEvent(event: StreamEvent): ParsedStreamEvent {
	const typed = typeof event.type === "string" ? event.type : "";
	const finalText = streamText(event.final) ?? (event.is_final === true ? streamText(event.text) : null);
	const partialText = streamText(event.partial);
	if (typed === "final" || finalText !== null) {
		return { kind: "final", text: streamText(event.text) ?? finalText ?? "" };
	}
	if (typed === "partial" || partialText !== null) {
		return { kind: "partial", text: streamText(event.text) ?? partialText ?? "" };
	}
	return { kind: "ignore" };
}

function applyStreamEvent(ctx: ExtensionContext, event: StreamEvent): void {
	if (!streamSession || !liveEditor) return;
	const parsed = parseStreamEvent(event);
	if (parsed.kind === "final") {
		streamSession.finalText = parsed.text;
		if (streamSession.finalText) {
			// Replace partial with final in editor
			const currentText = liveEditor.getText();
			const before = currentText.slice(0, streamSession.partialStart);
			const after = currentText.slice(streamSession.partialStart + streamSession.partialLen);
			liveEditor.setText(before + streamSession.finalText + after);
			streamSession.partialLen = streamSession.finalText.length;
			setStatus(ctx, `🎙 final: ${streamSession.finalText}`);
		}
		return;
	}
	if (parsed.kind === "partial") {
		streamSession.partialText = parsed.text;
		// Insert/update partial inline in editor
		const currentText = liveEditor.getText();
		const before = currentText.slice(0, streamSession.partialStart);
		const after = currentText.slice(streamSession.partialStart + streamSession.partialLen);
		const newText = streamSession.prefixText + (streamSession.partialText ? " " + streamSession.partialText : "");
		liveEditor.setText(before + newText + after);
		streamSession.partialLen = newText.length;
		setStatus(ctx, `🎙 ${streamSession.partialText}`);
	}
}

function parseStreamLines(ctx: ExtensionContext, text: string): void {
	if (!streamSession) return;
	streamSession.stdoutBuffer += text;
	for (;;) {
		const newline = streamSession.stdoutBuffer.indexOf("\n");
		if (newline < 0) break;
		const line = streamSession.stdoutBuffer.slice(0, newline).trim();
		streamSession.stdoutBuffer = streamSession.stdoutBuffer.slice(newline + 1);
		if (!line) continue;
		try {
			applyStreamEvent(ctx, JSON.parse(line) as StreamEvent);
		} catch (err) {
			streamSession.failed = true;
			streamSession.failureReason = `malformed stream JSONL: ${String(err)}`;
		}
	}
}

function flushStreamLine(ctx: ExtensionContext): void {
	if (!streamSession) return;
	const line = streamSession.stdoutBuffer.trim();
	streamSession.stdoutBuffer = "";
	if (!line) return;
	try {
		applyStreamEvent(ctx, JSON.parse(line) as StreamEvent);
	} catch (err) {
		streamSession.failed = true;
		streamSession.failureReason = `malformed stream JSONL: ${String(err)}`;
	}
}

async function waitForClose(proc: ChildProcess, timeoutMs: number): Promise<void> {
	if (proc.exitCode !== null) return;
	let timer: ReturnType<typeof setTimeout> | null = null;
	try {
		await Promise.race([
			once(proc, "close"),
			new Promise<void>((resolve) => {
				timer = setTimeout(resolve, timeoutMs);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

function startStreamingBackend(ctx: ExtensionContext): void {
	if (!streamSession || !CONFIG.streamCmd) return;
	try {
		streamBackend = spawn("sh", ["-c", CONFIG.streamCmd], {
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env, PI_PTT_AUDIO_FORMAT: "s16le", PI_PTT_AUDIO_RATE: "16000", PI_PTT_AUDIO_CHANNELS: "1" },
		});
	} catch (err) {
		streamSession.failed = true;
		streamSession.failureReason = `failed to start stream backend: ${String(err)}`;
		return;
	}
	streamBackend.stdin?.on("error", (err) => {
		if (!streamSession) return;
		streamSession.failed = true;
		streamSession.failureReason = `stream backend stdin error: ${err.message}`;
	});
	streamBackend.stdout?.on("data", (d) => parseStreamLines(ctx, d.toString()));
	streamBackend.stderr?.on("data", () => {
		// Keep stderr drained so a chatty backend cannot block.
	});
	streamBackend.on("error", (err) => {
		if (!streamSession) return;
		streamSession.failed = true;
		streamSession.failureReason = `stream backend error: ${err.message}`;
	});
	streamBackend.on("close", (code) => {
		if (!streamSession) return;
		flushStreamLine(ctx);
		if (code !== 0 && !streamSession.finalText) {
			streamSession.failed = true;
			streamSession.failureReason = `stream backend exited with code ${code}`;
		}
	});
}

function startRawRecorder(ctx: ExtensionContext): ChildProcess | null {
	try {
		return spawn(
			CONFIG.recBin,
			["-q", "-c", "1", "-r", "16000", "-b", "16", "-e", "signed-integer", "-L", "-t", "raw", "-"],
			{ stdio: ["ignore", "pipe", "ignore"] },
		);
	} catch (err) {
		notify(ctx, `voice-input: failed to start recorder: ${String(err)}`, "error");
		return null;
	}
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
	streamSession = null;
	streamBackend = null;

	if (CONFIG.streamCmd) {
		// Capture prefix and insert a space to separate streaming text from prior content
		const prefixText = liveEditor ? liveEditor.getText() : "";
		if (liveEditor && prefixText && !prefixText.endsWith(" ")) {
			liveEditor.setText(prefixText + " ");
		}
		streamSession = {
			pcmChunks: [],
			stdoutBuffer: "",
			partialText: "",
			finalText: "",
			failed: false,
			failureReason: "",
			prefixText: prefixText,
			partialStart: prefixText.length + (prefixText && !prefixText.endsWith(" ") ? 1 : 0),
			partialLen: 0,
		};
		startStreamingBackend(ctx);
		recorder = startRawRecorder(ctx);
		if (!recorder) {
			if (streamBackend) killQuietly(streamBackend);
			streamBackend = null;
			streamSession = null;
			state = "idle";
			setStatus(ctx, undefined);
			return;
		}
		recorder.stdout?.on("data", (chunk: Buffer) => {
			streamSession?.pcmChunks.push(Buffer.from(chunk));
			if (streamBackend?.stdin?.writable && !streamBackend.stdin.destroyed) {
				streamBackend.stdin.write(chunk);
			}
		});
	} else {
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
	}

	recorder.on("error", (err) => {
		notify(ctx, `voice-input: recorder error: ${err.message}`, "error");
		recorder = null;
		if (streamBackend) killQuietly(streamBackend);
		streamBackend = null;
		streamSession = null;
		state = "idle";
		setStatus(ctx, undefined);
	});
	state = "recording";
	setStatus(ctx, CONFIG.streamCmd ? "🎙 streaming…" : "🎙 recording…");
	maxDurationTimer = setTimeout(() => {
		if (state === "recording") void stopAndTranscribe(ctx);
	}, MAX_RECORDING_MS);
}

async function stopRecorder(): Promise<void> {
	if (!recorder) return;
	const proc = recorder;
	try {
		proc.kill("SIGINT");
	} catch {
		// already gone
	}
	await waitForClose(proc, 3000);
	if (recorder === proc) recorder = null;
}

async function stopStreamingBackend(ctx: ExtensionContext): Promise<string> {
	const session = streamSession;
	const proc = streamBackend;
	if (!session) return "";
	if (proc) {
		try {
			proc.stdin?.end();
		} catch {
			// already closed
		}
		await waitForClose(proc, 1500);
		if (proc.exitCode === null) proc.kill("SIGTERM");
		await waitForClose(proc, 500);
		if (proc.exitCode === null) proc.kill("SIGKILL");
		flushStreamLine(ctx);
	}
	streamBackend = null;
	if (session.finalText && !session.failed) return session.finalText;
	return "";
}

async function fallbackTranscribeFromStream(ctx: ExtensionContext, reason: string): Promise<string> {
	const chunks = streamSession?.pcmChunks ?? [];
	if (chunks.length === 0 || Buffer.concat(chunks).length < 1024) return "";
	writeWavFromPcm(WAV_PATH, chunks);
	if (reason) notify(ctx, `voice-input: streaming failed; falling back (${reason}).`, "info");
	return transcribe();
}

/** Stop recording (finalising audio), then transcribe and paste. */
async function stopAndTranscribe(ctx: ExtensionContext): Promise<void> {
	clearHoldWatchdog();
	if (maxDurationTimer) {
		clearTimeout(maxDurationTimer);
		maxDurationTimer = null;
	}
	state = "transcribing";
	setStatus(ctx, "⏳ transcribing…");

	await stopRecorder();

	try {
		let text = "";
		if (streamSession) {
			text = await stopStreamingBackend(ctx);
			if (!text) {
				const reason = streamSession.failed
					? streamSession.failureReason || "stream backend failed"
					: "no final transcript";
				text = await fallbackTranscribeFromStream(ctx, reason);
			}
		} else {
			if (!fs.existsSync(WAV_PATH) || fs.statSync(WAV_PATH).size < 1024) {
				notify(ctx, "voice-input: no audio captured.", "error");
				return;
			}
			text = await transcribe();
		}

		if (isNonSpeech(text)) {
			notify(ctx, "voice-input: no speech detected.", "info");
		} else {
			// If streaming was active with inline partials, replace at the partial position
			if (streamSession && streamSession.partialStart >= 0 && liveEditor) {
				const currentText = liveEditor.getText();
				const before = currentText.slice(0, streamSession.partialStart);
				const after = currentText.slice(streamSession.partialStart + streamSession.partialLen);
				// Ensure a space between prefix and new text if needed
				let finalText = text;
				if (before && !before.endsWith(" ") && finalText && !finalText.startsWith(" ")) {
					finalText = " " + finalText;
				}
				liveEditor.setText(before + finalText + after);
			} else {
				ctx.ui.pasteToEditor(text);
			}
		}
	} catch (err) {
		notify(ctx, `voice-input: transcription failed: ${String(err)}`, "error");
	} finally {
		fs.rmSync(WAV_PATH, { force: true });
		streamSession = null;
		streamBackend = null;
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
	if (spaceRepeatFlushTimer) {
		clearTimeout(spaceRepeatFlushTimer);
		spaceRepeatFlushTimer = null;
	}
	clearHoldWatchdog();
	if (maxDurationTimer) {
		clearTimeout(maxDurationTimer);
		maxDurationTimer = null;
	}
	if (recorder) {
		killQuietly(recorder);
		recorder = null;
	}
	if (streamBackend) {
		killQuietly(streamBackend);
		streamBackend = null;
	}
	streamSession = null;
	liveEditor = null;
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

	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) {
		super(tui, theme, keybindings);
		// eslint-disable-next-line @typescript-eslint/no-this-alias
		liveEditor = this;
	}

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
				// (fallback path). Flush buffered candidate repeats first so manual
				// Space taps are preserved in order before this key types normally.
				this.flushBufferedSpaceRepeats();
				this.resetSpaceRepeatRun();
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

	private clearSpaceRepeatFlushTimer(): void {
		if (spaceRepeatFlushTimer) {
			clearTimeout(spaceRepeatFlushTimer);
			spaceRepeatFlushTimer = null;
		}
	}

	private flushBufferedSpaceRepeats(): void {
		this.clearSpaceRepeatFlushTimer();
		while (bufferedSpaceRepeats > 0) {
			bufferedSpaceRepeats -= 1;
			super.handleInput(" ");
		}
	}

	private armSpaceRepeatFlush(): void {
		this.clearSpaceRepeatFlushTimer();
		spaceRepeatFlushTimer = setTimeout(() => {
			spaceRepeatFlushTimer = null;
			this.flushBufferedSpaceRepeats();
			this.resetSpaceRepeatRun();
		}, REPEAT_CANDIDATE_STALL_MS);
	}

	private startSpaceTapRun(data: string, now: number): void {
		this.clearSpaceRepeatFlushTimer();
		spaceRunStartAt = now;
		lastSpaceAt = now;
		spaceRunLen = 1;
		spaceRepeatCandidate = false;
		initialRepeatGap = 0;
		lastContinuationGap = 0;
		continuationRepeatCount = 0;
		bufferedSpaceRepeats = 0;
		textBeforeSpace = this.getText();
		super.handleInput(data);
	}

	private resetSpaceRepeatRun(): void {
		this.clearSpaceRepeatFlushTimer();
		spaceRunLen = 0;
		spaceRepeatCandidate = false;
		initialRepeatGap = 0;
		lastContinuationGap = 0;
		continuationRepeatCount = 0;
		bufferedSpaceRepeats = 0;
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
	 *     byte. We require timing that looks like OS auto-repeat: an initial repeat
	 *     delay, then short/regular continuation gaps held past CONFIG.holdMs.
	 *     Human tap runs are reset and typed as spaces rather than recording.
	 */
	private handleTypingHold(data: string, ctx: ExtensionContext): boolean {
		if (isKeyRelease(data)) {
			if (holdTimer) {
				cancelHoldDetection(); // released before threshold → it was a TAP
			} else if (state === "recording") {
				void stopAndTranscribe(ctx); // released after a hold → stop dictation
			}
			this.resetSpaceRepeatRun();
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

		// Auto-repeat fallback: no releases, so infer hold from OS-repeat timing.
		const now = Date.now();
		const gap = lastSpaceAt ? now - lastSpaceAt : 0;
		if (spaceRunLen === 0) {
			this.startSpaceTapRun(data, now);
			return true;
		}

		if (!spaceRepeatCandidate) {
			if (gap < REPEAT_MIN_INITIAL_GAP_MS || gap > REPEAT_MAX_INITIAL_GAP_MS) {
				// Too fast for the first OS repeat, or too slow to be the same hold:
				// treat this as another tap and type it rather than suppressing it.
				this.flushBufferedSpaceRepeats();
				this.startSpaceTapRun(data, now);
				return true;
			}
			spaceRepeatCandidate = true;
			initialRepeatGap = gap;
			spaceRunLen += 1;
			lastSpaceAt = now;
			bufferedSpaceRepeats += 1;
			this.armSpaceRepeatFlush();
			return true;
		}

		const tooSlow = gap > REPEAT_MAX_CONTINUATION_GAP_MS;
		const tooCloseToInitialDelay =
			gap > initialRepeatGap * REPEAT_MAX_CONTINUATION_TO_INITIAL_RATIO;
		const tooIrregular =
			lastContinuationGap > 0 &&
			Math.abs(gap - lastContinuationGap) > REPEAT_MAX_JITTER_MS;
		if (tooSlow || tooCloseToInitialDelay || tooIrregular) {
			// Looks like tapping, not OS repeat. Flush suppressed candidate spaces and
			// let this byte become a normal typed space.
			this.flushBufferedSpaceRepeats();
			this.startSpaceTapRun(data, now);
			return true;
		}

		spaceRunLen += 1;
		lastSpaceAt = now;
		lastContinuationGap = gap;
		continuationRepeatCount += 1;
		bufferedSpaceRepeats += 1;
		this.armSpaceRepeatFlush();
		// Require OS-repeat-like timing: plausible initial delay, at least one
		// short continuation gap, and elapsed hold time. If the initial delay has
		// already exceeded the threshold, the first continuation can confirm hold.
		if (continuationRepeatCount >= 1 && now - spaceRunStartAt >= CONFIG.holdMs) {
			if (textBeforeSpace !== null) {
				this.setText(textBeforeSpace);
				textBeforeSpace = null;
			}
			this.resetSpaceRepeatRun();
			beginIfReady(ctx);
			// In the no-release fallback, this first recording frame may also be the
			// last repeat before the user lets go. Arm immediately so release is still
			// inferred from silence rather than waiting for one more repeat byte.
			if (getState() === "recording") armHoldWatchdog(ctx);
		}
		return true;
	}
}
