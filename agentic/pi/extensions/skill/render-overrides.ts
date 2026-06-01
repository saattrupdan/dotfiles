import {
	createWriteToolDefinition,
	type ExtensionAPI,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";

import { collapseAutoloadResult } from "./types.ts";

/**
 * Register `def` after wrapping its result renderer to collapse a skill-autoload
 * injection to its summary line. Generic over the concrete schema/details/state
 * so the wrapped renderer's parameters keep their precise built-in types.
 */
function registerWithCollapsedAutoload<P extends TSchema, D, S>(pi: ExtensionAPI, def: ToolDefinition<P, D, S>): void {
	const original = def.renderResult;
	if (!original) return;
	def.renderResult = (result, options, theme, context) =>
		original(collapseAutoloadResult(result, options.expanded, context.isError), options, theme, context);
	pi.registerTool(def);
}

/**
 * Override the built-in `write` tool with a thin wrapper that reuses the
 * built-in definition verbatim — same execute, schema, and call renderer — and
 * only wraps the result renderer to collapse a skill-autoload injection to its
 * summary line.
 *
 * Autoload injects guidance as the reason of a blocked tool call, which the
 * harness turns into an error result the built-in renderers show in full even
 * when collapsed. Extension tools override built-ins of the same name (see
 * agent-session's tool registry merge), so this changes nothing but the
 * collapsed rendering of an injected guidance block.
 *
 * `read` and `edit` are handled by their own extensions (each a custom tool that
 * applies the same `collapseAutoloadResult` helper) — registering them here too
 * would collide with those extensions. `bash` is intentionally excluded:
 * autoload matches only on an `input.path`, which bash never has, so it is never
 * the target of an injection. That leaves only `write` for this override.
 */
export function registerAutoloadRenderOverrides(pi: ExtensionAPI): void {
	// Guard registration: collapsed rendering is a cosmetic nicety, so a future
	// pi API change must never take down the core skill tool or autoload
	// (already registered by the time we get here).
	try {
		registerWithCollapsedAutoload(pi, createWriteToolDefinition(process.cwd()));
	} catch {
		// Built-in tool factory moved or changed — leave the built-in renderer
		// in place (injections just render uncollapsed, as before this change).
	}
}
