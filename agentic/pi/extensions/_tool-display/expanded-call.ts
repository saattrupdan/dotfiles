/** Full submitted arguments for expanded tool calls; callers redact sensitive values first. */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

export function renderExpandedCall(name: string, args: unknown, theme: Theme): Text {
	const lines = [theme.fg("toolTitle", theme.bold(name))];
	if (args !== null && typeof args === "object") {
		for (const [key, value] of Object.entries(args)) {
			if (value === undefined) continue;
			lines.push(`${key}: ${typeof value === "string" ? value : JSON.stringify(value, null, 2)}`);
		}
	} else if (args !== undefined) {
		lines.push(typeof args === "string" ? args : JSON.stringify(args));
	}
	return new Text(lines.join("\n"), 0, 0);
}
