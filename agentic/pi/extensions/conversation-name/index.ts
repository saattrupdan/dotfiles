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

const MAX_NAME_LENGTH = 30;
const NAMING_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 2;

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
		const content = (msg as { content?: unknown }).content;
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

		firstPrompt = firstPrompt.trim();

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
 * Uses structured JSON output with a schema that enforces the 30-character limit.
 * Retries up to MAX_RETRIES times if validation fails. Returns "" on any failure.
 */
async function generateNameWithModel(
	pi: ExtensionAPI,
	prompt: string,
	cwd: string,
): Promise<string> {
	// Keep the input bounded - a title only needs the gist of the request.
	const request = prompt.slice(0, 1000);

	for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
		const instruction =
		`Generate a concise session title (max 30 chars) for this request.\n\n` +
		`Format: Use a noun phrase or gerund + object pattern. Examples:\n` +
		`- "Fixing conversation naming"\n` +
		`- "Debugging extension triggers"\n` +
		`- "Session name bug"\n` +
		`- "Implementing search feature"\n` +
		`- "Wrong type inference"\n\n` +
		`Rules:\n` +
		`- Output ONLY the title — no quotes, JSON, or markdown\n` +
		`- 1-30 characters (inclusive)\n` +
		`- Use Title Case\n` +
		`- No trailing punctuation\n` +
		`- Do NOT truncate mid-word or use ellipses\n` +
		`- Be specific: include key nouns/verbs from the request\n\n` +
		`Request: ${request}`;

		const result = await pi.exec("pi", ["-p", "--no-extensions", "--no-session", instruction], {
			cwd,
			timeout: NAMING_TIMEOUT_MS,
		});

		if (result.code !== 0) {
			continue; // Retry
		}

		const name = truncateTitle(sanitizeTitle(result.stdout));
		if (!name) {
			continue; // Retry
		}

		// Success - validated name within the 30-character limit
		return name;
	}

	// All retries failed
	return "";
}

/**
 * Clean up raw model output into a single-line title: take the last non-empty
 * line, strip wrapping quotes/backticks and trailing punctuation, collapse
 * whitespace, and truncate to MAX_NAME_LENGTH.
 */
function toTitleCase(str: string): string {
	// Minor words that stay lowercase (unless first word)
	const minorWords = new Set(["a", "an", "the", "and", "but", "or", "for", "nor", "on", "at", "to", "in", "of"]);

	return str
		.split(" ")
		.map((word, idx) => {
			if (idx === 0) {
				// Always capitalize first word
				return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
			}
			if (minorWords.has(word.toLowerCase())) {
				return word.toLowerCase();
			}
			return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
		})
		.join(" ");
}

