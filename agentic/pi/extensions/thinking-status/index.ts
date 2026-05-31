/**
 * Move the reasoning indicator out of the chat body and into the footer.
 *
 * Two cooperating behaviours:
 *
 * 1. Blank the inline hidden-thinking label so finished thinking blocks no
 *    longer print a stale "Thinking..." in the conversation. (Pi always renders
 *    *a* line for a hidden thinking block — it cannot be removed from an
 *    extension — so this collapses the text to an empty line rather than
 *    deleting it. The thinking content stays in the message, so toggling
 *    reasoning display still reveals the full traces.)
 *
 * 2. Show "Thinking..." in the footer working-spinner *while* reasoning tokens
 *    stream, reverting to pi's default "Working..." the moment reasoning ends.
 *    The footer spinner is transient — pi clears it when streaming stops — so
 *    the live indicator appears during reasoning and disappears on its own.
 *
 * Net effect: a live "Thinking..." in the footer during reasoning, and no
 * persistent "Thinking..." text left behind in the chat afterwards.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	// --- 1. Blank the inline hidden-thinking label ---------------------------
	// Pi resets the label to its default ("Thinking...") on reload and session
	// switches (resetExtensionUI), so re-apply the blank label on the events
	// that precede any render the user would see. "" stays "" (only undefined
	// would fall back to the default).
	pi.on("session_start", (_event, ctx) => ctx.ui.setHiddenThinkingLabel(""));
	pi.on("agent_start", (_event, ctx) => ctx.ui.setHiddenThinkingLabel(""));

	// --- 2. "Thinking..." in the footer while reasoning streams --------------
	// Track the last value we set so we only touch the spinner on transitions.
	let showingThinking = false;

	pi.on("message_update", (event, ctx) => {
		const type = event.assistantMessageEvent?.type;
		const isThinking = type === "thinking_start" || type === "thinking_delta";
		if (isThinking === showingThinking) return;
		showingThinking = isThinking;
		// undefined restores pi's default working message ("Working...").
		ctx.ui.setWorkingMessage(isThinking ? "Thinking..." : undefined);
	});

	// Safety net: never let a stale "Thinking..." linger past the reasoning phase.
	pi.on("message_end", (_event, ctx) => {
		if (!showingThinking) return;
		showingThinking = false;
		ctx.ui.setWorkingMessage(undefined);
	});
	pi.on("agent_end", (_event, ctx) => {
		if (!showingThinking) return;
		showingThinking = false;
		ctx.ui.setWorkingMessage(undefined);
	});
}
