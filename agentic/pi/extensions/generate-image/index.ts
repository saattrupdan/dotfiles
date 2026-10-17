/** /generate-image runs local prompt enhancement and sparkie generation without an agent turn. */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "scripts", "enhance_and_generate.py");

export default function (pi: ExtensionAPI) {
	let running = false;
	pi.registerCommand("generate-image", {
		description: "Enhance a brief locally and generate an image on sparkie: /generate-image <prompt>",
		async handler(args, ctx) {
			const prompt = args.trim();
			if (!prompt) {
				ctx.ui.notify("Usage: /generate-image <prompt>", "error");
				return;
			}
			if (running) {
				ctx.ui.notify("An image is already being generated.", "warning");
				return;
			}
			running = true;
			ctx.ui.setStatus("generate-image", "Generating image…");
			try {
				const result = await pi.exec("uv", ["run", "--no-project", "python3", SCRIPT, prompt], {
					timeout: 1_000_000,
					signal: ctx.signal,
				});
				if (result.code !== 0 || result.killed) {
					throw new Error(result.stderr.trim() || "Image generation stopped.");
				}
				const output = result.stdout.trim();
				if (!path.isAbsolute(output) || !existsSync(output)) {
					throw new Error("Generator did not return an existing image path.");
				}
				pi.sendMessage({
					customType: "generate-image:result",
					content: pathToFileURL(output).href,
					display: true,
				});
			} catch (error) {
				pi.sendMessage({
					customType: "generate-image:error",
					content: error instanceof Error ? error.message : String(error),
					display: true,
				});
			} finally {
				running = false;
				ctx.ui.setStatus("generate-image", undefined);
			}
		},
	});
}
