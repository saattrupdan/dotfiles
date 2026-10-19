/** Generate images through a direct tool or /generate-image, using one shared pipeline. */
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
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
const MAX_PROMPT_FILE_BYTES = 64 * 1024;
const MAX_IMAGES = 10;

function formatImages(paths: string[]): string {
	return paths.length === 1 ? `Image: ${paths[0]}` : `Images:\n${paths.join("\n")}`;
}

function loadPrompt(input: string, cwd: string): string {
	const explicit = input.startsWith("@");
	const rawPath = explicit ? input.slice(1) : input;
	if (explicit && !rawPath) throw new Error("Prompt file path is empty.");
	const quoted = /^(["'])([\s\S]*)\1$/.exec(rawPath);
	const filePath = quoted ? quoted[2] : rawPath;
	const resolved = filePath.startsWith("~/")
		? path.join(os.homedir(), filePath.slice(2))
		: path.resolve(cwd, filePath);
	if (!explicit && !existsSync(resolved)) return input;
	const info = statSync(resolved);
	if (!info.isFile()) throw new Error("Prompt path is not a file.");
	if (info.size > MAX_PROMPT_FILE_BYTES) throw new Error("Prompt file exceeds 64 KB.");
	const prompt = readFileSync(resolved, "utf8").trim();
	if (!prompt) throw new Error("Prompt file is empty.");
	return prompt;
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
		enhance = true, num = 1,
	): Promise<{ paths: string[]; compiledPrompt: string }> {
		if (!prompt.trim()) throw new Error("Image prompt must not be empty.");
		if (!Number.isSafeInteger(num) || num < 1 || num > MAX_IMAGES) throw new Error("num must be between 1 and 10.");
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
			args.push("--num", String(num));
			const result = await pi.exec("uv", args, {
				timeout: 50_000 + (enhance ? 600_000 : 0) + num * 900_000,
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
			clearInterval(poll);
			rmSync(progressDir, { recursive: true, force: true });
			running = false;
		}
	}

	pi.registerTool({
		name: "generate_image",
		label: "generate image",
		description: "Generate one or more images from the final visual prompt you provide. Write a complete, concrete image description yourself; the tool does not call a prompt-enhancement model. For photos, specify photorealistic, crisp, sharp subject detail without soft-focus blur unless requested; preserve intentional depth of field and motion blur. It compiles the prompt for Kromoss with its unmerged 8-step LoRA on sparkie and returns PNG paths in one /tmp directory. The router is shared and unauthenticated: do not submit private briefs or sensitive input.",
		parameters: Params,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			try {
				onUpdate?.({ content: [], details: undefined });
				const output = await generate(params.prompt, (label) => ctx.ui.setWorkingMessage(label), signal, params.size, false, params.num);
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
		renderCall(_args, theme) {
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

	pi.registerCommand("generate-image", {
		description: "Generate with Kromoss on sparkie: /generate-image [--no-enhance] [--num N] [--size WIDTHxHEIGHT] <prompt|@file|file>",
		async handler(args, ctx) {
			let source = args.trim();
			let enhance = true;
			let num = 1;
			let countSet = false;
			let size: string | undefined;
			while (source.startsWith("--")) {
				if (/^--no-enhance(?:\s|$)/.test(source)) {
					if (!enhance) {
						ctx.ui.notify("--no-enhance was specified twice.", "error");
						return;
					}
					enhance = false;
					source = source.slice("--no-enhance".length).trimStart();
					continue;
				}
				if (/^--num(?:\s|$)/.test(source)) {
					const match = /^--num\s+(\S+)(?:\s|$)/.exec(source);
					if (countSet || !match || !/^\d+$/.test(match[1]) || Number(match[1]) < 1 || Number(match[1]) > MAX_IMAGES) {
						ctx.ui.notify("--num must be an integer from 1 to 10, specified once.", "error");
						return;
					}
					num = Number(match[1]);
					countSet = true;
					source = source.slice(match[0].length).trimStart();
					continue;
				}
				if (/^--size(?:\s|$)/.test(source)) {
					const match = /^--size\s+(\S+)(?:\s|$)/.exec(source);
					const dimensions = match && /^(\d+)x(\d+)$/.exec(match[1]);
					const width = dimensions ? Number(dimensions[1]) : 0;
					const height = dimensions ? Number(dimensions[2]) : 0;
					if (size !== undefined || !match || !dimensions || width < 512 || width > 1024 || height < 512 || height > 1024 || width % 16 !== 0 || height % 16 !== 0 || width * height > 1024 * 1024) {
						ctx.ui.notify("--size must be WIDTHxHEIGHT (512–1024 per side, multiples of 16, at most 1 megapixel), specified once.", "error");
						return;
					}
					size = match[1];
					source = source.slice(match[0].length).trimStart();
					continue;
				}
				break;
			}
			if (!source) {
				ctx.ui.notify("Usage: /generate-image [--no-enhance] [--num N] [--size WIDTHxHEIGHT] <prompt|@file|file>", "error");
				return;
			}
			if (running) {
				ctx.ui.notify("An image is already being generated.", "error");
				return;
			}
			let prompt: string;
			try {
				prompt = loadPrompt(source, ctx.cwd);
			} catch (error) {
				ctx.ui.notify(`Unable to read prompt file: ${error instanceof Error ? error.message : String(error)}`, "error");
				return;
			}
			let loader: Loader | undefined;
			if (ctx.mode === "tui") {
				ctx.ui.setWidget("generate-image:progress", (tui, theme) => {
					loader = new CommandStatusLoader(tui, (text) => theme.fg("accent", text), (text) => theme.fg("muted", text), enhance ? "Enhancing image-generation prompt..." : "Generating image...");
					return Object.assign(loader, { dispose: () => loader?.stop() });
				}, { placement: "aboveEditor" });
			}
			try {
				const output = await generate(prompt, (label) => loader?.setMessage(label), ctx.signal, size, enhance, num);
				pi.sendMessage({
					customType: "generate-image:result",
					content: enhance
						? `Original prompt:\n${prompt}\n\nEnhanced prompt:\n${output.compiledPrompt}\n\n${formatImages(output.paths)}`
						: `Prompt:\n${output.compiledPrompt}\n\n${formatImages(output.paths)}`,
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
