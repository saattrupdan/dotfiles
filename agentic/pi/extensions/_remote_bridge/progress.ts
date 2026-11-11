/** Coalesce native subagent previews; raw child transcripts never cross IPC. */
import type { AgentToolResult, Theme } from "@earendil-works/pi-coding-agent";
import { createSubagentRenderers } from "../subagent/display.ts";
import { displayBlock } from "../_tool-display/block.ts";
import { boundedToolArguments } from "../_tool-display/arguments.ts";
import type { DisplayContext, DisplayArgs } from "../_tool-display/types.ts";
import type { ToolProgress } from "../_tool-display/block-types.ts";

type Pending = { args: unknown; result: AgentToolResult<unknown>; theme: Theme };

export class SubagentProgress {
	private pending = new Map<string, Pending>();
	private latest = new Map<string, ToolProgress>();
	private timer?: ReturnType<typeof setTimeout>;
	constructor(private publish: (progress: ToolProgress) => void) {}
	update(id: string, args: unknown, result: AgentToolResult<unknown>, theme: Theme) {
		if (!this.pending.has(id) && this.pending.size >= 16) return;
		this.pending.set(id, { args, result, theme });
		if (!this.timer) {
			this.timer = setTimeout(() => this.flush(), 250);
			this.timer.unref?.();
		}
	}
	end(id: string) {
		this.pending.delete(id);
		this.latest.delete(id);
	}
	clear() {
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		this.pending.clear();
		this.latest.clear();
	}
	replay() {
		this.flush(false);
		for (const block of this.latest.values()) this.publish(block);
	}
	private flush(publish = true) {
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		for (const [id, value] of this.pending) {
			try {
				const args = boundedToolArguments(value.args).args as DisplayArgs;
				const label = (value.result.details as { sessionLabel?: string } | undefined)?.sessionLabel;
				const renderers = createSubagentRenderers(
					typeof label === "string" ? new Map([[id, label.slice(0, 1024)]]) : undefined,
				);
				const context = { toolCallId: id, expanded: false, isPartial: true } as DisplayContext;
				const call = renderers.renderCall!(args, value.theme, context);
				const result = renderers.renderResult!(
					value.result,
					{ expanded: false, isPartial: true },
					value.theme,
					context,
				);
				const block = displayBlock([...call.render(2048), ...result.render(2048)], "subagent", {});
				if (this.latest.get(id)?.toolDisplay === block.text) continue;
				const progress = {
					toolCallId: id,
					toolDisplay: block.text,
					toolDisplayStyles: block.styles,
				};
				this.latest.delete(id);
				this.latest.set(id, progress);
				while (this.latest.size > 16) this.latest.delete(this.latest.keys().next().value!);
				if (publish) this.publish(progress);
			} catch {
				// A malformed preview cannot interrupt the running parent or child.
			}
		}
		this.pending.clear();
	}
}
