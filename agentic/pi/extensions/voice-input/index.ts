/**
 * Push-to-talk voice input — dictate into the input box with a single hotkey.
 *
 * Press the toggle key (default Ctrl+B, or run `/talk`) once to start recording
 * from the microphone, then press it again to stop. The recording is transcribed
 * and the resulting text is pasted straight into the editor at the cursor.
 *
 *   • 1st press → `rec` (SoX) starts capturing 16 kHz mono audio to a temp WAV.
 *                 The footer shows "🎙 recording…".
 *   • 2nd press → recording stops (SIGINT lets SoX finalise the WAV), the footer
 *                 shows "⏳ transcribing…", the clip is transcribed, and the text
 *                 is pasted into the input box. The footer clears.
 *
 * Why a *toggle*, not literal hold-to-talk: pi's extension API only exposes
 * keypress shortcuts (`registerShortcut`), not key-release events, so there is no
 * way to detect "space released" from an extension. A tap-to-start / tap-to-stop
 * toggle gives the same effect and works in any terminal. Extension shortcuts are
 * dispatched *before* the editor consumes the key, so the toggle key fires even
 * while you are typing.
 *
 * Transcription backend (in priority order):
 *   1. $PI_PTT_TRANSCRIBE_CMD — a shell command run via `sh -c`. The WAV path is
 *      exported as $PI_PTT_AUDIO; whatever the command prints to stdout is used as
 *      the transcript. Use this to plug in a cloud API (OpenAI/Groq Whisper) or a
 *      different local tool. This overrides the whisper.cpp defaults below.
 *   2. whisper.cpp — binary $PI_PTT_WHISPER_BIN (default `whisper-cli`) with model
 *      $PI_PTT_WHISPER_MODEL (default ~/.cache/whisper/ggml-base.en.bin).
 *      Install: `brew install whisper-cpp sox` then download a model, e.g.
 *        mkdir -p ~/.cache/whisper && \
 *        curl -L -o ~/.cache/whisper/ggml-base.en.bin \
 *          https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin
 *
 * Config via environment:
 *   PI_PTT_KEY             toggle KeyId (default "ctrl+b"; e.g. "ctrl+shift+v")
 *   PI_PTT_TRANSCRIBE_CMD  custom transcription command (see above)
 *   PI_PTT_WHISPER_BIN     whisper.cpp binary (default "whisper-cli")
 *   PI_PTT_WHISPER_MODEL   whisper.cpp model path (default ~/.cache/whisper/ggml-base.en.bin)
 *   PI_PTT_REC_BIN         recorder binary (default "rec"; SoX)
 *
 * Interactive + orchestrator only: it needs the TUI to paste and a real mic, so it
 * stays inert in print/RPC mode and for subagents.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "voice-input";

/** Resolved once at load — env is stable for the process lifetime. */
const CONFIG = {
	key: process.env.PI_PTT_KEY?.trim() || "ctrl+b",
	transcribeCmd: process.env.PI_PTT_TRANSCRIBE_CMD?.trim() || "",
	whisperBin: process.env.PI_PTT_WHISPER_BIN?.trim() || "whisper-cli",
	whisperModel:
		process.env.PI_PTT_WHISPER_MODEL?.trim() ||
		path.join(os.homedir(), ".cache", "whisper", "ggml-base.en.bin"),
	recBin: process.env.PI_PTT_REC_BIN?.trim() || "rec",
};

/** The temp WAV for the current/last clip, keyed by pid to avoid collisions. */
const WAV_PATH = path.join(os.tmpdir(), `pi-voice-input-${process.pid}.wav`);

type State = "idle" | "recording" | "transcribing";
let state: State = "idle";
let recorder: ChildProcess | null = null;
let nudged = false;

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

/** Start recording. Assumes preconditions already checked. */
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
}

/** Stop recording (finalising the WAV), then transcribe and paste. */
async function stopAndTranscribe(ctx: ExtensionContext): Promise<void> {
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

/** The single entry point for both the shortcut and the `/talk` command. */
function toggle(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;

	if (state === "transcribing") return; // busy; ignore until it settles

	if (state === "recording") {
		void stopAndTranscribe(ctx);
		return;
	}

	// state === "idle": check preconditions before we start.
	const problem = checkReady();
	if (problem) {
		nudge(ctx, problem);
		return;
	}
	startRecording(ctx);
}

/** Show a setup hint (at most once per session) as an error toast. */
function nudge(ctx: ExtensionContext, msg: string): void {
	if (nudged) {
		notify(ctx, msg, "error");
		return;
	}
	nudged = true;
	notify(ctx, msg, "error");
}

export default function (pi: ExtensionAPI) {
	// Subagents share the parent's machine and have no interactive editor.
	if (process.env.PI_SUBAGENT_CHILD === "1") return;

	pi.registerShortcut(CONFIG.key, {
		description: "Push-to-talk: toggle voice dictation into the input box",
		handler: (ctx) => toggle(ctx),
	});

	pi.registerCommand("talk", {
		description: "Voice dictation: toggle recording (or `status`).",
		async handler(args, ctx) {
			const arg = args.trim().toLowerCase();
			if (arg === "status") {
				const problem = checkReady();
				const backend = CONFIG.transcribeCmd
					? "custom command ($PI_PTT_TRANSCRIBE_CMD)"
					: `whisper.cpp (${CONFIG.whisperBin}, model ${CONFIG.whisperModel})`;
				const lines = [
					`Voice input — toggle key: ${CONFIG.key}`,
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