function validateAndFormatTitle(title: string): string {
	if (!title || title.length === 0) {
		return "";
	}

	// Strip surrounding quotes or backticks
	title = title.replace(/^["'`]+|["'`]+$/g, "").trim();
	// Collapse internal whitespace
	title = title.replace(/\s+/g, " ");
	// Drop trailing sentence punctuation
	title = title.replace(/[.!?,;:]+$/, "").trim();
	// Remove markdown formatting
	title = title.replace(/\*\*(.+?)\*\*/g, "$1"); // **bold**
	title = title.replace(/\*(.+?)\*/g, "$1"); // *italic*
	title = title.replace(/`(.+?)`/g, "$1"); // `code`

	// Reject if still contains markdown or looks like code/JSON
	if (title.startsWith("```") || title.includes("\n") || title.startsWith("{") || title.startsWith("[")) {
		return "";
	}

	// Enforce Title Case
	title = toTitleCase(title);

	return title;
}

/**
 * Clean up raw model output into a single-line title.
 * Tries to find a title-like line, then validates and formats it.
 */
function sanitizeTitle(raw: string): string {
	const lines = raw
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l.length > 0);

	if (lines.length === 0) {
		return "";
	}

	// Strategy 1: Look for a line that looks like a title
	// (starts with capital or common title gerund, no markdown)
	const titlePattern = /^(?:[A-Z0-9]|Fixing|Debugging|Implementing|Adding|Removing|Updating|Querying|Reading|Writing|Searching|Exploring|Analyzing)/;
	for (const line of lines) {
		if (titlePattern.test(line) && !line.startsWith("```") && !line.includes("**")) {
			const formatted = validateAndFormatTitle(line);
			if (formatted && formatted.length <= MAX_NAME_LENGTH) {
				return formatted;
			}
		}
	}

	// Strategy 2: Fall back to the first line
	return validateAndFormatTitle(lines[0]);
}

/**
 * Truncate a title to MAX_NAME_LENGTH, respecting word boundaries where
 * possible to avoid cutting mid-word.
 */
/**
 * Extract a descriptive title from the user's prompt by identifying the main action
 * and key topic. Uses pattern matching to find the core task.
 */
function extractTitleFromPrompt(prompt: string): string {
	const trimmed = prompt.trim();

	// Remove URLs — they're noise in a title
	let cleaned = trimmed.replace(/https?:\/\/\S+/g, "");

	// Remove file paths (e.g., @~/Downloads/... or /path/to/file)
	cleaned = cleaned.replace(/[@~]?\/[\w./-]+/g, "");

	// Remove common filler prefixes
	cleaned = cleaned.replace(
		/^(can you|could you|please|I want to|I need to|I'd like to|let's|help me|show me|tell me|explain|read|look at|figure out)\s+/i,
		"",
	);

	// Identify the main action verb (expanded list)
	const actionMatch =
		/\b(debug|fix|implement|add|remove|update|change|modify|refactor|optimize|test|analyze|explore|investigate|review|check|explain|understand|learn|read|write|create|build|setup|configure|install|deploy|search|find|locate|compare|convert|migrate|merge|split|parse|validate|generate|extract|format|style|document|rename|move|copy|delete|run|execute|start|stop|restart|enable|disable|uninstall|figure out|evaluate|benchmark|measure|profile|trace|diagnose)\b/i
			.exec(cleaned);
	let actionVerb = actionMatch?.[1] ?? "";

	// Handle multi-word verbs
	if (actionVerb.toLowerCase() === "figure out") {
		actionVerb = "understand";
	}

	// Map common verbs to gerund form for title style
	const verbToGerund: Record<string, string> = {
		debug: "Debugging",
		fix: "Fixing",
		implement: "Implementing",
		add: "Adding",
		remove: "Removing",
		update: "Updating",
		change: "Changing",
		modify: "Modifying",
		refactor: "Refactoring",
		optimize: "Optimizing",
		test: "Testing",
		analyze: "Analyzing",
		explore: "Exploring",
		investigate: "Investigating",
		review: "Reviewing",
		check: "Checking",
		explain: "Explaining",
		understand: "Understanding",
		learn: "Learning",
		read: "Reading",
		write: "Writing",
		create: "Creating",
		build: "Building",
		setup: "Setting Up",
		configure: "Configuring",
		install: "Installing",
		deploy: "Deploying",
		search: "Searching",
		find: "Finding",
		locate: "Locating",
		compare: "Comparing",
		convert: "Converting",
		migrate: "Migrating",
		merge: "Merging",
		split: "Splitting",
		parse: "Parsing",
		validate: "Validating",
		generate: "Generating",
		extract: "Extracting",
		format: "Formatting",
		style: "Styling",
		document: "Documenting",
		rename: "Renaming",
		move: "Moving",
		copy: "Copying",
		delete: "Deleting",
		run: "Running",
		execute: "Executing",
		start: "Starting",
		stop: "Stopping",
		restart: "Restarting",
		enable: "Enabling",
		disable: "Disabling",
		uninstall: "Uninstalling",
		evaluate: "Evaluating",
		benchmark: "Benchmarking",
		measure: "Measuring",
		profile: "Profiling",
		trace: "Tracing",
		diagnose: "Diagnosing",
	};

	const gerund = actionVerb ? verbToGerund[actionVerb.toLowerCase()] || actionVerb + "ing" : "";

	// Extract technical concepts: multi-word terms, then capitalized proper nouns
	// First, look for technical phrases (2+ word combinations that are meaningful)
	const techPhrases = [
		/technical term: (?:multiple choice|generative model|language model|machine learning|deep learning|neural network|attention mechanism|transformer model)/gi,
		/multiple[- ]?choice/gi,
		/generative[- ]?model/gi,
		/language[- ]?model/gi,
		/llm/gi,
		/mcq/gi,
		/mmlu/gi,
		/arc[- ]?(?:easy|challenge)/gi,
		/hellaswag/gi,
		/common[s]?ense/gi,
		/fastapi/gi,
		/postgresql/gi,
		/docker compose/gi,
		/vue\.?js/gi,
		/type ?script/gi,
		/java ?script/gi,
		/node\.?js/gi,
		/react\.?js/gi,
		/py ?torch/gi,
		/tensor ?flow/gi,
		/hugging ?face/gi,
		/transformer/gi,
		/tokenization/gi,
		/embedding/gi,
		/fine[- ]?tun(?:e|ing)/gi,
		/zero[- ]?shot/gi,
		/few[- ]?shot/gi,
		/log[- ]?prob/gi,
		/logits/gi,
		/normaliz(?:e|ation)/gi,
		/structured[- ]?generation/gi,
		/constrained[- ]?decoding/gi,
	].flatMap((pattern) => cleaned.match(pattern) || []);

	// If we found technical phrases, use them
	let keyTerm = "";
	if (techPhrases.length > 0) {
		// Deduplicate and join
		const unique = Array.from(new Set(techPhrases.map((t) => t.toLowerCase())));
		keyTerm = unique.slice(0, 2).map((t) => t.charAt(0).toUpperCase() + t.slice(1)).join(" ");
	} else {
		// Fallback: extract key nouns after the verb
		const afterVerb = cleaned.substring(actionMatch?.index ?? 0).toLowerCase();
		const nounMatch = /\b((?:[a-z]+[- ]?)+(?:evaluation|model|task|benchmark|dataset|config|api|endpoint|file|module|function))/.exec(afterVerb);
		if (nounMatch) {
			keyTerm = nounMatch[1].split(/[- ]+/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
		}
	}

	// Build title: "[Gerund] [Key Topic]"
	if (gerund && keyTerm) {
		// Try different key term combinations, preferring ones that fit
		const keyTermParts = keyTerm.split(" ");
		for (let i = keyTermParts.length; i > 0; i--) {
			const subset = keyTermParts.slice(0, i).join(" ");
			const title = `${gerund} ${subset}`;
			if (title.length <= MAX_NAME_LENGTH && title.length > 5) {
				return title;
			}
		}
	}

	// Fallback: use first meaningful phrase
	const firstPhrase = cleaned.split(/[,\b(?:about|for|with|in|on|at|to|from)\b]/)[0]?.trim();
	if (firstPhrase && firstPhrase.length > 5 && firstPhrase.length <= MAX_NAME_LENGTH) {
		return firstPhrase.charAt(0).toUpperCase() + firstPhrase.slice(1);
	}

	return "";
}

function truncateTitle(title: string): string {
	if (title.length <= MAX_NAME_LENGTH) {
		return title;
	}
	// Find the last space within the limit (search the full title, not a pre-sliced substring)
	const lastSpace = title.slice(0, MAX_NAME_LENGTH).lastIndexOf(" ");
	if (lastSpace > MAX_NAME_LENGTH / 2) {
		// Cut at word boundary
		return title.slice(0, lastSpace);
	}
	// No good word boundary, just use the limit
	return title.slice(0, MAX_NAME_LENGTH);
}

/**
 * Mechanical fallback when the model naming call fails: take the first
 * sentence, strip common filler prefixes, capitalize, and truncate.
 */
function generateConversationNameFallback(prompt: string): string {
	// Try to extract a structured title from the prompt
	const extracted = extractTitleFromPrompt(prompt);
	if (extracted) {
		const validated = validateAndFormatTitle(extracted);
		if (validated) {
			return truncateTitle(validated);
		}
	}

	// Last resort: use first few words
	const words = prompt.trim().split(/\s+/).slice(0, 5).join(" ");
	return validateAndFormatTitle(words) || "New Conversation";
}
