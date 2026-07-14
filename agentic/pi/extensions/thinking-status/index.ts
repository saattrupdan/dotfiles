/**
 * Drive the footer working-spinner to reflect what the agent is actually doing,
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
 * 2. Replace pi's generic "Working..." footer spinner with a phase-specific label:
 *      - "Thinking..."  while reasoning tokens stream
 *      - "Reading..." / "Writing..." / "Editing..." / "Bashing..."  for the
 *        read / write / edit / bash tools
 *    Any other tool / phase falls back to pi's default "Working...".
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
 *    The footer spinner is transient — pi clears it when streaming stops — so the
 *    label is always live and never lingers in the chat.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Tool name -> footer label. Unmapped tools fall back to pi's default "Working...".
const TOOL_LABELS: Record<string, string> = {
	// built-in tools
	read: "Reading...",
	write: "Writing...",
	edit: "Editing...",
	bash: "Bashing...",
	// extension tools
	search: "Searching...",
	code_tree: "Mapping...",
	skill: "Upskilling...",
	question: "Questioning...",
	web_browse: "Browsing...",
	web_search: "Googling...",
	subagent: "Whipping the subagents...",
	memory_index: "Reminiscing...",
	memory_read: "Recalling...",
	memory_save: "Memorising...",
	memory_delete: "Forgetting...",
	memory_suggest: "Pondering...",
};

export default function (pi: ExtensionAPI) {
	// --- 1. Relabel the inline hidden-thinking marker ------------------------
	// Pi resets the label to its default ("Thinking...") on reload and session
	// switches (resetExtensionUI), so re-apply our marker on the events that
	// precede any render the user would see.
	const HIDDEN_LABEL = "(...)";

	// Track ctx for event-bus handlers (they receive no ctx)
	type CtxWithUI = { ui: { setWorkingMessage(message?: string): void; setWorkingVisible(visible: boolean): void } };
	let lastCtx: CtxWithUI | undefined;

	pi.on("session_start", (_event, ctx) => {
		lastCtx = ctx as CtxWithUI;
		ctx.ui.setHiddenThinkingLabel(HIDDEN_LABEL);
	});
	pi.on("agent_start", (_event, ctx) => {
		lastCtx = ctx as CtxWithUI;
		ctx.ui.setHiddenThinkingLabel(HIDDEN_LABEL);
	});

	// --- 2. Phase-specific footer spinner ------------------------------------
	// Label from the current streaming block (thinking / tool-call arg generation).
	let streamLabel: string | undefined;
	// toolCallId -> label for tools currently executing (handles overlap; most
	// recently started wins). Execution takes precedence over streaming.
	const activeTools = new Map<string, string>();
	// Highest-precedence override label (set via pi.events by other extensions).
	let overrideLabel: string | undefined;

	// undefined restores pi's default working message ("Working...").
	const currentLabel = (): string | undefined => {
		if (overrideLabel !== undefined) return overrideLabel;
		if (activeTools.size > 0) return [...activeTools.values()].at(-1);
		return streamLabel;
	};
	const apply = (ctx: CtxWithUI) => {
		lastCtx = ctx;
		ctx.ui.setWorkingMessage(currentLabel());
	};

	// --- 3. Event-bus override channel ---------------------------------------
	// Allows other extensions (e.g. claude-code-provider) to temporarily override
	// the footer label for long-running non-streaming operations.
	pi.events.on("thinking-status:override", (data) => {
		const label = (data as { label?: string | undefined }).label;
		if (!lastCtx) return;
		if (label !== undefined && label !== "") {
			overrideLabel = label;
			lastCtx.ui.setWorkingVisible(true);
			lastCtx.ui.setWorkingMessage(currentLabel());
		} else {
			overrideLabel = undefined;
			lastCtx.ui.setWorkingMessage(currentLabel());
		}
	});

	pi.on("message_update", (event, ctx) => {
		// `AgentMessage` is a union (user/assistant/tool/custom); only some members
		// carry `content`, so read it structurally and key off the block's `type`.
		const content = (event.message as { content?: unknown } | undefined)?.content;
		const blocks = Array.isArray(content) ? content : undefined;
		const last = blocks ? blocks[blocks.length - 1] : undefined;
		let next: string | undefined;
		if (last?.type === "thinking") next = "Thinking...";
		else if (last?.type === "toolCall") next = TOOL_LABELS[last.name];
		if (next === streamLabel) return;
		streamLabel = next;
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

	// Reset so nothing lingers past the streaming phase or the turn.
	pi.on("message_end", (_event, ctx) => {
		if (streamLabel === undefined) return;
		streamLabel = undefined;
		apply(ctx);
	});
	pi.on("agent_end", (_event, ctx) => {
		streamLabel = undefined;
		activeTools.clear();
		apply(ctx);
	});
}
