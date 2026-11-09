/** Generate an MP4 with native audio through LTX-2.5 on Sparkie's model router. */
import { pathToFileURL } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { renderExpandedCall } from "../_tool-display/expanded-call.ts";
import { generateVideo } from "./video.ts";

const Params = Type.Object({
	prompt: Type.String({ description: "Complete video prompt describing subjects, action over time, camera movement, style, and desired dialogue, ambience or music. With an image, describe how the starting scene should move. Sent directly to LTX-2.5 without prompt enhancement." }),
	image: Type.Optional(Type.String({ description: "Optional starting-frame image: local path or file:/// URL to a JPEG, PNG, or WebP, up to 20 MiB. The image is uploaded with the prompt." })),
	seconds: Type.Optional(Type.Integer({ description: "Requested clip length in seconds (1–10); default 5.", minimum: 1, maximum: 10 })),
	aspect_ratio: Type.Optional(Type.Union([Type.Literal("16:9"), Type.Literal("9:16"), Type.Literal("1:1")], { description: "Default 16:9 (1024x576). Portrait 9:16 uses 576x1024; square 1:1 uses 768x768." })),
	steps: Type.Optional(Type.Integer({ description: "Denoising steps (1–16); default 8 for this distilled checkpoint. More steps do not automatically improve quality.", minimum: 1, maximum: 16 })),
	seed: Type.Optional(Type.Integer({ description: "Optional reproducible random seed; omitted for a fresh random seed.", minimum: 0, maximum: 4294967295 })),
});

export default function (pi: ExtensionAPI) {
	let running = false;
	pi.registerTool({
		name: "generate_video",
		label: "generate video",
		description: "Generate one video with native stereo audio using ChrisColeTech/LTX-2.5-uncensored-v1.1-FP8 on Sparkie's native LTX model server. Provide a complete prompt and optionally a local starting-frame image; no prompt-enhancement model is called. Returns a local MP4 file URL in a unique directory under /tmp/media. Default: 5 seconds, 16:9, 24 fps, 8 steps. Polls for up to one hour and cancels the remote job on abort or timeout. The router is shared and unauthenticated: do not submit private images, briefs or sensitive input.",
		parameters: Params,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			if (running) return { content: [{ type: "text", text: "A video is already being generated." }], isError: true, details: undefined };
			running = true;
			try {
				onUpdate?.({ content: [], details: undefined });
				const output = await generateVideo(params, { signal, onProgress: (label) => ctx.ui.setWorkingMessage(label) });
				return {
					content: [{ type: "text", text: `Prompt:\n${params.prompt}\n\nVideo: ${pathToFileURL(output.path).href}\nJob: ${output.jobId}` }],
					details: output,
				};
			} catch (error) {
				return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true, details: undefined };
			} finally {
				running = false;
			}
		},
		renderCall(args, theme, context) {
			if (context?.expanded) return renderExpandedCall("generate_video", args, theme);
			return new Text(theme.fg("toolTitle", theme.bold("generate_video")), 0, 0);
		},
		renderResult(result, options, theme, context) {
			if (options.isPartial) return new Text(theme.fg("warning", "⋯ Generating video"), 0, 0);
			const text = result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
			if (options.expanded) return new Text(text, 0, 0);
			return new Text(context.isError ? theme.fg("error", "✗ video generation failed") : theme.fg("success", "✓ Generated video"), 0, 0);
		},
	});
}
