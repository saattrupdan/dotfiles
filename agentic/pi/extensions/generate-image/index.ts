/** Generate images through a direct tool or /generate-image, using one shared pipeline. */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Loader, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

class CommandStatusLoader extends Loader {
	override render(width: number): string[] {
		return [...super.render(width).slice(1), ""];
	}
}

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "scripts", "enhance_and_generate.py");
const Params = Type.Object({
	prompt: Type.String({ description: "Final, detailed visual prompt for Kromoss. Describe the intended image directly, including subjects, composition, style and exact visible text. This prompt is sent without local LLM enhancement." }),
	size: Type.Optional(Type.String({ description: "WIDTHxHEIGHT; default 1024x1024. Each side 512–1024 pixels, multiples of 16, at most 1 megapixel." })),
	seed: Type.Optional(Type.Integer({ description: "Sampling seed; default 42.", minimum: 0, maximum: 2 ** 32 - 1 })),
});

export default function (pi: ExtensionAPI) {
	let running = false;

	async function generate(
		prompt: string, onPhase: (label: string) => void, signal?: AbortSignal, size?: string, seed?: number,
		enhance = true,
	): Promise<{ path: string; compiledPrompt: string }> {
		if (!prompt.trim()) throw new Error("Image prompt must not be empty.");
		if (running) throw new Error("An image is already being generated.");
		const progressDir = mkdtempSync(path.join(os.tmpdir(), "pi-image-progress-"));
		running = true;
		const phaseFile = path.join(progressDir, "phase");
		const poll = enhance ? setInterval(() => {
			try {
				if (readFileSync(phaseFile, "utf-8") === "generating") {
					onPhase("Generating image...");
					clearInterval(poll);
				}
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") clearInterval(poll);
			}
		}, 200) : undefined;
		try {
			onPhase(enhance ? "Enhancing image-generation prompt..." : "Generating image...");
			const args = ["run", "--no-project", "python3", SCRIPT, prompt];
			if (enhance) args.push("--phase-file", phaseFile);
			else args.push("--skip-enhancement");
			if (size !== undefined) args.push("--size", size);
			if (seed !== undefined) args.push("--seed", String(seed));
			const result = await pi.exec("uv", args, { timeout: 1_550_000, signal });
			if (result.code !== 0 || result.killed) {
				throw new Error(result.stderr.trim() || "Image generation stopped.");
			}
			let output: { path?: unknown; compiled_prompt?: unknown };
			try {
				output = JSON.parse(result.stdout);
			} catch {
				throw new Error("Generator did not return a valid result.");
			}
			if (!output || typeof output.path !== "string" || !path.isAbsolute(output.path) || !existsSync(output.path)) {
				throw new Error("Generator did not return an existing image path.");
			}
			if (typeof output.compiled_prompt !== "string" || !output.compiled_prompt.trim()) {
				throw new Error("Generator did not return a compiled prompt.");
			}
			return { path: output.path, compiledPrompt: output.compiled_prompt };
		} finally {
			clearInterval(poll);
			rmSync(progressDir, { recursive: true, force: true });
			running = false;
		}
	}

	pi.registerTool({
		name: "generate_image",
		label: "generate image",
		description: "Generate one image from the final visual prompt you provide. Write a complete, concrete image description yourself; the tool does not call a prompt-enhancement model. It compiles the prompt for Kromoss with its unmerged 8-step LoRA on sparkie and returns a PNG in /tmp. The router is shared and unauthenticated: do not submit private briefs or sensitive input.",
		parameters: Params,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			try {
				onUpdate?.({ content: [{ type: "text", text: "Generating image..." }], details: undefined });
				const output = await generate(params.prompt, (label) => ctx.ui.setWorkingMessage(label), signal, params.size, params.seed, false);
				return {
					content: [{ type: "text", text: `Prompt:\n${output.compiledPrompt}\n\nImage: ${output.path}` }],
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
		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("generate_image")), 0, 0);
		},
		renderResult(result, options, theme, context) {
			if (options.isPartial) return new Text(theme.fg("muted", "… Generating image"), 0, 0);
			const text = result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
			if (options.expanded) return new Text(text, 0, 0);
			if (context.isError) return new Text(theme.fg("error", `✗ ${text}`), 0, 0);
			return new Text(theme.fg("success", "✓ Generated image"), 0, 0);
		},
	});

	pi.registerCommand("generate-image", {
		description: "Enhance a brief locally and generate with Kromoss on sparkie: /generate-image <prompt>",
		async handler(args, ctx) {
			const prompt = args.trim();
			if (!prompt) {
				ctx.ui.notify("Usage: /generate-image <prompt>", "error");
				return;
			}
			if (running) {
				ctx.ui.notify("An image is already being generated.", "error");
				return;
			}
			let loader: Loader | undefined;
			if (ctx.mode === "tui") {
				ctx.ui.setWidget("generate-image:progress", (tui, theme) => {
					loader = new CommandStatusLoader(tui, (text) => theme.fg("accent", text), (text) => theme.fg("muted", text), "Enhancing image-generation prompt...");
					return Object.assign(loader, { dispose: () => loader?.stop() });
				}, { placement: "aboveEditor" });
			}
			try {
				const output = await generate(prompt, (label) => loader?.setMessage(label), ctx.signal);
				pi.sendMessage({
					customType: "generate-image:result",
					content: `Original prompt:\n${prompt}\n\nEnhanced prompt:\n${output.compiledPrompt}\n\nImage: ${output.path}`,
					display: true,
				});
			} catch (error) {
				pi.sendMessage({
					customType: "generate-image:error",
					content: error instanceof Error ? error.message : String(error),
					display: true,
				});
			} finally {
				if (ctx.mode === "tui") ctx.ui.setWidget("generate-image:progress", undefined);
			}
		},
	});
}
