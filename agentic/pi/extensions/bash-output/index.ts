/** Main and replayed bash rows share their native rendering and collapsed status. */
import { createBashToolDefinition, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { bashToolRenderers } from "../_tool-display/catalog.ts";

export default function (pi: ExtensionAPI) {
	pi.registerTool({ ...createBashToolDefinition(process.cwd()), ...bashToolRenderers });
}
