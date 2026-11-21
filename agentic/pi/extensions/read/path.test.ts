import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import registerRead from "./index.js";

type ReadTool = {
	execute(
		id: string,
		params: { path: string; offset?: number; limit?: number },
		signal: AbortSignal,
		onUpdate: () => void,
		ctx: { cwd: string },
	): Promise<{ content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> }>;
};

function register(): ReadTool {
	let tool: ReadTool | undefined;
	registerRead({ registerTool(value: unknown) { tool = value as ReadTool; } } as never);
	assert.ok(tool);
	return tool;
}

async function read(tool: ReadTool, source: string, limit?: number) {
	return tool.execute("test", { path: source, limit }, new AbortController().signal, () => undefined, { cwd: process.cwd() });
}

test("registered read expands ~/ before checking and reading an image with spaces", async () => {
	const root = fs.mkdtempSync(path.join(os.homedir(), ".pi-read-path-"));
	try {
		const source = path.join(root, "Screenshot 2026-11-21 at 13.12.03.png");
		fs.writeFileSync(source, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==", "base64"));
		const result = await read(register(), `~/${path.relative(os.homedir(), source)}`);
		assert.equal(result.content[0]?.text, "Read image file [image/png]");
		assert.equal(result.content[1]?.type, "image");
		assert.equal(result.content[1]?.mimeType, "image/png");
		assert.ok(result.content[1]?.data);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("home paths work for directories and text ranges without changing ordinary paths", async () => {
	const root = fs.mkdtempSync(path.join(os.homedir(), ".pi-read-path-"));
	try {
		const source = path.join(root, "note.txt");
		fs.writeFileSync(source, "hello");
		const tool = register();
		const homeRelative = `~/${path.relative(os.homedir(), root)}`;
		assert.match((await read(tool, homeRelative)).content[0]?.text ?? "", /note\.txt/);
		for (const name of [`${homeRelative}/note.txt`, source, path.relative(process.cwd(), source)]) {
			assert.match((await read(tool, name, 5)).content[0]?.text ?? "", /\nhello$/);
		}
		assert.ok((await read(tool, "~")).content[0]?.text?.startsWith(`# directory ${os.homedir()} (`));
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("tildes outside the home prefix stay literal", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-read-path-"));
	try {
		for (const name of ["~someone", "~"]) {
			const source = path.join(root, name, "note.txt");
			fs.mkdirSync(path.dirname(source), { recursive: true });
			fs.writeFileSync(source, "literal");
			assert.match((await read(register(), source, 7)).content[0]?.text ?? "", /\nliteral$/);
		}
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
