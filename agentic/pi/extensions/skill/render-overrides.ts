import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";

import { collapseAutoloadResult } from "./types.ts";

// Built-in tools that skill autoload can block. `read` is handled by the `read`
// extension (itself a custom tool). `bash` is intentionally excluded: autoload
// matches only on an `input.path`, which bash never has, so it is never the
// target of an injection.
const OVERRIDDEN_TOOLS = ["write", "edit"] as const;

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
 */
export async function registerAutoloadRenderOverrides(pi: ExtensionAPI): Promise<void> {
	// Guard the built-in import/registration: collapsed rendering is a cosmetic
	// nicety, so a future pi API change must never take down the core skill tool
	// or autoload (already registered by the time we get here).
	try {
		const tools = (await import("$PI/dist/core/tools/index.js" as any)) as {
			createWriteToolDefinition: (cwd: string) => ToolDefinition;
			createEditToolDefinition: (cwd: string) => ToolDefinition;
		};
		const cwd = process.cwd();
		const defs: Record<(typeof OVERRIDDEN_TOOLS)[number], ToolDefinition> = {
			write: tools.createWriteToolDefinition(cwd),
			edit: tools.createEditToolDefinition(cwd),
		};

		for (const name of OVERRIDDEN_TOOLS) {
			const def = defs[name];
			const original = def.renderResult;
			if (!original) continue;
			def.renderResult = (result, options, theme, context) =>
				original(collapseAutoloadResult(result, options.expanded, context.isError), options, theme, context);
			pi.registerTool(def);
		}
	} catch {
		// Built-in tool factories moved or changed — leave the built-in renderers
		// in place (injections just render uncollapsed, as before this change).
	}
}
