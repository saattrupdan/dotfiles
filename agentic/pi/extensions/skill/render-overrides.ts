/** Write execution stays built-in; rendering is shared with subagent replay. */
import { createWriteToolDefinition, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { writeToolRenderers } from "../_tool-display/catalog.ts";

export function registerAutoloadRenderOverrides(pi: ExtensionAPI): void {
	pi.registerTool({ ...createWriteToolDefinition(process.cwd()), ...writeToolRenderers });
}
