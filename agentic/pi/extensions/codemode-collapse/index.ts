/** Keep codemode's script and nested results behind Ctrl+O, like bash output. */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

export default function (pi: ExtensionAPI): void {
	pi.registerToolRenderer((name, next) => {
		if (name !== "codemode") return next();
		const original = next();
		return {
			...original,
			renderCall(args, theme, context) {
				if (context.expanded) return original?.renderCall?.(args, theme, context)
					?? new Text(theme.fg("toolTitle", theme.bold("codemode")), 0, 0);
				return new Text(theme.fg("toolTitle", theme.bold("codemode")), 0, 0);
			},
			renderResult(result, options, theme, context) {
				if (options.expanded) return original?.renderResult?.(result, options, theme, context)
					?? new Text(result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n"), 0, 0);
				if (options.isPartial) return new Text(theme.fg("warning", "⋯ codemode running"), 0, 0);
				if (context.isError) return new Text(theme.fg("error", "✗ codemode failed"), 0, 0);
				return new Text(theme.fg("success", "✓ codemode executed"), 0, 0);
			},
		};
	});
}
