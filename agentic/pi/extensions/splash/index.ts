/**
 * Splash screen.
 *
 * On fresh session start: hides the built-in header and footer, draws a big Pi logo
 * above the input, and pads below so the editor lands roughly mid-screen —
 * Google-homepage style. The splash stays until the user submits their first
 * prompt; then the header/footer are restored and the editor drops to its
 * normal bottom position.
 *
 * If /reload is called mid-conversation (session already has messages), the splash
 * is skipped to preserve the existing chat.
 *
 * Logo geometry is the 4x4 staircase mark decoded from the SVG.
 *
 *     ■ ■ ■ ·
 *     ■ · ■ ·
 *     ■ ■ · ■
 *     ■ · · ■
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { TUI, Component } from "@earendil-works/pi-tui";
import { visibleWidth, truncateToWidth } from "@earendil-works/pi-tui";

// Use the shared push-to-talk editor as the splash input box, so hold-to-talk
// works on the splash screen too. This soft-couples splash to the voice-input
// shared lib; if you remove _voice-input/, swap this back to CustomEditor.
import { PttEditor, setLiveCtx, getStatusText } from "../_voice-input/ptt.ts";

const EDITOR_WIDTH_FRACTION = 0.6;

const LOGO_KEY = "splash-logo";
const PAD_KEY = "splash-pad";
// A minimal pseudo-footer rendered just below the input box. It deliberately
// shows only the model name, not other extension status segments.
const FOOTER_KEY = "splash-footer";

const GRID: ReadonlyArray<ReadonlyArray<0 | 1>> = [
	[1, 1, 1, 0],
	[1, 0, 1, 0],
	[1, 1, 0, 1],
	[1, 0, 0, 1],
];

const CELL_W = 6;
const CELL_H = 3;
const BLOCK = "█";
const LOGO_W = GRID[0]!.length * CELL_W;


function renderLogo(theme: Theme, width: number): string[] {
	const lines: string[] = [];
	const leftPad = Math.max(0, Math.floor((width - LOGO_W) / 2));
	const pad = " ".repeat(leftPad);

	for (const row of GRID) {
		const rowChunks: string[] = [];
		for (const cell of row) {
			rowChunks.push(cell ? theme.fg("accent", BLOCK.repeat(CELL_W)) : " ".repeat(CELL_W));
		}
		const line = pad + rowChunks.join("");
		for (let i = 0; i < CELL_H; i++) lines.push(line);
	}

	lines.push("");
	return lines;
}

const EMPTY_COMPONENT: Component = {
	render(): string[] {
		return [];
	},
	invalidate() {},
};

// Helper functions for statusline footer (mirrored from statusline extension).
const BAR_WIDTH = 10;
const COLOR_GREEN = "\x1b[38;5;71m";
const COLOR_YELLOW = "\x1b[33m";
const COLOR_RED = "\x1b[31m";
const COLOR_RESET = "\x1b[0m";

function formatTokens(value: number | null | undefined): string {
	if (value === undefined || value === null || !Number.isFinite(value)) return "?";
	if (value >= 1_000_000) return `${Math.round(value / 1_000_000)}M`;
	if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
	return String(Math.round(value));
}

function progressBar(
	percent: number | undefined,
	theme: { fg(key: string, text: string): string },
): string {
	if (percent === undefined || !Number.isFinite(percent)) {
		return `[${"·".repeat(BAR_WIDTH)}]`;
	}
	const clamped = Math.max(0, Math.min(100, percent));
	const filled = Math.round((clamped / 100) * BAR_WIDTH);
	let colorCode: string;
	if (clamped >= 80) {
		colorCode = COLOR_RED;
	} else if (clamped >= 50) {
		colorCode = COLOR_YELLOW;
	} else {
		colorCode = COLOR_GREEN;
	}
	const barChar = `${colorCode}█${COLOR_RESET}`;
	const emptyChar = theme.fg("dim", "░");
	return `[${barChar.repeat(filled)}${emptyChar.repeat(BAR_WIDTH - filled)}]`;
}

function formatExtensionStatuses(footerData: { getExtensionStatuses(): ReadonlyMap<string, string> }): string[] {
	return Array.from(footerData.getExtensionStatuses().entries())
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([ext, text]) => {
			const sanitized = text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
			if (ext === "mcp" && sanitized.includes("0/")) return "";
			return sanitized;
		})
		.filter((text) => text.length > 0);
}

type SplashEditorFactory = NonNullable<Parameters<ExtensionContext["ui"]["setEditorComponent"]>[0]>;

let splashActive = false;
let splashDismissed = true;
let splashSessionKey: string | undefined;
let splashReapplyTimer: ReturnType<typeof setTimeout> | undefined;

function sessionKey(ctx: ExtensionContext): string {
	return ctx.sessionManager.getSessionFile() ?? ctx.sessionManager.getSessionId();
}

function sessionHasMessages(ctx: ExtensionContext): boolean {
	try {
		return ctx.sessionManager.getEntries().some((e) => e.type === "message");
	} catch {
		return false;
	}
}

function createSplashEditorFactory(): SplashEditorFactory {
	return (tui, editorTheme, keybindings) => {
		const inner = new PttEditor(tui, editorTheme, keybindings);
		const innerRender = inner.render.bind(inner);
		// Horizontal padding inside the box, matching the visual breathing
		// room provided by the top/bottom rules. Done in the wrapper rather
		// than via inner.setPaddingX() because interactive-mode overwrites
		// any custom editor's paddingX with the default's right after
		// setEditorComponent returns.
		const INNER_PAD_X = 1;
		inner.render = (width: number): string[] => {
			const targetW = Math.max(20, Math.floor(width * EDITOR_WIDTH_FRACTION));
			const boxInnerW = Math.max(2, targetW - 2); // width between the vertical bars
			const editW = Math.max(2, boxInnerW - INNER_PAD_X * 2); // editor render width
			const innerLines = innerRender(editW);
			const leftPad = " ".repeat(Math.max(0, Math.floor((width - targetW) / 2)));
			if (innerLines.length === 0) return [];

			const bc = inner.borderColor ?? ((s: string) => s);
			const horiz = "─".repeat(boxInnerW);
			const top = bc("╭" + horiz + "╮");
			const bottom = bc("╰" + horiz + "╯");
			const sideL = bc("│");
			const sideR = bc("│");
			const innerPad = " ".repeat(INNER_PAD_X);

			// Editor.render emits `[top_rule, content..., bottom_rule, autocomplete_rows...]`
			// — autocomplete rows come *after* the bottom rule when the slash
			// menu (or any other dropdown) is open. Find the bottom rule by
			// matching its shape (a row of `─`, optionally with a scroll
			// indicator) so we wrap only the content lines in `│ … │` and
			// pass the dropdown rows through untouched.
			const isRule = (s: string): boolean => {
				const esc = String.fromCharCode(27);
				const t = s.replace(new RegExp(`${esc}\\[[0-9;]*m`, "g"), "").trimEnd();
				return /^─+$/.test(t) || /^─+ [↑↓] \d+ more ─*$/.test(t);
			};
			let bottomIdx = innerLines.length - 1;
			for (let i = 1; i < innerLines.length; i++) {
				if (isRule(innerLines[i]!)) {
					bottomIdx = i;
					break;
				}
			}

			const out: string[] = [leftPad + top];
			for (let i = 1; i < bottomIdx; i++) {
				const line = innerLines[i]!;
				const vw = visibleWidth(line);
				const rightFill = " ".repeat(Math.max(0, editW - vw));
				out.push(leftPad + sideL + innerPad + line + rightFill + innerPad + sideR);
			}
			out.push(leftPad + bottom);
			// Dropdown / autocomplete rows: align with the box's inner edge.
			for (let i = bottomIdx + 1; i < innerLines.length; i++) {
				out.push(leftPad + innerPad + innerLines[i]!);
			}
			return out;
		};
		return inner;
	};
}

function installStatusFooter(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	ctx.ui.setFooter((_tui, theme, footerData) => ({
		dispose() {},
		invalidate() {},
		render(width: number): string[] {
			const model = ctx.model;
			const modelName = model?.name || model?.id || "no model";
			const contextWindow = model?.contextWindow ?? ctx.getContextUsage()?.contextWindow;
			const context = ctx.getContextUsage();
			const contextPercent = context?.percent ?? undefined;
			const contextText = `${formatTokens(context?.tokens)} / ${formatTokens(contextWindow)}`;
			const contextPercentText = contextPercent !== undefined
				? ` ${theme.fg("dim", `(${Math.round(contextPercent)}%)`)}`
				: "";
			const parts = [
				theme.fg("accent", modelName),
				`${theme.fg("muted", "ctx")} ${progressBar(contextPercent, theme)} ${theme.fg("dim", contextText)}${contextPercentText}`,
			];
			parts.push(...formatExtensionStatuses(footerData));
			const line = parts.filter(Boolean).join(theme.fg("dim", "  │  "));
			return [" " + truncateToWidth(line, width - 1)];
		},
	}));
}

function dismissSplash(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	if (splashReapplyTimer !== undefined) {
		clearTimeout(splashReapplyTimer);
		splashReapplyTimer = undefined;
	}
	if (splashDismissed) return;

	splashDismissed = true;
	splashActive = false;
	splashSessionKey = undefined;
	ctx.ui.setWidget(LOGO_KEY, undefined);
	ctx.ui.setWidget(PAD_KEY, undefined);
	ctx.ui.setWidget(FOOTER_KEY, undefined);
	ctx.ui.setHeader(undefined);
	ctx.ui.setFooter(undefined);
	ctx.ui.setEditorComponent(undefined);
}

function installSplash(pi: ExtensionAPI, ctx: ExtensionContext, clearScreen: boolean): void {
	if (!ctx.hasUI) return;
	if (sessionHasMessages(ctx)) {
		dismissSplash(ctx);
		return;
	}

	const key = sessionKey(ctx);
	const firstInstallForSession = !splashActive || splashSessionKey !== key;
	splashActive = true;
	splashDismissed = false;
	splashSessionKey = key;

	// Give the shared PTT editor a context so hold-to-talk works on the splash.
	setLiveCtx(pi, ctx);

	if (clearScreen && firstInstallForSession) {
		// Wipe the terminal and scrollback so the splash is the only thing
		// visible — no chance of scrolling up to previous shell output.
		// \x1b[2J clears the screen, \x1b[H homes the cursor, \x1b[3J clears
		// the scrollback buffer (xterm/iTerm/Kitty/WezTerm/Ghostty support this).
		process.stdout.write("\x1b[2J\x1b[H\x1b[3J");
	}

	// Hide the built-in header and footer for the splash view.
	ctx.ui.setHeader(() => EMPTY_COMPONENT);
	ctx.ui.setFooter(() => EMPTY_COMPONENT);

	// Replace the editor with a narrower, centred, box-bordered wrapper for
	// the splash. Installing is deliberately repeatable: /new swaps the whole
	// session UI, so we reapply this factory on fresh session_start.
	ctx.ui.setEditorComponent(createSplashEditorFactory());

	ctx.ui.setWidget(
		LOGO_KEY,
		(tui: TUI, theme: Theme): Component => ({
			render(width: number): string[] {
				// Vertically centre the (logo + editor) stack. Layout is
				// top-anchored, so prepend blank lines above the logo to
				// push the (logo + editor) pair down to the screen midline.
				// Logo widget contributes LOGO_H + trailing spacer rows;
				// the editor below is ~3 rows.
				const rows = Number(tui.terminal?.rows);
				const logoLines = renderLogo(theme, Math.max(width, LOGO_W));
				if (!Number.isFinite(rows) || rows <= 0) return logoLines;
				const editorH = 3;
				const stackH = logoLines.length + editorH;
				// 0.35 of the free space goes above (0.5 = dead-centre); using a
				// smaller fraction lifts the stack toward the upper third, which
				// reads better against an empty screen below.
				const padLines = Math.max(0, Math.floor((rows - stackH) * 0.45));
				const out: string[] = [];
				for (let i = 0; i < padLines; i++) out.push("");
				out.push(...logoLines);
				return out;
			},
			invalidate() {},
		}),
		{ placement: "aboveEditor" },
	);

	// Pseudo-footer just under the input box. Shows model name + voice status.
	// Reads getStatusText() from voice-input so streaming/recording shows here too.
	ctx.ui.setWidget(
		FOOTER_KEY,
		(_tui: TUI, theme: Theme): Component => ({
			render(width: number): string[] {
				const modelText = ctx.model?.name || ctx.model?.id;
				const voiceStatus = getStatusText();
				const line = voiceStatus ? `${modelText || ""} — ${voiceStatus}` : (modelText || "");
				if (!line) return [];
				const targetW = Math.max(20, Math.floor(width * EDITOR_WIDTH_FRACTION));
				const leftPad = " ".repeat(Math.max(0, Math.floor((width - targetW) / 2)));
				return ["", leftPad + theme.fg("dim", line)];
			},
			invalidate() {},
		}),
		{ placement: "belowEditor" },
	);
}

function scheduleSplashReapply(pi: ExtensionAPI, ctx: ExtensionContext, clearScreen: boolean = false): void {
	if (!ctx.hasUI) return;
	if (splashReapplyTimer !== undefined) {
		clearTimeout(splashReapplyTimer);
		splashReapplyTimer = undefined;
	}
	const key = sessionKey(ctx);
	splashReapplyTimer = setTimeout(() => {
		splashReapplyTimer = undefined;
		// Guard against race conditions when /reload and /new are called
		// in quick succession: ensure we're still on the expected session
		// and the splash hasn't been dismissed.
		if (!ctx.hasUI || splashDismissed || !splashActive || splashSessionKey !== key) return;
		installSplash(pi, ctx, clearScreen);
	}, 50);
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;

		// Skip the splash if there are already messages in the session.
		// This happens when /reload is called mid-conversation — we don't
		// want to dismiss the existing chat and show the splash screen.
		if (sessionHasMessages(ctx)) {
			dismissSplash(ctx);
			return;
		}

		// Mark splash as active for this session before scheduling. This ensures
		// the guard in scheduleSplashReapply passes, and that rapid /reload + /new
		// calls properly track the current session.
		splashActive = true;
		splashDismissed = false;
		splashSessionKey = sessionKey(ctx);

		// Defer splash installation to avoid race conditions when /reload and /new
		// are called in quick succession. Pi's UI rebinding needs time to settle
		// before we calculate editor width and terminal dimensions.
		scheduleSplashReapply(pi, ctx, true);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		dismissSplash(ctx);
	});

	// Dismiss when the user actually submits a prompt — not on keystroke.
	// `input` fires on submit, before skill/template expansion. Return undefined
	// so the input passes through unchanged.
	pi.on("input", async (_event, ctx) => {
		const wasActive = splashActive && !splashDismissed;
		dismissSplash(ctx);
		if (wasActive) {
			// Set up the statusline footer immediately so it's visible before
			// the assistant starts processing. The statusline extension also
			// installs on agent_start/turn_end/message_end, but we set it here
			// to ensure it appears as soon as the splash is dismissed.
			installStatusFooter(ctx);
		}
		return undefined;
	});
}
