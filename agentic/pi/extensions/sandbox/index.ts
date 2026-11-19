/** Open a fresh container session through the trusted launcher supervisor. */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { requestSandbox } from "../../sandbox/handoff.mjs";
import { repositorySandbox } from "../../sandbox/policy.mjs";

export default function (pi: ExtensionAPI, request = requestSandbox) {
	let opening = false;
	const open = async (ctx: ExtensionContext, required: boolean) => {
		if (opening) return;
		opening = true;
		try {
			const result = await request({ cwd: ctx.cwd, model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined, thinking: pi.getThinkingLevel(), mode: ctx.mode });
			if (result.status !== "restart") throw new Error(result.error ?? "Sandbox launch rejected");
			ctx.ui.notify("📦 Opening a fresh sandbox session; this conversation remains saved on the host.", "info");
			ctx.shutdown();
		} catch (error) {
			ctx.ui.notify(`Sandbox: ${error instanceof Error ? error.message : String(error)}`, "error");
			if (required) ctx.shutdown();
		} finally { opening = false; }
	};
	pi.registerCommand("sandbox", {
		description: "Open a fresh offline Apple Container session (📦)",
		handler: async (args, ctx) => {
			if (args.trim()) { ctx.ui.notify("Use /sandbox without arguments; this opens a fresh session.", "error"); return; }
			await ctx.waitForIdle();
			await open(ctx, false);
		},
	});
	// /new, /resume and /reload also begin sessions without restarting the launcher.
	pi.on("session_start", async (_event, ctx) => {
		try { if (repositorySandbox(ctx.cwd)) await open(ctx, true); }
		catch (error) { ctx.ui.notify(`Sandbox config: ${error instanceof Error ? error.message : String(error)}`, "error"); ctx.shutdown(); }
	});
}
