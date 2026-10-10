import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import registerRead from "./index.js";

type ReadTool = {
	execute(
		id: string,
		params: { path: string; symbol?: string; offset?: number; limit?: number },
		signal: AbortSignal,
		onUpdate: () => void,
		ctx: { cwd: string },
	): Promise<{ content: Array<{ type: string; text?: string }> }>;
};

function register(): ReadTool {
	let tool: ReadTool | undefined;
	registerRead({ registerTool(value: unknown) { tool = value as ReadTool; } } as never);
	assert.ok(tool);
	return tool;
}

async function read(tool: ReadTool, params: { path: string; symbol?: string; offset?: number; limit?: number }): Promise<string> {
	const result = await tool.execute("test", params, new AbortController().signal, () => undefined, { cwd: process.cwd() });
	assert.equal(result.content[0]?.type, "text");
	return result.content[0]?.text ?? "";
}

test("oversized text is refused before indexing, but bounded UTF-8 batches advance to EOF", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-read-size-"));
	const file = path.join(root, "large.txt");
	try {
		fs.writeFileSync(file, "é".repeat(600_000));
		const tool = register();
		const warning = await read(tool, { path: file });
		assert.match(warning, /very large.*No contents were returned/);
		assert.match(warning, /offset=0 and limit=16384/);
		const first = await read(tool, { path: file, offset: 0, limit: 1 });
		assert.match(first, /bytes 0-1 of 1200000; next offset=2/);
		assert.equal(first.split("\n").slice(1).join("\n"), "é");
		const last = await read(tool, { path: file, offset: 1_199_998, limit: 1 });
		assert.match(last, /next offset=1200000 \(EOF\)/);
		assert.equal(last.split("\n").slice(1).join("\n"), "é");
		const middle = await read(tool, { path: file, offset: 1, limit: 3 });
		assert.match(middle, /bytes 2-3 of 1200000; next offset=4/);
		assert.equal(middle.split("\n").slice(1).join("\n"), "é");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("output cap blocks a giant flat result even when the source is below the file-size threshold", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-read-size-"));
	const file = path.join(root, "flat.txt");
	try {
		fs.writeFileSync(file, "x".repeat(80_000));
		const tool = register();
		assert.match(await read(tool, { path: file }), /would return more than 65536 bytes.*No contents were returned/);
		assert.match(await read(tool, { path: file, offset: 0, limit: 8 }), /next offset=8\nx{8}$/);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("converted section bodies are capped while cached outlines still allow explicit ranges", async () => {
	const url = `https://example.invalid/pi-read-section-${crypto.randomUUID()}`;
	const cache = path.join(os.tmpdir(), "pi-read-doc-cache", `${crypto.createHash("sha256").update(url).digest("hex")}.md`);
	fs.mkdirSync(path.dirname(cache), { recursive: true });
	try {
		fs.writeFileSync(cache, `# Heading\n${"x".repeat(80_000)}\n${"small\n".repeat(101)}`);
		const tool = register();
		assert.match(await read(tool, { path: url }), /outline of/);
		assert.match(await read(tool, { path: url, symbol: "Heading" }), /would return more than 65536 bytes/);
		assert.match(await read(tool, { path: url, offset: 0, limit: 10 }), /next offset=10\n# Heading\n$/);
	} finally {
		fs.rmSync(cache, { force: true });
	}
});

test("cached converted pages refuse huge output and support ranges", async () => {
	const url = `https://example.invalid/pi-read-size-${crypto.randomUUID()}`;
	const cache = path.join(os.tmpdir(), "pi-read-doc-cache", `${crypto.createHash("sha256").update(url).digest("hex")}.md`);
	fs.mkdirSync(path.dirname(cache), { recursive: true });
	try {
		fs.writeFileSync(cache, "# Heading\n" + "a".repeat(1_100_000));
		const tool = register();
		assert.match(await read(tool, { path: url }), /very large.*No contents were returned/);
		assert.match(await read(tool, { path: url, offset: 0, limit: 10 }), /next offset=10\n# Heading\n$/);
	} finally {
		fs.rmSync(cache, { force: true });
	}
});
