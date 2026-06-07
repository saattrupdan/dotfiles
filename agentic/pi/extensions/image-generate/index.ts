/**
 * `image_generate` tool extension.
 *
 * Provides an image generation tool that creates images from text prompts.
 * Supports multiple backends (local models, cloud APIs) and returns generated
 * images as file paths or base64 data.
 *
 * This extension is loaded from the `.pi/agent/extensions/image-generate/` directory
 * and registered via the standard pi extension API.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const Params = Type.Object({
	prompt: Type.String({
		description: "Text description of the image to generate.",
	}),
	model: Type.Optional(
		Type.String({
			description:
				"Model to use for generation (e.g., 'dall-e-3', 'stable-diffusion-xl'). Default: configured default.",
		}),
	),
	size: Type.Optional(
		Type.String({
			description:
				"Image size (e.g., '1024x1024', '512x512'). Default: '1024x1024'.",
			enum: [
				"256x256",
				"512x512",
				"768x768",
				"1024x1024",
				"1024x768",
				"768x1024",
				"1280x720",
				"1920x1080",
			],
			default: "1024x1024",
		}),
	),
	output_path: Type.Optional(
		Type.String({
			description:
				"Output file path (relative to cwd or absolute). If not provided, generates a temporary filename.",
		}),
	),
	negative_prompt: Type.Optional(
		Type.String({
			description:
				"Negative prompt describing what to avoid in the generated image.",
		}),
	),
	steps: Type.Optional(
		Type.Integer({
			description: "Number of inference steps (for diffusion models). Default: 30.",
			minimum: 1,
			maximum: 150,
			default: 30,
		}),
	),
	guidance_scale: Type.Optional(
		Type.Number({
			description:
				"Guidance scale / CFG scale (higher = more prompt adherence). Default: 7.5.",
			minimum: 1,
			maximum: 20,
			default: 7.5,
		}),
	),
	seed: Type.Optional(
		Type.Integer({
			description:
				"Random seed for reproducibility. If not provided, uses a random seed.",
		}),
	),
});

function registerImageGenerateTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "image_generate",
		label: "image_generate",
		description:
			"Generate an image from a text prompt. Returns the path to the generated image file or base64-encoded image data.",
		parameters: Params,

		async execute(
			_toolCallId,
			{
				prompt,
				model,
				size = "1024x1024",
				output_path,
				negative_prompt,
				steps = 30,
				guidance_scale = 7.5,
				seed,
			},
			_signal,
			_onUpdate,
			_ctx,
		) {
			// TODO: Implement image generation logic based on the configured backend.
			// Possible implementations:
			// - OpenAI DALL-E 3 API
			// - Stability AI Stable Diffusion API
			// - Local diffusion models (e.g., via llama.cpp or diffusers)
			// - Replicate API for various models

			const [width, height] = size.split("x").map(Number);

			return {
				content: [
					{
						type: "text",
						text: `Image generation not yet implemented.
Configuration:
- Prompt: ${prompt}
- Model: ${model || "(default)"}
- Size: ${width}x${height}
- Output: ${output_path || "(temporary)"}
- Negative prompt: ${negative_prompt || "(none)"}
- Steps: ${steps}
- Guidance scale: ${guidance_scale}
- Seed: ${seed !== undefined ? seed : "(random)"}

Implement the generateImage() function in index.ts to add backend support.`,
					},
				],
				details: {
					prompt,
					model: model || null,
					size,
					outputPath: output_path || null,
				},
			};
		},

		renderCall(args, theme) {
			const prompt = args?.prompt ? String(args.prompt) : "...";
			const truncatedPrompt =
				prompt.length > 50 ? prompt.slice(0, 47) + "..." : prompt;
			return new Text(
				`${theme.fg("toolTitle", theme.bold("image_generate"))} ${theme.fg("accent", `"${truncatedPrompt}"`)}`,
				0,
				0,
			);
		},

		renderResult(result, { expanded }, theme, _context) {
			const text = textContent(result.content);
			if (expanded) return new Text(text, 0, 0);

			const details = result.details as
				| { outputPath?: string | null; prompt?: string }
				| undefined;

			if (details?.outputPath) {
				return new Text(
					theme.fg("success", `✓ generated: ${details.outputPath}`),
					0,
					0,
				);
			}

			return new Text(firstLine(text), 0, 0);
		},
	});
}

function textContent(content: Array<{ type: string; text?: string }>): string {
	return content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function firstLine(text: string): string {
	return text.split("\n")[0] || "(no output)";
}

// Extension entry point
export default function (pi: ExtensionAPI): void {
	registerImageGenerateTool(pi);
}
