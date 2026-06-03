/**
 * Shared library for detecting macOS lid state.
 *
 * Exported functions:
 *   - `isLidClosed()`: returns `true` if the lid is closed (clamshell mode)
 *   - `getLidState()`: returns `"closed"` | `"open"` | `"unknown"`
 *
 * Uses `ioreg` to read the AppleClamshellState property. macOS-only; returns
 * `false`/`"unknown"` on other platforms.
 */

import { execSync } from "node:child_process";
import * as os from "node:os";

const IS_MACOS = os.platform() === "darwin";

/**
 * Check if the laptop lid is closed.
 * @returns `true` if the lid is closed, `false` if open or unknown (non-macOS).
 */
export function isLidClosed(): boolean {
	if (!IS_MACOS) return false;

	try {
		// AppleClamshellState: Yes = closed, No = open
		const output = execSync(
			"ioreg -r -l -n AppleClamshellState 2>/dev/null",
			{ encoding: "utf8", maxBuffer: 10 * 1024 }
		);
		// Look for "AppleClamshellState" = Yes (case-insensitive for robustness)
		return /AppleClamshellState.*=\s*Yes/i.test(output);
	} catch {
		// If ioreg fails or is unavailable, assume unknown → treat as open
		return false;
	}
}

/**
 * Get the current lid state as a string.
 * @returns `"closed"` | `"open"` | `"unknown"`
 */
export function getLidState(): "closed" | "open" | "unknown" {
	if (!IS_MACOS) return "unknown";

	try {
		const output = execSync(
			"ioreg -r -l -n AppleClamshellState 2>/dev/null",
			{ encoding: "utf8", maxBuffer: 10 * 1024 }
		);
		if (/AppleClamshellState.*=\s*Yes/i.test(output)) {
			return "closed";
		}
		if (/AppleClamshellState.*=\s*No/i.test(output)) {
			return "open";
		}
		return "unknown";
	} catch {
		return "unknown";
	}
}
