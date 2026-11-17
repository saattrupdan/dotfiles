/** Compose shared native tool rows with compact, muted subagent presentation. */
import { stripVTControlCharacters } from "node:util";
import { ToolExecutionComponent, type ToolRenderers, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, foregroundAnsi, mixColors, type Component, type TuiMouseEvent, type TUI } from "@earendil-works/pi-tui";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { stopNativeTimer } from "./native.ts";
import type { ActivityItem } from "../subagent/transcript.ts";

type Row = { component: ToolExecutionComponent; states: Set<{ interval?: ReturnType<typeof setInterval> }>; dispose?: () => void };
type Options = {
	expanded: boolean; cwd: string; showImages: boolean; outputPad: number;
	theme?: Theme; invalidate?: () => void; resolve(name: string, item: ActivityItem): ToolRenderers;
};

/** Remove only a native entry's outer shell padding; retain its internal layout and mouse coordinates. */
class ActivityEntry implements Component {
	private leading = 0;
	private height = 0;
	constructor(private inner: Component, private tint: (line: string) => string) {}

	render(width: number): string[] {
		const lines = this.inner.render(width);
		this.height = lines.length;
		this.leading = 0;
		const image = (line: string) => line.includes("\x1b_G") || line.includes("\x1b]1337;File=");
		const blank = (line: string) => !image(line) && !stripVTControlCharacters(line).trim();
		while (this.leading < lines.length && blank(lines[this.leading]!)) this.leading++;
		let end = lines.length;
		// Image rows can reserve blank terminal cells below an escape-only payload.
		const images = lines.some(image);
		if (!images) while (end > this.leading && blank(lines[end - 1]!)) end--;
		return lines.slice(this.leading, end).map(this.tint);
	}

	invalidate() { this.inner.invalidate(); }
	handleMouse(event: TuiMouseEvent) {
		return this.inner.handleMouse?.({ ...event, y: event.y + this.leading, height: this.height });
	}
}

export class ActivityView extends Container {
	private rows = new Map<string, Row>();
	private cwd?: string;
	private theme?: Theme;
	private updating = false;
	private active = false;
	private redrawQueued = false;
	private invalidateParent?: () => void;

	update(items: ActivityItem[], options: Options) {
		if (this.cwd !== options.cwd) this.dispose();
		this.cwd = options.cwd;
		this.theme = options.theme;
		this.invalidateParent = options.invalidate;
		this.updating = true;
		this.active = true;
		try {
			const keep = new Set(items.flatMap((item) => item.type === "toolCall" ? [item.id] : []));
			for (const [id, row] of this.rows) if (!keep.has(id)) {
				this.stop(row);
				this.rows.delete(id);
			}
			this.clear();
			for (const item of items) {
				if (item.type === "text") {
					this.addChild(new ActivityEntry(new Markdown(item.text, 0, 0, getMarkdownTheme()), (line) => this.mute(line)));
					continue;
				}
				let row = this.rows.get(item.id);
				if (!row) {
					const states: Row["states"] = new Set();
					const original = options.resolve(item.name, item);
					const capture = (context: Parameters<NonNullable<ToolRenderers["renderCall"]>>[2]) => {
						states.add(context.state);
						// Non-interactive presentation has no redraw owner or running clock.
						return this.invalidateParent ? context : { ...context, executionStarted: false };
					};
					const renderers: ToolRenderers = {
						...original,
						renderCall: original.renderCall && ((args, theme, context) => original.renderCall!(args, theme, capture(context))),
						renderResult: original.renderResult && ((result, display, theme, context) => original.renderResult!(result, display, theme, capture(context))),
					};
					const component = new ToolExecutionComponent(item.name, item.id, item.args,
						{ showImages: options.showImages, outputPad: options.outputPad }, renderers,
						{ requestRender: () => this.requestRender() } as TUI, options.cwd);
					row = { component, states, dispose: (original as ToolRenderers & { dispose?: () => void }).dispose };
					this.rows.set(item.id, row);
					// Replay must not set argsComplete: edit previews otherwise read today's files.
					component.markExecutionStarted();
				} else row.component.updateArgs(item.args);
				row.component.setShowImages(options.showImages);
				row.component.setOutputPad(options.outputPad);
				row.component.setExpanded(options.expanded);
				if (item.result) row.component.updateResult(item.result, item.isPartial);
				this.addChild(new ActivityEntry(row.component, (line) => {
					const muted = this.mute(line, true);
					if (item.name !== "bash" || !item.result?.isError || !this.theme) return muted;
					return muted.replaceAll(this.theme.getBgAnsi("toolErrorBg"), this.theme.getBgAnsi("toolSuccessBg"));
				}));
			}
		} finally { this.updating = false; }
	}

	private mute(line: string, tool = false): string {
		const theme = this.theme;
		if (!theme || typeof theme.getFgAnsi !== "function") return line;
		const muted = theme.getFgAnsi("muted");
		const argument = tool
			? foregroundAnsi(mixColors(theme.colors.mdLink, theme.colors.muted, 0.5), theme.getColorMode())
			: muted;
		// Native generic tool arguments use muted rather than accent.
		if (tool) line = line.replaceAll(muted, argument);
		for (const token of ["toolTitle", "accent", "toolOutput", "text"] as const) {
			const color = theme.getFgAnsi(token);
			if (color) line = line.replaceAll(color, token === "accent" || token === "text" ? argument : muted);
		}
		// Unstyled expanded arguments inherit the same subdued accent; narration stays grey.
		line = line.replaceAll("\x1b[39m", argument).replaceAll("\x1b[0m", `\x1b[0m${argument}`);
		return `${argument}${line}\x1b[39m`;
	}

	private requestRender() {
		if (this.updating || !this.active || !this.invalidateParent || this.redrawQueued) return;
		this.redrawQueued = true;
		queueMicrotask(() => {
			this.redrawQueued = false;
			if (this.active) this.invalidateParent?.();
		});
	}

	dispose() {
		this.active = false;
		for (const row of this.rows.values()) this.stop(row);
		this.rows.clear();
		this.clear();
	}

	private stop(row: Row) {
		row.dispose?.();
		for (const state of row.states) stopNativeTimer(state);
	}
}
