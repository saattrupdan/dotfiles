/** Generate images through a direct tool or /generate-image, using one shared pipeline. */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "scripts", "enhance_and_generate.py");
const Params = Type.Object({
	prompt: Type.String({ description: "Complete image brief to enhance locally and generate on sparkie." }),
	size: Type.Optional(Type.String({ description: "WIDTHxHEIGHT; default 1024x1024. Each side 512–1024 pixels, multiples of 16, at most 1 megapixel." })),
	seed: Type.Optional(Type.Integer({ description: "Sampling seed; default 42.", minimum: 0, maximum: 2 ** 32 - 1 })),
});

export default function (pi: ExtensionAPI) {
	let running = false;

	async function generate(prompt: string, signal?: AbortSignal, size?: string, seed?: number): Promise<string> {
		if (!prompt.trim()) throw new Error("Image prompt must not be empty.");
		if (running) throw new Error("An image is already being generated.");
		running = true;
		try {
			const args = ["run", "--no-project", "python3", SCRIPT, prompt];
			if (size !== undefined) args.push("--size", size);
			if (seed !== undefined) args.push("--seed", String(seed));
			const result = await pi.exec("uv", args, { timeout: 1_550_000, signal });
			if (result.code !== 0 || result.killed) {
				throw new Error(result.stderr.trim() || "Image generation stopped.");
			}
			const output = result.stdout.trim();
			if (!path.isAbsolute(output) || !existsSync(output)) {
				throw new Error("Generator did not return an existing image path.");
			}
			return output;
		} finally {
			running = false;
		}
	}

	pi.registerTool({
		name: "generate_image",
		label: "generate image",
		description: "Generate one image: enhance the brief with the local qwen3.6-35b-a3b-vision model, compile the MOSS prompt and generate a PNG on sparkie's tailnet router. Returns its /tmp path and file URL. The router is shared and unauthenticated: do not submit private briefs or sensitive input. Generation can take several minutes.",
		parameters: Params,
		async execute(_toolCallId, params, signal) {
			try {
				const output = await generate(params.prompt, signal, params.size, params.seed);
				return {
					content: [{ type: "text", text: `${output}\n${pathToFileURL(output).href}` }],
					details: undefined,
				};
			} catch (error) {
				return {
					content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
					isError: true,
					details: undefined,
				};
			}
		},
	});

	pi.registerCommand("generate-image", {
		description: "Enhance a brief locally and generate an image on sparkie: /generate-image <prompt>",
		async handler(args, ctx) {
			const prompt = args.trim();
			if (!prompt) {
				ctx.ui.notify("Usage: /generate-image <prompt>", "error");
				return;
			}
			try {
				const output = await generate(prompt, ctx.signal);
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
			}
		},
	});
}
