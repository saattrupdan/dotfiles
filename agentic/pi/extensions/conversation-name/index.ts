/**
 * Conversation name generator.
 *
 * On the first user message in a session, generates a concise, descriptive
 * name for the conversation and applies it via Pi's built-in setSessionName().
 * Pi persists it as a session_info entry in the session file, where it shows
 * up in Pi's session selector and is read by the pi-agent.nvim plugin for the
 * window title.
 *
 * Only processes the first user message; subsequent messages are ignored.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MAX_NAME_LENGTH = 50;

export default function (pi: ExtensionAPI) {
	// Listen for message_end events - this fires for both user and assistant messages.
	// Note: the ExtensionContext is the SECOND handler argument, not event.context.
	pi.on("message_end", async (event, ctx) => {
		const msg = event.message;

		// Only process user messages
		if (!msg || msg.role !== "user") {
			return;
		}

		// Only name a session once: skip if it already has a session name. This
		// also dedups across the whole session lifetime (and survives reloads),
		// since the name persists as a session_info entry in the session file.
		try {
			if (ctx.sessionManager.getSessionName()) {
				return;
			}
		} catch {
			// getSessionName unavailable - fall through and try to set it anyway
		}

		// Extract the first prompt text. User content may be a plain string or
		// an array of content parts.
		const content = (msg as any).content;
		let firstPrompt = "";
		if (typeof content === "string") {
			firstPrompt = content;
		} else if (Array.isArray(content)) {
			for (const part of content) {
				if (part?.type === "text" && typeof part.text === "string") {
					firstPrompt = part.text;
					break;
				}
			}
		}

		if (!firstPrompt.trim()) {
			return;
		}

		// Strip the memory-audit auto-injection wrapper if present. That
		// extension rewrites the user's input to `${block}\n\n---\n${query}`,
		// where the block starts with the marker below. Without this, the
		// session gets named after the injected memory preamble instead of the
		// actual prompt. Only strip when the exact marker leads, so normal
		// prompts (which may legitimately contain "---") are left untouched.
		firstPrompt = stripInjectedMemoryBlock(firstPrompt);

		if (!firstPrompt.trim()) {
			return;
		}

		// Generate a name from the first prompt
		const name = generateConversationName(firstPrompt);

		// Rename the current session using Pi's built-in session name. Pi writes
		// it as a session_info entry in the session file, so it shows up in the
		// session selector and is picked up by the pi-agent.nvim window title.
		try {
			pi.setSessionName(name);
		} catch (error) {
			// Silently fail - this is a nice-to-have feature
			const errorMessage = error instanceof Error ? error.message : String(error);
			console.error(`[conversation-name] Failed to set session name: ${errorMessage}`);
		}
	});

	// No tools to register - this extension works via hooks only
	return {};
}

/** Leading marker of the memory-audit auto-injection block. */
const INJECTED_MEMORY_MARKER =
	/^Relevant memor(?:y|ies) found for this request \(auto-injected\)\./;

/** Separator memory-audit places between its block and the real query. */
const INJECTED_MEMORY_SEP = "\n\n---\n";

/**
 * If `text` is a memory-audit auto-injection (`${block}\n\n---\n${query}`),
 * return just the user's query. Otherwise return `text` unchanged.
 */
function stripInjectedMemoryBlock(text: string): string {
	if (!INJECTED_MEMORY_MARKER.test(text)) {
		return text;
	}
	// The block contains no separator, so the first one is the real boundary.
	const idx = text.indexOf(INJECTED_MEMORY_SEP);
	return idx === -1 ? text : text.slice(idx + INJECTED_MEMORY_SEP.length);
}

/**
 * Generate a concise, descriptive name from a user prompt.
 *
 * Strategies (in order of priority):
 * 1. Extract the main task/topic from the first sentence
 * 2. Remove filler words and stop at the first punctuation
 * 3. Truncate to MAX_NAME_LENGTH
 */
function generateConversationName(prompt: string): string {
	const trimmed = prompt.trim();

	// Take the first sentence (stop at ., ?, !, or newline)
	const firstSentence = trimmed.split(/[\.\?\!\n]/)[0]?.trim() ?? trimmed;

	// Remove common filler prefixes
	let cleaned = firstSentence.replace(
		/^(can you|could you|please|I want to|I need to|I'd like to|let's|help me to?)\s+/i,
		"",
	);

	// If it starts with a verb, capitalize it
	cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);

	// Truncate if needed
	if (cleaned.length > MAX_NAME_LENGTH) {
		// Try to cut at a word boundary
		const truncated = cleaned.slice(0, MAX_NAME_LENGTH - 3);
		const lastSpace = truncated.lastIndexOf(" ");
		if (lastSpace > MAX_NAME_LENGTH / 2) {
			cleaned = truncated.slice(0, lastSpace) + "...";
		} else {
			cleaned = truncated + "...";
		}
	}

	return cleaned || "New Conversation";
}
