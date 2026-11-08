import { registerRemoteCommand } from "../_remote_bridge/commands.ts";
/** Cap model context windows globally, with a persistent per-session opt-out. */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const CONTEXT_LIMIT = 256_000;
const ENTRY_TYPE = "context-limit:allow-long-context";
type Model = NonNullable<ExtensionContext["model"]>;
type Provider = NonNullable<ReturnType<ExtensionContext["modelRegistry"]["getProvider"]>>;

export default function (pi: ExtensionAPI) {
	let allowLongContext = false;
	const originalWindows = new WeakMap<Model, number>();
	const selectedWindows = new Map<Model, number>();
	const providers = new Map<Provider, { getModels: Provider["getModels"]; getAllModels: Provider["getAllModels"] }>();

	const nativeWindow = (model: Model) => originalWindows.get(model) ?? model.contextWindow;
	const effectiveWindow = (original: number) => allowLongContext ? original : Math.min(original, CONTEXT_LIMIT);
	const limitModel = (model: Model): Model => {
		const original = nativeWindow(model);
		const limited = { ...model, contextWindow: effectiveWindow(original) };
		originalWindows.set(limited, original);
		return limited;
	};
	const applyLimit = (ctx: ExtensionContext) => {
		for (const id of new Set(ctx.modelRegistry.getAll().map(model => model.provider))) {
			const provider = ctx.modelRegistry.getProvider(id);
			if (!provider || providers.has(provider)) continue;
			const { getModels, getAllModels } = provider;
			providers.set(provider, { getModels, getAllModels });
			// Providers may compose fresh objects on every lookup, including virtual routing.
			// Return limited copies so their native catalogs remain intact.
			provider.getModels = () => getModels.call(provider).map(limitModel);
			if (getAllModels) {
				provider.getAllModels = () => getAllModels.call(provider).map(model =>
					model.type === "image" || model.type === "classifier" ? model : limitModel(model));
			}
		}
		if (ctx.model) {
			const original = nativeWindow(ctx.model);
			originalWindows.set(ctx.model, original);
			selectedWindows.set(ctx.model, original);
			ctx.model.contextWindow = effectiveWindow(original);
		}
		ctx.ui.setStatus("long-context", allowLongContext ? "🧠" : undefined);
	};
	const restoreSession = (_event: unknown, ctx: ExtensionContext) => {
		const entry = [...ctx.sessionManager.getBranch()].reverse().find(entry =>
			entry.type === "custom" && entry.customType === ENTRY_TYPE);
		allowLongContext = entry?.type === "custom"
			? (entry.data as { enabled?: unknown } | undefined)?.enabled === true
			: pi.getFlag("allow-long-context") === true;
		if (!entry && allowLongContext) pi.appendEntry(ENTRY_TYPE, { enabled: true });
		applyLimit(ctx);
	};

	pi.registerFlag("allow-long-context", {
		description: "Use full provider/model context windows instead of the 256k cap.",
		type: "boolean",
		default: false,
	});
	const remoteCommand = {
		description: "Use full model context for this session; /allow-long-context off restores the 256k cap.",
		async handler(args:string, ctx:ExtensionContext) {
			const option = args.trim();
			if (option !== "" && option !== "off") {
				ctx.ui.notify("Usage: /allow-long-context [off]", "error");
				return;
			}
			allowLongContext = option !== "off";
			pi.appendEntry(ENTRY_TYPE, { enabled: allowLongContext });
			applyLimit(ctx);
			ctx.ui.notify(allowLongContext ? "Long context enabled: using full provider/model limits." : "Context capped at 256k tokens (or the model's smaller limit).", "info");
		},
	};
	pi.registerCommand("allow-long-context",remoteCommand);
	registerRemoteCommand("allow-long-context",remoteCommand.handler);

	pi.on("session_start", restoreSession);
	pi.on("session_tree", restoreSession);
	pi.on("model_select", (_event, ctx) => applyLimit(ctx));
	// Refreshes can replace providers without changing the selected model ID.
	pi.on("input", (_event, ctx) => applyLimit(ctx));
	pi.on("before_agent_start", (_event, ctx) => applyLimit(ctx));
	pi.on("turn_start", (_event, ctx) => applyLimit(ctx));
	pi.on("session_shutdown", (_event, ctx) => {
		for (const [provider, original] of providers) {
			provider.getModels = original.getModels;
			provider.getAllModels = original.getAllModels;
		}
		for (const [model, original] of selectedWindows) model.contextWindow = original;
		providers.clear();
		selectedWindows.clear();
		ctx.ui.setStatus("long-context", undefined);
	});
}
