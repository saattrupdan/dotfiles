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

import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import type { TUI, Component } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";

// Use the shared push-to-talk editor as the splash input box, so hold-to-talk
// works on the splash screen too. This soft-couples splash to the voice-input
// shared lib; if you remove _voice-input/, swap this back to CustomEditor.
import { PttEditor, setLiveCtx } from "../_voice-input/ptt.ts";

const EDITOR_WIDTH_FRACTION = 0.6;

const LOGO_KEY = "splash-logo";
const PAD_KEY = "splash-pad";

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

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (event, ctx) => {
		if (!ctx.hasUI) return;

		// Skip the splash if there are already messages in the session.
		// This happens when /reload is called mid-conversation — we don't
		// want to dismiss the existing chat and show the splash screen.
		const entries = ctx.sessionManager.getEntries();
		const hasMessages = entries.some((e) => e.type === "message");
		if (hasMessages) return;

		// Give the shared PTT editor a context so hold-to-talk works on the splash.
		setLiveCtx(ctx);

		// Wipe the terminal and scrollback so the splash is the only thing
		// visible — no chance of scrolling up to previous shell output.
		// \x1b[2J clears the screen, \x1b[H homes the cursor, \x1b[3J clears
		// the scrollback buffer (xterm/iTerm/Kitty/WezTerm/Ghostty all support this).
		process.stdout.write("\x1b[2J\x1b[H\x1b[3J");

		let dismissed = false;

		const dismiss = () => {
			if (dismissed) return;
			dismissed = true;
			ctx.ui.setWidget(LOGO_KEY, undefined);
			ctx.ui.setWidget(PAD_KEY, undefined);
			ctx.ui.setHeader(undefined);
			ctx.ui.setFooter(undefined);
			ctx.ui.setEditorComponent(undefined);
		};

		// Hide the built-in header and footer for the splash view.
		ctx.ui.setHeader(() => EMPTY_COMPONENT);
		ctx.ui.setFooter(() => EMPTY_COMPONENT);

		// Replace the editor with a narrower, centred, box-bordered wrapper for
		// the splash. The default Editor only draws horizontal rules above and
		// below; we wrap each content line with vertical bars and replace the
		// rules with corner-capped versions to make a proper box.
		ctx.ui.setEditorComponent((tui, editorTheme, keybindings) => {
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
				const editW = Math.max(2, boxInnerW - INNER_PAD_X * 2); // width the editor actually renders into
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
					const t = s.replace(new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "g"), "").trimEnd();
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
		});

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

		// Dismiss when the user actually submits a prompt — not on keystroke.
		// `input` fires on submit, before skill/template expansion. Return
		// undefined so the input passes through unchanged.
		pi.on("input", async () => {
			dismiss();
			return undefined;
		});
	});
}
