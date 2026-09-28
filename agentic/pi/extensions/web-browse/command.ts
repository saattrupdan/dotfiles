export interface ParsedCommand {
	name: string;
	args: string[];
}

/** Parse a command string without invoking a shell. */
export function parseCommand(command: string): ParsedCommand {
	const tokens: string[] = [];
	let current = "";
	let quote: '"' | "'" | null = null;
	let escaped = false;
	let started = false;

	for (const ch of command) {
		if (escaped) {
			current += ch;
			escaped = false;
			started = true;
			continue;
		}
		if (ch === "\\") {
			escaped = true;
			started = true;
			continue;
		}
		if (quote) {
			if (ch === quote) quote = null;
			else current += ch;
			started = true;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			started = true;
			continue;
		}
		if (/\s/.test(ch)) {
			if (started) {
				tokens.push(current);
				current = "";
				started = false;
			}
			continue;
		}
		current += ch;
		started = true;
	}

	if (escaped) current += "\\";
	if (quote) throw new Error("unterminated quoted string");
	if (started) tokens.push(current);
	if (tokens.length === 0) throw new Error("empty command");
	return { name: tokens[0].toLowerCase(), args: tokens.slice(1) };
}

/** Avoid putting form payloads into Pi's transcript or renderer. */
export function safeCommandPreview(command: string): string {
	try {
		const { name, args } = parseCommand(command);
		if (name === "fill" || name === "type" || name === "select") {
			return `${name}${args[0] ? ` ${args[0]}` : ""} [text redacted]`;
		}
		const normalized = [name, ...args].join(" ");
		return normalized.length > 80 ? `${normalized.slice(0, 80)}…` : normalized;
	} catch {
		return "invalid command";
	}
}
