/** Toggle Codex Fast mode for the active Pi session. */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "fast";

function isCodex(ctx: ExtensionContext): boolean {
	return ctx.model?.provider === "openai-codex" && ctx.model.api === "openai-codex-responses";
}

export default function (pi: ExtensionAPI) {
	let enabled = false;

	const updateStatus = (ctx: ExtensionContext) => {
		ctx.ui.setStatus(STATUS_KEY, enabled && isCodex(ctx) ? "⚡️" : undefined);
	};

	pi.registerCommand("fast", {
		description: "Toggle Codex Fast mode; use /fast off to return to Standard speed.",
		async handler(args, ctx) {
			const option = args.trim();
			if (option !== "" && option !== "off") {
				ctx.ui.notify("Usage: /fast [off]", "error");
				return;
			}
			if (option === "off") {
				enabled = false;
			} else if (!isCodex(ctx)) {
				ctx.ui.notify("Fast mode is only available with a Codex model.", "error");
				return;
			} else {
				enabled = !enabled;
			}
			updateStatus(ctx);
			ctx.ui.notify(enabled ? "Codex Fast mode on (uses subscription allowance 2.5× faster)." : "Codex Fast mode off.", "info");
		},
	});

	pi.on("model_select", (_event, ctx) => {
		if (!isCodex(ctx)) enabled = false;
		updateStatus(ctx);
	});
	pi.on("session_start", (_event, ctx) => {
		if (!isCodex(ctx)) enabled = false;
		updateStatus(ctx);
	});
	pi.on("before_provider_request", (event, ctx) => {
		if (!enabled || !isCodex(ctx) || !event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) return;
		return { ...event.payload, service_tier: "fast" };
	});
}
