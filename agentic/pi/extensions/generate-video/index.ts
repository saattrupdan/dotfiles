import { generateVideoRenderers } from "../_tool-display/renderers.ts";
/** Generate an MP4 with native audio through MiniMax-H3 and its LoRA on Sparkie. */
import { pathToFileURL } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { Type } from "typebox";

import { generateVideo } from "./video.ts";

const Params = Type.Object({
	prompt: Type.String({ description: "Complete video prompt describing subjects, action over time, camera movement, style, and desired dialogue, ambience or music. With an image, describe how the starting scene should move. Sent directly to MiniMax-H3 with the installed LoRA, without prompt enhancement." }),
	image: Type.Optional(Type.String({ description: "Optional starting-frame image: local path or file:/// URL to a JPEG, PNG, or WebP, up to 20 MiB. The image is uploaded with the prompt." })),
	seconds: Type.Integer({ description: "Required clip length in seconds (4–15). No default: estimate the time needed for the prompt's action and dialogue and set it explicitly. H3 rounds to its native frame grid.", minimum: 4, maximum: 15 }),
	aspect_ratio: Type.Optional(Type.Union([Type.Literal("16:9"), Type.Literal("9:16"), Type.Literal("1:1")], { description: "Default 16:9 (960x544). Portrait 9:16 uses 544x960; square 1:1 uses 544x544." })),
	steps: Type.Optional(Type.Integer({ description: "Denoising steps (1–200); default 50.", minimum: 1, maximum: 200 })),
	seed: Type.Optional(Type.Integer({ description: "Optional reproducible random seed; omitted for a fresh random seed.", minimum: 0, maximum: 4294967295 })),
});

export default function (pi: ExtensionAPI) {
	let running = false;
	pi.registerTool({
		name: "generate_video",
		label: "generate video",
		description: "Generate one video with native audio using MiniMaxAI/MiniMax-H3 with the installed model_download LoRA on Sparkie. Provide a complete prompt, an explicit duration estimated from its action and dialogue, and optionally a local starting-frame image; no prompt-enhancement model is called. Duration is required (4–15 seconds), with no default. Defaults: 16:9, 24 fps, 50 steps. Returns a local MP4 file URL in a unique directory under /tmp/media. Starts MiniMax-H3 on demand and stops it after use when no other jobs are active. Polls for up to one hour and cancels the remote job on abort or timeout. The router is shared and unauthenticated: do not submit private images, briefs or sensitive input.",
		parameters: Params,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			if (running) return { content: [{ type: "text", text: "A video is already being generated." }], isError: true, details: undefined };
			running = true;
			try {
				onUpdate?.({ content: [], details: undefined });
				const output = await generateVideo(params, { signal, onProgress: (label) => ctx.ui.setWorkingMessage(label) });
				return {
					content: [{ type: "text", text: `Prompt:\n${params.prompt}\n\nVideo: ${pathToFileURL(output.path).href}\nJob: ${output.jobId}${output.warnings.length ? `\n${output.warnings.join("\n")}` : ""}` }],
					details: output,
				};
			} catch (error) {
				return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true, details: undefined };
			} finally {
				running = false;
			}
		},
		...generateVideoRenderers,

	});
}
