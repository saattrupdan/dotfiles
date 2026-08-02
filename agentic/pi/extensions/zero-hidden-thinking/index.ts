/**
 * Zero-line hidden thinking blocks for Pi.
 *
 * Monkey-patches the installed Pi `AssistantMessageComponent.updateContent` to
 * filter out thinking blocks entirely when hidden, yielding true zero-line rendering.
 *
 * ## Problem
 *
 * The built-in renderer always adds a `Text` node for hidden thinking blocks:
 *
 *     this.contentContainer.addChild(new Text(
 *       theme.italic(theme.fg("thinkingText", hiddenThinkingLabel)), ...
 *     ));
 *
 * Even with an empty label, `theme.fg()` wraps the text in ANSI color/reset
 * sequences, so `Text.render()` produces one blank line rather than zero.
 * The `thinking-status` extension sets the label to `"(…)"` by default.
 *
 * ## Solution
 *
 * Wrap `updateContent` to intercept hidden thinking blocks:
 * - When `hideThinkingBlock === true`, call the original with a shallow-cloned
 *   message whose `content` array filters out `type === "thinking"` blocks.
 * - Restore `this.lastMessage` to the original message afterward so expanding/
 *   toggling reasoning still has the full traces.
 * - When not hidden, call the original unchanged.
 *
 * ## Constraints
 *
 * - **Extension-only**: does not edit installed package files.
 * - **No session mutation**: original message is never mutated.
 * - **Preserves expanded thinking**: visible thinking blocks render normally.
 * - **Idempotent**: Symbol.for() guard on prototype prevents double-wrapping.
 * - **Fail-open**: logs a warning and continues if internals are unavailable.
 * - **Label-agnostic**: hides collapsed thinking regardless of label text.
 *
 * ⚠️ **Private-internals risk**: This patches implementation details of the
 * installed `@earendil-works/pi-coding-agent` package. Future Pi updates may
 * change the internal structure and break this patch. Tested against the
 * structure as of the current installed version.
 *
 * @see https://pi.dev/docs/latest/extensions
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// ─────────────────────────────────────────────────────────────────────────────
// Idempotent patch guard (stored on prototype via Symbol.for)
// ─────────────────────────────────────────────────────────────────────────────
// Using Symbol.for() ensures the guard survives module reloads and is shared
// across all instances of AssistantMessageComponent.
const PATCH_SYMBOL = Symbol.for("pi.zeroHiddenThinking.patched");

// ─────────────────────────────────────────────────────────────────────────────
// Helper: resolve installed Pi package root
// ─────────────────────────────────────────────────────────────────────────────
function resolvePiPackageRoot(): string | null {
	try {
		// The extension runtime provides `require`; in Pi's global install this
		// resolves against the running CLI package even though this extension lives
		// outside that package.
		const resolvedPath = require.resolve("@earendil-works/pi-coding-agent");
		// resolvedPath points to dist/index.js (or similar), walk up to package root.
		return resolve(resolvedPath, "..", "..");
	} catch {
		// Fallback for runtimes where extension-local resolution cannot see the
		// global package. The pi binary is normally a symlink to
		// <pkg-root>/dist/cli.js, so realpath(process.argv[1]) gives us the package.
		const cliPath = process.argv[1];
		if (!cliPath) return null;
		try {
			const pkgRoot = resolve(realpathSync(cliPath), "..", "..");
			return existsSync(resolve(pkgRoot, "package.json")) ? pkgRoot : null;
		} catch {
			return null;
		}
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Message types (minimal, for filtering)
// ─────────────────────────────────────────────────────────────────────────────
type MessageContentBlock = { type: string; [key: string]: unknown };
type Message = {
	content?: MessageContentBlock[];
	[k: string]: unknown;
};

// ─────────────────────────────────────────────────────────────────────────────
// Apply the zero-hidden-thinking patch
// ─────────────────────────────────────────────────────────────────────────────
async function applyPatch(): Promise<boolean> {
	const pkgRoot = resolvePiPackageRoot();
	if (!pkgRoot) {
		console.warn(
			"[zero-hidden-thinking] Warning: Could not resolve pi-coding-agent package root. " +
				"Patch not applied (fail-open)."
		);
		return false;
	}

	// Path to the compiled assistant-message module
	// Structure: <pkg-root>/dist/modes/interactive/components/assistant-message.js
	const assistantMessagePath = resolve(
		pkgRoot,
		"dist",
		"modes",
		"interactive",
		"components",
		"assistant-message.js"
	);

	let AssistantMessageComponent: unknown;

	try {
		// Use dynamic ESM import with pathToFileURL to load the SAME module instance
		// that Pi's TUI uses, rather than a separate jiti/require-loaded copy.
		const mod = await import(pathToFileURL(assistantMessagePath).href);
		AssistantMessageComponent = mod.AssistantMessageComponent;

		if (!AssistantMessageComponent) {
			console.warn(
				"[zero-hidden-thinking] Warning: AssistantMessageComponent not found in module. " +
					"Patch not applied (fail-open)."
			);
			return false;
		}
	} catch (err) {
		const error = err instanceof Error ? err : new Error(String(err));
		console.warn(
			"[zero-hidden-thinking] Warning: Failed to load assistant-message module: " +
				`${error.message}. Patch not applied (fail-open).`
		);
		return false;
	}

	// ──────────────────────────────────────────────────────────────────────────
	// Monkey-patch updateContent via prototype wrapper
	// ──────────────────────────────────────────────────────────────────────────
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const proto = (AssistantMessageComponent as any).prototype;

	// Check if already patched (idempotent guard on prototype).
	if (proto[PATCH_SYMBOL]) {
		return true;
	}

	const originalUpdateContent = proto.updateContent;
	if (typeof originalUpdateContent !== "function") {
		console.warn(
			"[zero-hidden-thinking] Warning: updateContent is not a function. " +
				"Patch not applied (fail-open)."
		);
		return false;
	}

	// Wrapper that filters thinking blocks when hidden
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	proto.updateContent = function (this: any, message: unknown): void {
		if (!this.hideThinkingBlock) {
			// Not hidden → call original unchanged
			return originalUpdateContent.call(this, message);
		}

		// Hidden → filter out thinking blocks from a shallow clone
		const msg = message as Message;
		const filteredMessage: Message = { ...msg };

		if (msg.content) {
			// Shallow clone content array, filtering out thinking blocks
			filteredMessage.content = msg.content.filter((block) => block.type !== "thinking");
		}

		// Call original with filtered message
		originalUpdateContent.call(this, filteredMessage);

		// Restore lastMessage to original so expanding/toggling reasoning still works
		this.lastMessage = message;
	};

	// Mark prototype as patched (idempotent guard on the ACTUAL ESM prototype)
	proto[PATCH_SYMBOL] = true;

	// Behavioral probe: verify the patch marker is visible on the prototype.
	if (proto[PATCH_SYMBOL] !== true) {
		console.warn(
			"[zero-hidden-thinking] Warning: Patch applied but Symbol.for probe failed. " +
				"This may indicate a module instance mismatch."
		);
	}
	return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Extension entry point
// ─────────────────────────────────────────────────────────────────────────────
export default async function (pi: ExtensionAPI): Promise<void> {
	const success = await applyPatch();

	if (success) {
		// Patch applied—the extension's job is done.
		// The thinking-status extension can set any label (e.g. "(…)") and
		// collapsed thinking will still render as zero lines.
		pi.on("session_start", async () => {
			// Verify patch is still active after session reset using the same ESM import
			const pkgRoot = resolvePiPackageRoot();
			if (pkgRoot) {
				const assistantMessagePath = resolve(
					pkgRoot,
					"dist",
					"modes",
					"interactive",
					"components",
					"assistant-message.js"
				);
				try {
					const mod = await import(pathToFileURL(assistantMessagePath).href);
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					const proto = (mod.AssistantMessageComponent as any).prototype;
					if (!proto[PATCH_SYMBOL]) {
						console.warn(
							"[zero-hidden-thinking] Warning: Patch was lost after session_start. " +
								"Re-applying..."
						);
						await applyPatch();
					}
				} catch (err) {
					const error = err instanceof Error ? err : new Error(String(err));
					console.warn(
						`[zero-hidden-thinking] Warning: Could not verify patch after session_start: ${error.message}. ` +
							"Re-applying..."
					);
					await applyPatch();
				}
			}
		});
	}
	// If patch failed, we've already logged a warning—fail-open, no further action.
}
