/**
 * Push-to-talk voice input — dictate into the input box by holding a key.
 *
 * Hold the PTT key (default: space) to record from the microphone; release to
 * stop, transcribe, and paste the text into the editor at the cursor. `/talk`
 * triggers the same flow for terminals/keys where the hotkey can't be used.
 *
 * The recording state machine and the editor that captures the hold live in the
 * shared lib ../_voice-input/ptt.ts, so the `splash` extension can reuse the same
 * PttEditor and hold-to-talk works on the splash screen too.
 *
 * ── SPACE as the PTT key (tap vs hold) ───────────────────────────────────────
 * Space is also a typing key, so a *quick tap* inserts a normal space and only a
 * *held* space (past PI_PTT_HOLD_MS, default 500ms) starts recording. This needs
 * key-release events (Kitty keyboard protocol; confirmed in iTerm2 3.6.11). In a
 * legacy terminal space just types — use /talk or set PI_PTT_KEY to a non-typing
 * key (e.g. f8), which then hold-to-talks (or tap-toggles in legacy terminals).
 *
 * ── Coexisting with the splash extension ─────────────────────────────────────
 * Both customise the editor via setEditorComponent, and there is only one editor
 * slot. splash owns the editor during the fresh-session splash screen (now using
 * a PttEditor, so PTT works there) and clears it on first submit. So we install
 * our editor only from the first agent_start (splash is gone by then), or
 * immediately when the session already has messages (splash is skipped).
 *
 * ── Transcription backend ────────────────────────────────────────────────────
 *   1. $PI_PTT_TRANSCRIBE_CMD — a `sh -c` command; WAV path in $PI_PTT_AUDIO,
 *      stdout is the transcript (plug in a cloud API).
 *   2. whisper.cpp — $PI_PTT_WHISPER_BIN (default `whisper-cli`) + model
 *      $PI_PTT_WHISPER_MODEL (default ~/.cache/whisper/ggml-base.en.bin).
 *      ggml-base.en.bin is English-only; use ggml-small.bin+ for Danish.
 *
 * ── Config via environment ───────────────────────────────────────────────────
 *   PI_PTT_KEY, PI_PTT_HOLD_MS, PI_PTT_TRANSCRIBE_CMD, PI_PTT_WHISPER_BIN,
 *   PI_PTT_WHISPER_MODEL, PI_PTT_REC_BIN — see ../_voice-input/ptt.ts.
 *
 * Interactive + orchestrator only: needs the TUI editor and a real mic, so it
 * stays inert in print/RPC mode and for subagents.
 */

import type { EditorFactory, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isKittyProtocolActive } from "@earendil-works/pi-tui";

import {
	CONFIG,
	KEY_IS_TYPING,
	PttEditor,
	checkReady,
	cleanup,
	getState,
	setLiveCtx,
	toggle,
} from "../_voice-input/ptt.ts";

/** Whether our PttEditor is currently the installed editor component. */
let editorInstalled = false;

function installEditor(ctx: ExtensionContext): void {
	setLiveCtx(ctx);
	if (!ctx.hasUI || editorInstalled) return;
	const factory: EditorFactory = (tui, theme, keybindings) => new PttEditor(tui, theme, keybindings);
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
		setLiveCtx(ctx);
		// A reset cleared any editor we installed; if splash is skipped (session
		// already has messages) we can own the editor now. On a fresh session we
		// wait for agent_start so splash keeps its splash-screen editor.
		editorInstalled = false;
		if (sessionHasMessages(ctx)) installEditor(ctx);
	});
	pi.on("agent_start", async (_event, ctx) => {
		// By the first agent_start the splash has dismissed its editor.
		installEditor(ctx);
	});

	pi.registerCommand("talk", {
		description: "Voice dictation: toggle recording (or `status`).",
		async handler(args, ctx) {
			setLiveCtx(ctx);
			const arg = args.trim().toLowerCase();
			if (arg === "status") {
				const problem = checkReady();
				const backend = CONFIG.transcribeCmd
					? "custom command ($PI_PTT_TRANSCRIBE_CMD)"
					: `whisper.cpp (${CONFIG.whisperBin}, model ${CONFIG.whisperModel})`;
				const releases = isKittyProtocolActive();
				const mode = KEY_IS_TYPING
					? releases
						? `hold-to-talk (tap "${CONFIG.key}" = type, hold ${CONFIG.holdMs}ms = record)`
						: `typing only — "${CONFIG.key}" can't be PTT without key-releases; use /talk`
					: releases
						? "hold-to-talk (terminal reports key releases)"
						: "tap-to-toggle (terminal has no key-release events)";
				pi.sendMessage({
					customType: "voice-input:status",
					content: [
						`Voice input — PTT key: ${CONFIG.key}`,
						`Mode: ${mode}`,
						`Backend: ${backend}`,
						`State: ${getState()}`,
						problem ? `⚠ Not ready:\n${problem}` : "✓ Ready.",
					].join("\n"),
					display: true,
				});
				return;
			}
			toggle(ctx);
		},
	});

	pi.on("session_shutdown", async () => cleanup());
}
