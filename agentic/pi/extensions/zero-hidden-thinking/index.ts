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
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
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
function findPackageRoot(startPath: string): string | null {
	let current = dirname(startPath);
	while (true) {
		if (existsSync(resolve(current, "package.json"))) return current;
		const parent = dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

function resolvePiPackageRoot(): string | null {
	const candidates: string[] = [];

	try {
		// This works when extension-local resolution can see the Pi package.
		candidates.push(require.resolve("@earendil-works/pi-coding-agent"));
	} catch {
		// The global package is often outside the extension's resolution paths.
	}

	const cliPath = process.argv[1];
	if (cliPath) {
		try {
			candidates.push(realpathSync(cliPath));
		} catch {
			// Ignore invalid launch paths and fail open below.
		}
	}

	for (const candidate of candidates) {
		const pkgRoot = findPackageRoot(candidate);
		if (pkgRoot) return pkgRoot;
	}
	return null;
}

async function loadAssistantMessageComponent(pkgRoot: string): Promise<unknown> {
	const modulePaths: string[] = [];
	const cliArg = process.argv[1];

	if (cliArg) {
		try {
			const cliPath = realpathSync(cliArg);
			const cliSource = readFileSync(cliPath, "utf8");
			const importPattern = /(?:from\s*|import\s*)["'](\.[^"']+\.js)["']/g;
			for (const match of cliSource.matchAll(importPattern)) {
				modulePaths.push(resolve(dirname(cliPath), match[1]));
			}
		} catch {
			// Older Pi launchers may not be readable or bundled.
		}
	}

	// Pre-bundle Pi releases expose the renderer at this stable path.
	modulePaths.push(
		resolve(pkgRoot, "dist", "modes", "interactive", "components", "assistant-message.js")
	);

	for (const modulePath of new Set(modulePaths)) {
		if (!existsSync(modulePath)) continue;
		try {
			// Importing the bundle chunk by its canonical URL returns the same cached
			// module instance that the CLI uses.
			const mod = await import(pathToFileURL(modulePath).href);
			if (mod.AssistantMessageComponent) return mod.AssistantMessageComponent;
		} catch {
			// Try the next layout, then fail open if none match.
		}
	}
	return null;
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

	const AssistantMessageComponent = await loadAssistantMessageComponent(pkgRoot);
	if (!AssistantMessageComponent) {
		console.warn(
			"[zero-hidden-thinking] Warning: AssistantMessageComponent not found in Pi's " +
				"bundled or unbundled modules. Patch not applied (fail-open)."
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
	proto.updateContent = function (this: any, message: unknown, ...rest: unknown[]): void {
		if (!this.hideThinkingBlock) {
			// Not hidden → call original unchanged, including newer optional arguments.
			return originalUpdateContent.call(this, message, ...rest);
		}

		// Hidden → filter out thinking blocks from a shallow clone
		const msg = message as Message;
		const filteredMessage: Message = { ...msg };

		if (msg.content) {
			// Shallow clone content array, filtering out thinking blocks
			filteredMessage.content = msg.content.filter((block) => block.type !== "thinking");
		}

		try {
			originalUpdateContent.call(this, filteredMessage, ...rest);
		} finally {
			// Restore the original so expanding/toggling reasoning keeps full traces.
			this.lastMessage = message;
		}
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
		// Patch applied—the extension's job is done. Re-resolve on session changes
		// because /reload can replace extension/runtime module state.
		pi.on("session_start", async () => {
			await applyPatch();
		});
	}
	// If patch failed, we've already logged a warning—fail-open, no further action.
}
