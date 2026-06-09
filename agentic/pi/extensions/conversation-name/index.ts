/**
 * Conversation name generator.
 *
 * On the first user message in a session, generates a concise, descriptive
 * name for the conversation and writes it to the session directory. The
 * nvim plugin can then read this file and display it in the buffer title.
 *
 * Only processes the first user message; subsequent messages are ignored.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";

const SESSION_NAME_FILE = "conversation-name.json";
const MAX_NAME_LENGTH = 50;

export default function (pi: ExtensionAPI) {
	// Track which sessions we've already processed
	const processedSessions = new Set<string>();

	// Listen for message_end events - this fires for both user and assistant messages
	pi.on("message_end", async (event) => {
		const msg = event.message;

		// Only process user messages
		if (!msg || msg.role !== "user") {
			return;
		}

		// Get the session ID from context
		const sessionId = event.context?.sessionId;
		if (!sessionId) {
			return;
		}

		// Skip if we've already processed this session
		if (processedSessions.has(sessionId)) {
			return;
		}

		// Extract the first prompt text
		const content = (msg as any).content;
		if (!Array.isArray(content) || content.length === 0) {
			return;
		}

		// Find the first text part
		let firstPrompt = "";
		for (const part of content) {
			if (part?.type === "text" && typeof part.text === "string") {
				firstPrompt = part.text;
				break;
			}
		}

		if (!firstPrompt.trim()) {
			return;
		}

		// Mark this session as processed
		processedSessions.add(sessionId);

		// Generate a name from the first prompt
		const name = generateConversationName(firstPrompt);

		// Rename the current session using Pi's built-in session name, so it
		// shows up in the session selector.
		try {
			pi.setSessionName(name);
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			console.error(`[conversation-name] Failed to set session name: ${errorMessage}`);
		}

		// Get the session directory from context
		const sessionDir = event.context?.cwd;
		if (!sessionDir) {
			return;
		}

		// Write the name to the session directory
		const filePath = path.join(sessionDir, SESSION_NAME_FILE);
		const payload = {
			name: name,
			createdAt: new Date().toISOString(),
			firstPrompt: firstPrompt.slice(0, 200),
		};

		try {
			fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf8");
		} catch (error) {
			// Silently fail - this is a nice-to-have feature
			const errorMessage = error instanceof Error ? error.message : String(error);
			console.error(`[conversation-name] Failed to write: ${errorMessage}`);
		}
	});

	// No tools to register - this extension works via hooks only
	return {};
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
