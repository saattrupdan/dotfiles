/** Toggle Codex Fast mode for the active Pi session. */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "fast";
const ENTRY_TYPE = "fast:mode";

function isCodex(ctx: ExtensionContext): boolean {
	return ctx.model?.provider === "openai-codex" && ctx.model.api === "openai-codex-responses";
}

export default function (pi: ExtensionAPI) {
	let enabled = false;

	const updateStatus = (ctx: ExtensionContext) => {
		ctx.ui.setStatus(STATUS_KEY, enabled && isCodex(ctx) ? "⚡️" : undefined);
	};
	const disableForOtherModel = (ctx: ExtensionContext) => {
		if (!enabled || isCodex(ctx)) return;
		enabled = false;
		pi.appendEntry(ENTRY_TYPE, { enabled: false });
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
			pi.appendEntry(ENTRY_TYPE, { enabled });
			updateStatus(ctx);
			ctx.ui.notify(enabled ? "Codex Fast mode on (uses subscription allowance 2.5× faster)." : "Codex Fast mode off.", "info");
		},
	});

	pi.on("model_select", (_event, ctx) => {
		disableForOtherModel(ctx);
		updateStatus(ctx);
	});
	pi.on("session_start", (_event, ctx) => {
		enabled = false;
		for (const entry of ctx.sessionManager.getBranch().reverse()) {
			if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
			enabled = (entry.data as { enabled?: unknown } | undefined)?.enabled === true;
			break;
		}
		disableForOtherModel(ctx);
		updateStatus(ctx);
	});
	pi.on("before_provider_request", (event, ctx) => {
		if (!enabled || !isCodex(ctx) || !event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) return;
		// The ChatGPT Codex endpoint accepts the original Fast mode wire value.
		return { ...event.payload, service_tier: "priority" };
	});
}
