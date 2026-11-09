/** Generate images through the generate_image tool. */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { renderExpandedCall } from "../_tool-display/expanded-call.ts";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "scripts", "enhance_and_generate.py");
const MAX_IMAGES = 10;

function formatImages(paths: string[]): string {
	return paths.length === 1 ? `Image: ${paths[0]}` : `Images:\n${paths.join("\n")}`;
}

const Params = Type.Object({
	prompt: Type.String({ description: "Final, detailed visual prompt for Kromoss. Describe the intended image directly, including subjects, composition, style and exact visible text. This prompt is sent without local LLM enhancement." }),
	size: Type.Optional(Type.String({ description: "WIDTHxHEIGHT; default 512x512. Each side 512–1024 pixels, multiples of 16, at most 1 megapixel." })),
	num: Type.Optional(Type.Integer({ description: "Number of images to generate (1–10); default 1. All images share one output directory.", minimum: 1, maximum: MAX_IMAGES })),
});

export default function (pi: ExtensionAPI) {
	let running = false;

	async function generate(
		prompt: string, onPhase: (label: string) => void, signal?: AbortSignal, size?: string,
		num = 1,
	): Promise<{ paths: string[]; compiledPrompt: string }> {
		if (!prompt.trim()) throw new Error("Image prompt must not be empty.");
		if (!Number.isSafeInteger(num) || num < 1 || num > MAX_IMAGES) throw new Error("num must be between 1 and 10.");
		if (running) throw new Error("An image is already being generated.");
		running = true;
		try {
			onPhase("Generating image...");
			const args = ["run", "--no-project", "python3", SCRIPT, prompt, "--skip-enhancement"];
			if (size !== undefined) args.push("--size", size);
			args.push("--num", String(num));
			const result = await pi.exec("uv", args, {
				timeout: 50_000 + num * 900_000,
				signal,
			});
			if (result.code !== 0 || result.killed) {
				throw new Error(result.stderr.trim() || "Image generation stopped.");
			}
			let output: { paths?: unknown; compiled_prompt?: unknown };
			try {
				output = JSON.parse(result.stdout);
			} catch {
				throw new Error("Generator did not return a valid result.");
			}
			const paths = output?.paths;
			if (!Array.isArray(paths) || paths.length !== num || !paths.every((p) => typeof p === "string" && path.isAbsolute(p) && existsSync(p))) {
				throw new Error("Generator did not return all image paths.");
			}
			if (!paths.every((p) => path.dirname(p) === path.dirname(paths[0]))) {
				throw new Error("Generator returned images in different directories.");
			}
			if (typeof output.compiled_prompt !== "string" || !output.compiled_prompt.trim()) {
				throw new Error("Generator did not return a compiled prompt.");
			}
			return { paths, compiledPrompt: output.compiled_prompt };
		} finally {
			running = false;
		}
	}

	pi.registerTool({
		name: "generate_image",
		label: "generate image",
		description: "Generate one or more images from the final visual prompt you provide. Write a complete, concrete image description yourself; the tool does not call a prompt-enhancement model. For photos, specify photorealistic, crisp, sharp subject detail without soft-focus blur unless requested; preserve intentional depth of field and motion blur. It compiles the prompt for Kromoss with its unmerged 8-step LoRA on sparkie and returns PNG paths in one unique directory under /tmp/media. The router is shared and unauthenticated: do not submit private briefs or sensitive input.",
		parameters: Params,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			try {
				onUpdate?.({ content: [], details: undefined });
				const output = await generate(params.prompt, (label) => ctx.ui.setWorkingMessage(label), signal, params.size, params.num);
				return {
					content: [{ type: "text", text: `Prompt:\n${output.compiledPrompt}\n\n${formatImages(output.paths)}` }],
					details: { count: output.paths.length },
				};
			} catch (error) {
				return {
					content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
					isError: true,
					details: undefined,
				};
			}
		},
		renderCall(args, theme, context) {
			if (context?.expanded) return renderExpandedCall("generate_image", args, theme);
			return new Text(theme.fg("toolTitle", theme.bold("generate_image")), 0, 0);
		},
		renderResult(result, options, theme, context) {
			if (options.isPartial) return new Text(theme.fg("warning", (context.args?.num ?? 1) > 1 ? "⋯ Generating images" : "⋯ Generating image"), 0, 0);
			const text = result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
			if (options.expanded) return new Text(text, 0, 0);
			if (context.isError) return new Text(theme.fg("error", "✗ image generation failed"), 0, 0);
			const count = (result.details as { count?: number } | undefined)?.count ?? 1;
			return new Text(theme.fg("success", count === 1 ? "✓ Generated image" : `✓ Generated ${count} images`), 0, 0);
		},
	});
}
