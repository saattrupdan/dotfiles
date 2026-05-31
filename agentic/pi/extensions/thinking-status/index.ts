/**
 * Drive the footer working-spinner to reflect what the agent is actually doing,
 * and relabel the inline hidden-thinking marker.
 *
 * Two cooperating behaviours:
 *
 * 1. Relabel the inline hidden-thinking marker to "(hidden thoughts)" so finished
 *    thinking blocks no longer print a stale "Thinking..." (which misleadingly
 *    implies reasoning is still happening). Pi always renders *a* line for a
 *    hidden thinking block — it cannot be removed from an extension — so this
 *    swaps the text for a clear static marker. The thinking content stays in the
 *    message, so toggling reasoning display still reveals the full traces.
 *
 * 2. Replace pi's generic "Working..." footer spinner with a phase-specific label:
 *      - "Thinking..."  while reasoning tokens stream
 *      - "Reading..."   while the `read` tool runs
 *      - "Writing..."   while the `write` tool runs
 *      - "Editing..."   while the `edit` tool runs
 *      - "Bashing..."   while the `bash` tool runs
 *    Any other tool / phase falls back to pi's default "Working...". The footer
 *    spinner is transient — pi clears it when streaming stops — so the label is
 *    always live and never lingers in the chat.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Tool name -> footer label. Unmapped tools fall back to pi's default.
const TOOL_LABELS: Record<string, string> = {
	read: "Reading...",
	write: "Writing...",
	edit: "Editing...",
	bash: "Bashing...",
};

export default function (pi: ExtensionAPI) {
	// --- 1. Relabel the inline hidden-thinking marker ------------------------
	// Pi resets the label to its default ("Thinking...") on reload and session
	// switches (resetExtensionUI), so re-apply our marker on the events that
	// precede any render the user would see.
	const HIDDEN_LABEL = "(hidden thoughts)";
	pi.on("session_start", (_event, ctx) => ctx.ui.setHiddenThinkingLabel(HIDDEN_LABEL));
	pi.on("agent_start", (_event, ctx) => ctx.ui.setHiddenThinkingLabel(HIDDEN_LABEL));

	// --- 2. Phase-specific footer spinner ------------------------------------
	let thinking = false;
	// toolCallId -> label, for the tools currently executing (handles overlap;
	// the most recently started running tool wins the spinner).
	const activeTools = new Map<string, string>();

	// undefined restores pi's default working message ("Working...").
	const currentLabel = (): string | undefined => {
		if (activeTools.size > 0) return [...activeTools.values()].at(-1);
		if (thinking) return "Thinking...";
		return undefined;
	};
	const apply = (ctx: { ui: { setWorkingMessage(message?: string): void } }) =>
		ctx.ui.setWorkingMessage(currentLabel());

	pi.on("message_update", (event, ctx) => {
		const type = event.assistantMessageEvent?.type;
		const isThinking = type === "thinking_start" || type === "thinking_delta";
		if (isThinking === thinking) return;
		thinking = isThinking;
		apply(ctx);
	});

	pi.on("tool_execution_start", (event, ctx) => {
		const label = TOOL_LABELS[event.toolName];
		if (!label) return; // leave the default for unmapped tools
		activeTools.set(event.toolCallId, label);
		apply(ctx);
	});
	pi.on("tool_execution_end", (event, ctx) => {
		if (!activeTools.delete(event.toolCallId)) return;
		apply(ctx);
	});

	// Reset so nothing lingers past the reasoning phase or the turn.
	pi.on("message_end", (_event, ctx) => {
		if (!thinking) return;
		thinking = false;
		apply(ctx);
	});
	pi.on("agent_end", (_event, ctx) => {
		thinking = false;
		activeTools.clear();
		apply(ctx);
	});
}
