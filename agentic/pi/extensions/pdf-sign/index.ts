/** Open a local, model-free PDF editor for handwritten signatures and printed text. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { interactiveQueue } from "../_interactive_queue/queue.ts";
import { launchSigner, resolvePDF, type SigningResult } from "./launcher.ts";

interface SignerDependencies {
	platform: string;
	remote: boolean;
	resolve: typeof resolvePDF;
	launch: (source: string, signal?: AbortSignal) => Promise<SigningResult>;
}

const parameters = Type.Object({ path: Type.String({ minLength: 1, description: "PDF path: absolute, relative to the project, or starting with ~/." }) });

export default function pdfSigning(pi: ExtensionAPI, overrides: Partial<SignerDependencies> = {}) {
	const dependencies: SignerDependencies = {
		platform: process.platform,
		remote: Boolean(process.env.SSH_CONNECTION || process.env.SSH_TTY),
		resolve: resolvePDF,
		launch: launchSigner,
		...overrides,
	};
	const lifecycle = new AbortController();
	pi.on("session_shutdown", () => lifecycle.abort());
	pi.registerTool<typeof parameters, { status: string }>({
		name: "sign_pdf",
		label: "Sign PDF",
		description: "Open a PDF in a local macOS signing editor. The user clicks the page to place signature locations, presses Sign, draws with the whole trackpad, adjusts by dragging, and presses Export to save a flattened copy through a save dialog. To add printed text (name, location, date, or other text), click Add text, click its location on the page, and type; double-click existing text to edit it. Text-only export is supported (default filename: original-signed.pdf). Returns only completion status and saved path, never document contents or signature images. Requires interactive Pi running locally on a Mac; first use builds the native helper with Xcode Command Line Tools.",
		promptSnippet: "Open a local PDF editor for manual trackpad signatures or printed text; document, signature, and text stay on the Mac.",
		promptGuidelines: ["When asked to sign a PDF or add printed text to a PDF, use sign_pdf directly. Do not read, extract, render, or upload its contents or the signature to the model. The user places signatures and text in the local editor."],
		parameters,
		executionMode: "sequential",
		async execute(_id, params, signal, _onUpdate, ctx) {
			try {
				if (dependencies.platform !== "darwin" || dependencies.remote) throw new Error("PDF signing requires Pi running locally on your Mac.");
				if (!ctx.hasUI) throw new Error("PDF signing needs an interactive Pi session on your Mac.");
				const combined = AbortSignal.any([lifecycle.signal, ...(signal ? [signal] : [])]);
				const result = await interactiveQueue.run(async (queuedSignal) => {
					if (queuedSignal.aborted) throw new Error("PDF signing cancelled.");
					const source = await dependencies.resolve(params.path, ctx.cwd);
					if (queuedSignal.aborted) throw new Error("PDF signing cancelled.");
					return dependencies.launch(source, queuedSignal);
				}, combined);
				const message = result.status === "exported" ? `Signed PDF saved: ${result.path}` : "PDF signing cancelled. No copy was exported.";
				return {
					content: [{ type: "text", text: result.returnWarning ? `${message}\n${result.returnWarning}` : message }],
					details: { status: result.status },
				};
			} catch (error) {
				return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : "Could not open the PDF signing editor." }], details: { status: "error" } };
			}
		},
		renderCall(_args, theme) { return new Text(theme.fg("toolTitle", "sign_pdf"), 0, 0); },
		renderResult(result, options, theme, context) {
			const message = result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
			if (options.isPartial) return new Text(theme.fg("warning", "⋯ Editing PDF locally"), 0, 0);
			if (options.expanded || context.isError) return new Text(message, 0, 0);
			return new Text(theme.fg("success", result.details?.status === "exported" ? "✓ Exported signed PDF" : "PDF signing cancelled"), 0, 0);
		},
	});
}
