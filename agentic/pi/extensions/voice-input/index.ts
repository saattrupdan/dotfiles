/**
 * Push-to-talk voice input — dictate into the input box with a single key.
 *
 * Hold the PTT key (default F8) to record from the microphone; release to stop,
 * transcribe, and paste the text into the editor at the cursor. `/talk` triggers
 * the same flow for terminals/keys where the hotkey can't be used.
 *
 * ── How "hold" works across terminals (this is the whole trick) ──────────────
 * A terminal only emits a key-RELEASE event if it speaks the Kitty keyboard
 * protocol (Ghostty, Kitty, WezTerm, foot; NOT most builds of iTerm2/Terminal).
 * pi already negotiates that protocol with flag 7 (includes release reporting),
 * so this extension keys off `isKittyProtocolActive()` at runtime:
 *
 *   • Protocol active  → TRUE hold-to-talk. Key-down starts recording, the
 *                        matching key-up stops it. Repeats while held are ignored.
 *   • Protocol absent  → the SAME key auto-degrades to tap-to-toggle: press to
 *                        start, press again to stop. Auto-repeat bursts while a
 *                        key is held are debounced so they don't thrash.
 *
 * There is no in-terminal way to detect "key released" without release events,
 * so tap-to-toggle is the honest fallback rather than a fragile timing hack.
 * Run `verify-key-release.py` in your terminal to see which mode you'll get.
 *
 * Implemented by subclassing pi's `CustomEditor` and overriding `handleInput`
 * for the PTT key only — every other key defers to `super`, and pi copies all
 * app handlers (submit/escape/ctrl-d/shortcuts/autocomplete) onto our subclass,
 * so normal editing is untouched. The override is wrapped in try/catch: any
 * failure falls through to normal editing, so a bug here can never brick typing.
 *
 * ── Transcription backend (priority order) ───────────────────────────────────
 *   1. $PI_PTT_TRANSCRIBE_CMD — a `sh -c` command; the WAV path is exported as
 *      $PI_PTT_AUDIO and stdout is used as the transcript. Plug in a cloud API
 *      (OpenAI/Groq Whisper) or any other tool here.
 *   2. whisper.cpp — $PI_PTT_WHISPER_BIN (default `whisper-cli`) with model
 *      $PI_PTT_WHISPER_MODEL (default ~/.cache/whisper/ggml-base.en.bin).
 *      Setup: `brew install whisper-cpp sox`, then download a model, e.g.
 *        mkdir -p ~/.cache/whisper && curl -L -o ~/.cache/whisper/ggml-base.en.bin \
 *          https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin
 *      (ggml-base.en.bin is English-only; use ggml-small.bin for Danish/other.)
 *
 * ── Config via environment ───────────────────────────────────────────────────
 *   PI_PTT_KEY             PTT KeyId (default "f8"; e.g. "ctrl+space", "f5")
 *   PI_PTT_TRANSCRIBE_CMD  custom transcription command (see above)
 *   PI_PTT_WHISPER_BIN     whisper.cpp binary (default "whisper-cli")
 *   PI_PTT_WHISPER_MODEL   model path (default ~/.cache/whisper/ggml-base.en.bin)
 *   PI_PTT_REC_BIN         recorder binary (default "rec"; SoX)
 *
 * Interactive + orchestrator only: it needs the TUI editor and a real mic, so it
 * stays inert in print/RPC mode and for subagents.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { CustomEditor, type EditorFactory, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, isKittyProtocolActive, matchesKey } from "@earendil-works/pi-tui";

const STATUS_KEY = "voice-input";

/** Resolved once at load — env is stable for the process lifetime. */
const CONFIG = {
	key: process.env.PI_PTT_KEY?.trim() || "f8",
	transcribeCmd: process.env.PI_PTT_TRANSCRIBE_CMD?.trim() || "",
	whisperBin: process.env.PI_PTT_WHISPER_BIN?.trim() || "whisper-cli",
	whisperModel:
		process.env.PI_PTT_WHISPER_MODEL?.trim() ||
		path.join(os.homedir(), ".cache", "whisper", "ggml-base.en.bin"),
	recBin: process.env.PI_PTT_REC_BIN?.trim() || "rec",
};

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

/** Tap-to-toggle entry point (legacy terminals, `/talk`). */
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
 * Editor that turns the PTT key into hold-to-talk (or toggle, per terminal
 * capability). Every non-PTT key defers to CustomEditor untouched.
 */
class PttEditor extends CustomEditor {
	override handleInput(data: string): void {
		try {
			if (matchesKey(data, CONFIG.key) && liveCtx) {
				this.handlePtt(data, liveCtx);
				return;
			}
		} catch {
			// Never let a PTT bug break typing — fall through to normal editing.
		}
		super.handleInput(data);
	}

	private handlePtt(data: string, ctx: ExtensionContext): void {
		if (isKittyProtocolActive()) {
			// Real hold-to-talk: key-down starts, key-up stops, repeats ignored.
			if (isKeyRelease(data)) {
				if (state === "recording") void stopAndTranscribe(ctx);
			} else {
				beginIfReady(ctx);
			}
			return;
		}
		// Legacy terminal: same key toggles, with auto-repeat debounced out.
		const now = Date.now();
		if (now - lastToggleAt < TOGGLE_DEBOUNCE_MS) {
			lastToggleAt = now;
			return;
		}
		lastToggleAt = now;
		toggle(ctx);
	}
}

function installEditor(ctx: ExtensionContext): void {
	liveCtx = ctx;
	if (!ctx.hasUI) return;
	const factory: EditorFactory = (tui, theme, keybindings) =>
		new PttEditor(tui, theme, keybindings);
	ctx.ui.setEditorComponent(factory);
}

export default function (pi: ExtensionAPI) {
	// Subagents share the parent's machine and have no interactive editor.
	if (process.env.PI_SUBAGENT_CHILD === "1") return;

	// Install our editor on startup, and re-install after resets (/reload,
	// session switch both fire session_start again).
	pi.on("session_start", async (_event, ctx) => installEditor(ctx));
	pi.on("agent_start", async (_event, ctx) => {
		liveCtx = ctx;
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
				const mode = isKittyProtocolActive()
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
