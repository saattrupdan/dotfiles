/** Keep codemode output behind Ctrl+O using the shared native composition. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { collapseCodemodeRenderers } from "../_tool-display/renderers.ts";

export default function (pi: ExtensionAPI): void {
	pi.registerToolRenderer((name, next) =>
		name === "codemode" ? collapseCodemodeRenderers(next()) : next());
}
