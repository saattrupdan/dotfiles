/**
 * Drive the working status indicator to reflect what the agent is doing,
 * and relabel the inline hidden-thinking marker.
 *
 * Two cooperating behaviours:
 *
 * 1. Relabel the inline hidden-thinking marker to "(...)" so finished
 *    thinking blocks no longer print a stale "Thinking..." (which misleadingly
 *    implies reasoning is still happening). Pi always renders *a* line for a
 *    hidden thinking block — it cannot be removed from an extension — so this
 *    swaps the text for a clear static marker. The thinking content stays in the
 *    message, so toggling reasoning display still reveals the full traces.
 *
 * 2. Replace pi's generic "Working..." status indicator with a phase-specific label:
 *      - "Thinking..."  while reasoning tokens stream
 *      - "Reading..." / "Writing..." / "Editing..." / "Bashing..."  for the
 *        read / write / edit / bash tools
 *    Any other tool / phase uses the same neutral styling for "Working...".
 *
 *    A tool's elapsed time splits across two phases, and the label must cover
 *    both or it barely shows:
 *      - argument streaming — the model generates the tool call (e.g. the whole
 *        file body for `write`/`edit`); seen via `message_update`, where the last
 *        content block is a `toolCall` carrying the tool `name`. This dominates
 *        for write/edit.
 *      - execution — the tool actually runs; seen via `tool_execution_start/end`.
 *        This dominates for bash/read.
 *    We track both and let execution take precedence over streaming.
 *
 *    The working indicator is transient — pi clears it when streaming stops — so the
 *    label is always live and never lingers in the chat.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// Share phase labels with Remote; terminal coloring stays in this adapter.
import { WorkingStatus } from "../_working-status/status.ts";

export default function (pi: ExtensionAPI) {
	const status = new WorkingStatus();
	type Context = {
		ui: {
			theme: ExtensionContext["ui"]["theme"];
			setWorkingMessage(message?: string): void;
			setWorkingVisible(visible: boolean): void;
			setHiddenThinkingLabel(label: string): void;
		};
	};
	let lastCtx: Context | undefined;
	const apply = (ctx: Context) => {
		const label = status.label ?? "Working...";
		// Embedded indicators inherit the editor's thinking-level color. Keep
		// activity text neutral; the border and spinner still show that level.
		ctx.ui.setWorkingMessage(ctx.ui.theme.fg("muted", label));
	};
	const update = (kind: string, data: unknown, ctx: Context) => {
		lastCtx = ctx;
		status.update(kind, data);
		apply(ctx);
	};
	pi.on("session_start", (_event, ctx) => {
		lastCtx = ctx;
		status.update("session_start", null);
		ctx.ui.setHiddenThinkingLabel("(...)");
		apply(ctx);
	});
	pi.on("agent_start", (_event, ctx) => {
		lastCtx = ctx;
		ctx.ui.setHiddenThinkingLabel("(...)");
		update("agent_start", null, ctx);
		// Startup continuations can start before the TUI subscribes to turn_start.
		// Restore the same editor-border indicator that carries our phase label.
		ctx.ui.setWorkingVisible(true);
	});
	pi.on("agent_settled", (_event, ctx) => {
		update("agent_settled", null, ctx);
		// A fast startup run can also finish before the TUI sees agent_end.
		ctx.ui.setWorkingVisible(false);
		ctx.ui.setWorkingVisible(true);
	});
	pi.events.on("thinking-status:override", (data) => {
		if (!lastCtx) return;
		status.update("working_override", data);
		if (status.message(false) !== undefined) lastCtx.ui.setWorkingVisible(true);
		apply(lastCtx);
	});
	pi.on("message_update", (event, ctx) => update("message_update", event.message, ctx));
	pi.on("tool_execution_start", (event, ctx) => update("tool_execution_start", event, ctx));
	pi.on("tool_execution_end", (event, ctx) => update("tool_execution_end", event, ctx));
	pi.on("message_end", (_event, ctx) => update("message_end", null, ctx));
	pi.on("agent_end", (_event, ctx) => update("agent_end", null, ctx));
}
