import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import pdfSigning from "./index.ts";

function setup(options: Parameters<typeof pdfSigning>[1] = {}, hasUI = true) {
	let tool: Parameters<ExtensionAPI["registerTool"]>[0] | undefined;
	const handlers = new Map<string, () => void>();
	const pi = {
		on: (event: string, handler: () => void) => handlers.set(event, handler),
		registerTool: (definition: Parameters<ExtensionAPI["registerTool"]>[0]) => { tool = definition; },
		registerCommand: () => assert.fail("Signing is requested through normal conversation"),
	} as unknown as ExtensionAPI;
	pdfSigning(pi, { platform: "darwin", remote: false, ...options });
	assert.ok(tool);
	const ctx = { hasUI, cwd: "/project" } as ExtensionContext;
	return { tool, ctx, handlers };
}

test("registers a local signing tool with privacy instructions and sequential execution", () => {
	const { tool } = setup();
	assert.equal(tool.name, "sign_pdf");
	assert.equal(tool.executionMode, "sequential");
	assert.match(tool.promptGuidelines!.join(" "), /Do not read, extract, render, or upload/);
	assert.deepEqual(Object.keys((tool.parameters as { properties: object }).properties), ["path"]);
	assert.match(tool.description, /Add text/);
	assert.match(tool.description, /Text-only export is supported/);
	assert.match(tool.promptGuidelines!.join(" "), /add printed text to a PDF/);
});

test("unsupported platforms, SSH, and headless sessions cannot open a window", async () => {
	for (const [options, hasUI] of [[{ platform: "linux" }, true], [{ remote: true }, true], [{}, false]] as const) {
		const { tool, ctx } = setup({ ...options, resolve: async () => assert.fail("Must reject before reading the PDF") }, hasUI);
		const result = await tool.execute("sign", { path: "document.pdf" }, undefined, undefined, ctx);
		assert.equal(result.isError, true);
	}
});

test("passes only the resolved path to the local helper and returns only saved path/status", async () => {
	const { tool, ctx } = setup({
		resolve: async (input, cwd) => { assert.equal(input, "contract.pdf"); assert.equal(cwd, "/project"); return "/private/contract.pdf"; },
		launch: async (source, signal) => {
			assert.equal(source, "/private/contract.pdf");
			assert.equal(signal?.aborted, false);
			return { status: "exported", path: "/private/contract-signed.pdf" };
		},
	});
	const result = await tool.execute("sign", { path: "contract.pdf" }, undefined, undefined, ctx);
	assert.deepEqual(result, { content: [{ type: "text", text: "Signed PDF saved: /private/contract-signed.pdf" }], details: { status: "exported" } });
});

test("closing the editor reports cancellation without a fabricated output", async () => {
	const { tool, ctx } = setup({ resolve: async () => "/a.pdf", launch: async () => ({ status: "cancelled" }) });
	const result = await tool.execute("sign", { path: "a.pdf" }, undefined, undefined, ctx);
	assert.equal(result.isError, undefined);
	assert.deepEqual(result.details, { status: "cancelled" });
	assert.match((result.content[0] as { text: string }).text, /No copy was exported/);
});

test("an already-aborted request never reads or opens a PDF", async () => {
	const { tool, ctx } = setup({ resolve: async () => assert.fail("Cancelled request must not read") });
	const result = await tool.execute("sign", { path: "a.pdf" }, AbortSignal.abort(), undefined, ctx);
	assert.equal(result.isError, true);
});

test("session shutdown cancels the active helper", async () => {
	let started!: () => void;
	const ready = new Promise<void>((resolve) => { started = resolve; });
	const { tool, ctx, handlers } = setup({
		resolve: async () => "/a.pdf",
		launch: async (_source, signal) => new Promise((_resolve, reject) => {
			signal!.addEventListener("abort", () => reject(new Error("PDF signing cancelled.")), { once: true });
			started();
		}),
	});
	const result = tool.execute("sign", { path: "a.pdf" }, undefined, undefined, ctx);
	await ready;
	handlers.get("session_shutdown")!();
	assert.equal((await result).isError, true);
});

test("a focus-return problem preserves successful export and reports the handoff problem", async () => {
	const { tool, ctx } = setup({ resolve: async () => "/a.pdf", launch: async () => ({
		status: "exported", path: "/a-signed.pdf", returnWarning: "Could not switch back to the originating Pi session.",
	}) });
	const result = await tool.execute("sign", { path: "a.pdf" }, undefined, undefined, ctx);
	assert.equal(result.isError, undefined);
	assert.deepEqual(result.details, { status: "exported" });
	assert.deepEqual(result.content, [{ type: "text", text: "Signed PDF saved: /a-signed.pdf\nCould not switch back to the originating Pi session." }]);
});

test("helper errors are reported without pretending that a copy was saved", async () => {
	const { tool, ctx } = setup({ resolve: async () => "/a.pdf", launch: async () => { throw new Error("Could not build Pi PDF Signer."); } });
	const result = await tool.execute("sign", { path: "a.pdf" }, undefined, undefined, ctx);
	assert.equal(result.isError, true);
	assert.deepEqual(result.content, [{ type: "text", text: "Could not build Pi PDF Signer." }]);
});
