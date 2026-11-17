/** Render-only adapter for Pi modules not yet exported at the package root. */
import { createRequire } from "node:module";
import path from "node:path";
import { getPackageDir, type ToolRenderers } from "@earendil-works/pi-coding-agent";

const require = createRequire(import.meta.url);
const root = getPackageDir();
const builtins = require(path.join(root, "dist/core/tools/renderers/index.js")) as {
	createAllToolRenderers(): Record<string, ToolRenderers>;
};
const codemode = require(path.join(root, "dist/extensions/codemode/renderer.js")) as {
	codemodeRenderers: ToolRenderers;
};
if (typeof builtins.createAllToolRenderers !== "function" || !codemode.codemodeRenderers?.renderCall)
	throw new Error("Pi's render-only tool modules changed; update _tool-display/native.ts");

export const nativeToolRenderers = builtins.createAllToolRenderers();
export const nativeCodemodeRenderers = codemode.codemodeRenderers;

/** Native shell/codemode clocks live in renderer state and have no public disposal hook. */
export function stopNativeTimer(state: unknown): void {
	if (!state || typeof state !== "object") return;
	const clock = state as { interval?: ReturnType<typeof setInterval> };
	if (clock.interval) clearInterval(clock.interval);
	clock.interval = undefined;
}
