/** Collapse adjacent terminal read calls without changing messages, tools, or stored sessions. */
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { getPackageDir, type ExtensionAPI, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { Container } from "@earendil-works/pi-tui";
import { attachReadGroups, type NativeRows } from "./grouping.ts";

const PATCHED = Symbol.for("pi.readGroups.runtime");

interface InteractiveHost {
	chatContainer?: Container;
	ui: { requestRender(): void };
}

interface Runtime extends NativeRows {
	InteractiveMode: {
		prototype: {
			[PATCHED]?: boolean;
			createExtensionUIContext(this: InteractiveHost): ExtensionUIContext;
			renderSessionItems(this: InteractiveHost, ...args: unknown[]): void;
		};
	};
}

/** Startup, /reload, and session switches all rebuild through this one private-runtime seam. */
export function patchReadGrouping(runtime: Runtime): boolean {
	const proto = runtime.InteractiveMode?.prototype;
	if (!proto || typeof proto.createExtensionUIContext !== "function"
		|| typeof proto.renderSessionItems !== "function"
		|| typeof runtime.ToolExecutionComponent !== "function"
		|| typeof runtime.AssistantMessageComponent !== "function") return false;
	if (proto[PATCHED]) return true;
	const original = proto.renderSessionItems;
	proto.renderSessionItems = function (...args) {
		const context = proto.createExtensionUIContext.call(this);
		if (this.chatContainer) attachReadGroups(this.chatContainer, runtime, {
			theme: () => context.theme,
			requestRender: () => this.ui.requestRender(),
		});
		return original.apply(this, args);
	};
	proto[PATCHED] = true;
	return true;
}

export default async function (_pi: ExtensionAPI): Promise<void> {
	// The CLI's bundled classes differ from dist/index.js. Patch the actual module graph, not a copy.
	const root = getPackageDir();
	const bundle = path.join(root, "dist/bundle/index.js");
	const entry = existsSync(bundle) ? bundle : path.join(root, "dist/index.js");
	try {
		const runtime = await import(pathToFileURL(entry).href) as Runtime;
		if (!patchReadGrouping(runtime)) console.warn("[read-groups] Pi's terminal hooks changed; keeping native tool rows.");
	} catch (error) {
		console.warn("[read-groups] Could not attach terminal grouping; keeping native tool rows:", error);
	}
}
