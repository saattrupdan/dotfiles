/**
 * Scroll anchor — keeps the chat viewport at the bottom when conversations end.
 *
 * Problem: The TUI sometimes scrolls to the top when a conversation ends (agent
 * finishes streaming). This appears to be caused by viewport position not being
 * preserved correctly across certain re-renders.
 *
 * Workaround: Add a small widget below the editor when the agent becomes idle.
 * This adds content that helps anchor the viewport at the bottom and prevents
 * the scroll position from jumping to the top.
 *
 * Note: This is a workaround for a TUI viewport calculation issue. The real
 * fix would be in the pi-tui package's viewport tracking logic.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	// Add a small spacer widget below the editor when agent becomes idle.
	// This helps anchor the viewport at the bottom and prevents scroll jumps.
	const ANCHOR_WIDGET = [" "]; // Single space acts as a minimal anchor

	pi.on("agent_end", (_event, ctx) => {
		if (!ctx.hasUI) return;
		// Add anchor widget below editor to maintain scroll position
		ctx.ui.setWidget("scroll-anchor", ANCHOR_WIDGET, { placement: "belowEditor" });
	});

	pi.on("agent_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		// Remove anchor when agent starts (will be re-added when done)
		ctx.ui.setWidget("scroll-anchor", undefined);
	});

	// Also handle session start to ensure clean state
	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		ctx.ui.setWidget("scroll-anchor", undefined);
	});
}
