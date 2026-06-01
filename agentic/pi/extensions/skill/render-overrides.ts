import {
	createEditToolDefinition,
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
 * Override the built-in `write`/`edit` tools with thin wrappers that reuse the
 * built-in definition verbatim — same execute, schema, and call renderer — and
 * only wrap the result renderer to collapse a skill-autoload injection to its
 * summary line.
 *
 * Autoload injects guidance as the reason of a blocked tool call, which the
 * harness turns into an error result the built-in renderers show in full even
 * when collapsed. Extension tools override built-ins of the same name (see
 * agent-session's tool registry merge), so this changes nothing but the
 * collapsed rendering of an injected guidance block. `read`'s renderer applies
 * the same `collapseAutoloadResult` helper.
 *
 * `read` is handled by the `read` extension (itself a custom tool). `bash` is
 * intentionally excluded: autoload matches only on an `input.path`, which bash
 * never has, so it is never the target of an injection.
 */
export function registerAutoloadRenderOverrides(pi: ExtensionAPI): void {
	// Guard registration: collapsed rendering is a cosmetic nicety, so a future
	// pi API change must never take down the core skill tool or autoload
	// (already registered by the time we get here).
	try {
		const cwd = process.cwd();
		registerWithCollapsedAutoload(pi, createWriteToolDefinition(cwd));
		registerWithCollapsedAutoload(pi, createEditToolDefinition(cwd));
	} catch {
		// Built-in tool factories moved or changed — leave the built-in renderers
		// in place (injections just render uncollapsed, as before this change).
	}
}
