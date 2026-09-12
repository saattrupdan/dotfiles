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
 * *held* space (past PI_PTT_HOLD_MS, default 700ms) starts recording. This works
 * in any terminal that negotiates the Kitty keyboard protocol: iTerm2 sends key
 * releases (release-driven detection), while Neovim's :terminal reports the
 * protocol active but forwards only bare press bytes, so we fall back to OS key
 * auto-repeat to tell a hold from a tap (see ../_voice-input/ptt.ts). In a bare
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
 * Select with PI_PTT_BACKEND=whisper|syv (default: whisper), or switch for the
 * current process with `/talk backend whisper|syv`.
 *
 * whisper: streams PCM to whisper.cpp's whisper-server through
 * whisper-stream.sh, with whisper-cli as the final/fallback transcriber.
 *
 * syv: records a WAV and sends it to the OpenAI-compatible syv-transcribe API.
 * Put `SYV_API_KEY=hv_...` in ~/.pi/agent/secrets/voice-input.env (mode 0600).
 * PI_PTT_SYV_URL, PI_PTT_SYV_MODEL and PI_PTT_LANGUAGE override its endpoint,
 * model and language. PI_PTT_ENV_FILE overrides the env-file path.
 *
 * Advanced overrides remain available: PI_PTT_STREAM_CMD supplies a JSONL
 * streaming backend, and PI_PTT_TRANSCRIBE_CMD supplies a final WAV command.
 * The latter takes precedence over either named backend.
 *
 * Other config: PI_PTT_KEY, PI_PTT_HOLD_MS, PI_PTT_WHISPER_BIN,
 * PI_PTT_WHISPER_MODEL, PI_PTT_REC_BIN — see ../_voice-input/ptt.ts.
 *
 * Interactive + orchestrator only: needs the TUI editor and a real mic, so it
 * stays inert in print/RPC mode and for subagents.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isKittyProtocolActive } from "@earendil-works/pi-tui";

import {
	CONFIG,
	KEY_IS_TYPING,
	PttEditor,
	checkReady,
	cleanup,
	describeVoiceBackend,
	getState,
	releasesAvailable,
	setLiveCtx,
	setVoiceBackend,
	toggle,
} from "../_voice-input/ptt.ts";

/** Whether our PttEditor is currently the installed editor component. */
let editorInstalled = false;
let piApi: ExtensionAPI | null = null;

function installEditor(ctx: ExtensionContext): void {
	if (!piApi) return;
	setLiveCtx(piApi, ctx);
	if (!ctx.hasUI || editorInstalled) return;
	const factory: NonNullable<Parameters<ExtensionContext["ui"]["setEditorComponent"]>[0]> = (
		tui,
		theme,
		keybindings,
	) => new PttEditor(tui, theme, keybindings);
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
	piApi = pi;
	// Subagents share the parent's machine and have no interactive editor.
	if (process.env.PI_SUBAGENT_CHILD === "1") return;

	pi.on("session_start", async (_event, ctx) => {
		setLiveCtx(pi, ctx);
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
		description: "Voice dictation: toggle recording, show status, or switch backend.",
		async handler(args, ctx) {
			setLiveCtx(pi, ctx);
			const arg = args.trim().toLowerCase();
			if (arg.startsWith("backend")) {
				const backend = arg.slice("backend".length).trim();
				if (backend !== "whisper" && backend !== "syv") {
					pi.sendMessage({
						customType: "voice-input:error",
						content: "Usage: /talk backend <whisper|syv>",
						display: true,
					});
					return;
				}
				const problem = setVoiceBackend(backend);
				pi.sendMessage({
					customType: problem ? "voice-input:error" : "voice-input:status",
					content: problem ?? `Voice input backend: ${describeVoiceBackend()}`,
					display: true,
				});
				return;
			}
			if (arg === "status") {
				const problem = checkReady();
				const kitty = isKittyProtocolActive();
				const releases = releasesAvailable();
				const mode = KEY_IS_TYPING
					? kitty
						? releases
							? `hold-to-talk (tap "${CONFIG.key}" = type, hold ${CONFIG.holdMs}ms = record; release-driven)`
							: `hold-to-talk (tap "${CONFIG.key}" = type, hold ${CONFIG.holdMs}ms = record; auto-repeat fallback — no key-releases)`
						: `typing only — "${CONFIG.key}" can't be PTT in this terminal; use /talk`
					: releases
						? "hold-to-talk (terminal reports key releases)"
						: "tap-to-toggle (terminal has no key-release events)";
				pi.sendMessage({
					customType: "voice-input:status",
					content: [
						`Voice input — PTT key: ${CONFIG.key}`,
						`Mode: ${mode}`,
						`Backend: ${describeVoiceBackend()}`,
						`State: ${getState()}`,
						problem ? `⚠ Not ready:\n${problem}` : "✓ Ready.",
					].join("\n"),
					display: true,
				});
				return;
			}
			if (arg) {
				pi.sendMessage({
					customType: "voice-input:error",
					content: "Usage: /talk [status|backend <whisper|syv>]",
					display: true,
				});
				return;
			}
			toggle(ctx);
		},
	});

	pi.on("session_shutdown", async () => cleanup());
}
