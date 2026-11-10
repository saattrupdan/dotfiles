import { codemodeRenderers } from "../_tool-display/renderers.ts";
/** Keep codemode's script and nested results behind Ctrl+O, like bash output. */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { renderExpandedCall } from "../_tool-display/expanded-call.ts";

export default function (pi: ExtensionAPI): void {
	pi.registerToolRenderer((name, next) => {
		if (name !== "codemode") return next();
		const original = next();
		return {
			...original,
			renderCall(args, theme, context) {
				if (context.expanded) return original?.renderCall?.(args, theme, context)
					?? renderExpandedCall("codemode", args, theme);
				return codemodeRenderers.renderCall!({}, theme, { ...context, args: {} });
			},
			renderResult(result, options, theme, context) {
				if (options.expanded) return original?.renderResult?.(result, options, theme, context)
					?? new Text(result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n"), 0, 0);
				return codemodeRenderers.renderResult!(result, options, theme, { ...context, args: {} });
			},
		};
	});
}
