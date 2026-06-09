/**
 * Conversation name generator.
 *
 * On the first user message in a session, asks the model (via a lightweight
 * `pi -p` sub-invocation) for a concise, descriptive title for the conversation
 * and applies it via Pi's built-in setSessionName(). Pi persists it as a
 * session_info entry in the session file, where it shows up in Pi's session
 * selector and is read by the pi-agent.nvim plugin for the window title.
 *
 * The naming call runs fire-and-forget so it never delays the agent's reply;
 * the name is filled in a few seconds later. If the model call fails, we fall
 * back to a mechanical title derived from the prompt. Only the first user
 * message in a session is named (dedup via the persisted session name).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MAX_NAME_LENGTH = 50;
const NAMING_TIMEOUT_MS = 30_000;

export default function (pi: ExtensionAPI) {
	// Sessions for which a naming call is in flight. Guards against spawning a
	// second `pi -p` if another user message arrives before the async naming
	// call resolves and sets the persisted name.
	const namingInFlight = new Set<string>();

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

		// One naming call per session at a time.
		let sessionId = "";
		try {
			sessionId = ctx.sessionManager.getSessionId();
		} catch {
			// ignore
		}
		if (sessionId && namingInFlight.has(sessionId)) {
			return;
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

		// Strip the memory-audit auto-injection wrapper if present. That
		// extension rewrites the user's input to `${block}\n\n---\n${query}`,
		// where the block starts with the marker below. Without this, the
		// session gets named after the injected memory preamble instead of the
		// actual prompt. Only strip when the exact marker leads, so normal
		// prompts (which may legitimately contain "---") are left untouched.
		firstPrompt = stripInjectedMemoryBlock(firstPrompt).trim();

		if (!firstPrompt) {
			return;
		}

		if (sessionId) {
			namingInFlight.add(sessionId);
		}

		// Generate and apply the name in the background so we never block the
		// agent's reply (this handler is awaited before the assistant runs).
		void (async () => {
			let name = "";
			try {
				name = await generateNameWithModel(pi, firstPrompt, ctx.cwd);
			} catch {
				// fall through to the mechanical fallback
			}
			if (!name) {
				name = generateConversationNameFallback(firstPrompt);
			}
			try {
				pi.setSessionName(name);
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : String(error);
				console.error(`[conversation-name] Failed to set session name: ${errorMessage}`);
			} finally {
				if (sessionId) {
					namingInFlight.delete(sessionId);
				}
			}
		})();
	});

	// No tools to register - this extension works via hooks only
	return {};
}

/**
 * Ask the model for a concise session title via a lightweight `pi -p` call.
 * Uses --no-extensions so the sub-invocation is fast and does not recurse into
 * this extension (or trigger memory injection). Returns "" on any failure.
 */
async function generateNameWithModel(
	pi: ExtensionAPI,
	prompt: string,
	cwd: string,
): Promise<string> {
	// Keep the input bounded - a title only needs the gist of the request.
	const request = prompt.slice(0, 1000);
	const instruction =
		"Generate a short, descriptive session title (3-6 words, Title Case, " +
		"no quotes, no trailing punctuation) summarizing what this request is " +
		"about. Respond with ONLY the title.\n\nRequest: " +
		request;

	const result = await pi.exec("pi", ["-p", "--no-extensions", instruction], {
		cwd,
		timeout: NAMING_TIMEOUT_MS,
	});

	if (result.code !== 0) {
		return "";
	}
	return sanitizeTitle(result.stdout);
}

/**
 * Clean up raw model output into a single-line title: take the last non-empty
 * line, strip wrapping quotes/backticks and trailing punctuation, collapse
 * whitespace, and truncate to MAX_NAME_LENGTH.
 */
function sanitizeTitle(raw: string): string {
	const lines = raw
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l.length > 0);
	let title = lines.length > 0 ? lines[lines.length - 1] : "";

	// Strip surrounding quotes or backticks the model sometimes adds.
	title = title.replace(/^["'`]+|["'`]+$/g, "").trim();
	// Collapse internal whitespace.
	title = title.replace(/\s+/g, " ");
	// Drop trailing sentence punctuation.
	title = title.replace(/[.!?,;:]+$/, "").trim();

	return truncate(title);
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
 * Mechanical fallback when the model naming call fails: take the first
 * sentence, strip common filler prefixes, capitalize, and truncate.
 */
function generateConversationNameFallback(prompt: string): string {
	const trimmed = prompt.trim();

	// Take the first sentence (stop at ., ?, !, or newline)
	const firstSentence = trimmed.split(/[\.\?\!\n]/)[0]?.trim() ?? trimmed;

	// Remove common filler prefixes
	let cleaned = firstSentence.replace(
		/^(can you|could you|please|I want to|I need to|I'd like to|let's|help me to?)\s+/i,
		"",
	);

	// Capitalize the first character
	cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);

	return truncate(cleaned) || "New Conversation";
}

/** Truncate to MAX_NAME_LENGTH, preferring a word boundary with an ellipsis. */
function truncate(text: string): string {
	if (text.length <= MAX_NAME_LENGTH) {
		return text;
	}
	const cut = text.slice(0, MAX_NAME_LENGTH - 3);
	const lastSpace = cut.lastIndexOf(" ");
	if (lastSpace > MAX_NAME_LENGTH / 2) {
		return cut.slice(0, lastSpace) + "...";
	}
	return cut + "...";
}
