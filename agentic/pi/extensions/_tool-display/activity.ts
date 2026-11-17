/** Compose native tool rows without flattening their styling, layout, or renderer state. */
import { ToolExecutionComponent, type ToolRenderers } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, type TUI } from "@earendil-works/pi-tui";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { stopNativeTimer } from "./native.ts";
import type { ActivityItem } from "../subagent/transcript.ts";

type Row = { component: ToolExecutionComponent; states: Set<{ interval?: ReturnType<typeof setInterval> }>; dispose?: () => void };
type Options = {
	expanded: boolean; cwd: string; showImages: boolean; outputPad: number;
	invalidate?: () => void; resolve(name: string, item: ActivityItem): ToolRenderers;
};

export class ActivityView extends Container {
	private rows = new Map<string, Row>();
	private cwd?: string;
	private updating = false;
	private active = false;
	private redrawQueued = false;
	private invalidateParent?: () => void;

	update(items: ActivityItem[], options: Options) {
		if (this.cwd !== options.cwd) this.dispose();
		this.cwd = options.cwd;
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
					this.addChild(new Markdown(item.text, 0, 0, getMarkdownTheme()));
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
				this.addChild(row.component);
			}
		} finally { this.updating = false; }
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
