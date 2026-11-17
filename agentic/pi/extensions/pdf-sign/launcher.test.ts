import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parseSigningResult, resolvePDF, runHelper } from "./launcher.ts";

test("resolves paths with spaces without shell interpretation and checks the local PDF header", async () => {
	const folder = await mkdtemp(path.join(os.tmpdir(), "pi-sign-path-"));
	try {
		const name = "Aftale $(not-a-command).PDF";
		await writeFile(path.join(folder, name), "%PDF-1.7\nlocal contents");
		assert.equal(await resolvePDF(name, folder), path.join(folder, name));
		await writeFile(path.join(folder, "fake.pdf"), "not a PDF");
		await assert.rejects(resolvePDF("fake.pdf", folder), /not a PDF/);
		await mkdir(path.join(folder, "directory.pdf"));
		await assert.rejects(resolvePDF("directory.pdf", folder), /not a directory/);
		await assert.rejects(resolvePDF("", folder), /Specify/);
		await assert.rejects(resolvePDF("text.txt", folder), /Choose a PDF/);
	} finally { await rm(folder, { recursive: true, force: true }); }
});

test("result parsing strips all fields other than status/path, including document contents", () => {
	assert.deepEqual(parseSigningResult('{"status":"exported","path":"/tmp/a-signed.pdf","text":"PRIVATE","signature":"PRIVATE"}'), { status: "exported", path: "/tmp/a-signed.pdf" });
	assert.deepEqual(parseSigningResult('{"status":"cancelled","text":"PRIVATE"}'), { status: "cancelled" });
	for (const value of ["bad PRIVATE", "null", '{"status":"exported","path":"relative.pdf"}', '{"status":"error","message":"PRIVATE"}']) {
		assert.throws(() => parseSigningResult(value), (error: Error) => !error.message.includes("PRIVATE"));
	}
});

test("native-helper seam uses literal arguments and discards stderr", async () => {
	const folder = await mkdtemp(path.join(os.tmpdir(), "pi-sign-helper-"));
	try {
		const helper = path.join(folder, "fake helper");
		await writeFile(helper, '#!/usr/bin/env node\nif (process.argv[2] !== "--input" || process.argv[3] !== "/tmp/name $(literal).pdf") process.exit(1);\nconsole.error("PRIVATE");\nconsole.log(JSON.stringify({status:"cancelled"}));\n', { mode: 0o700 });
		assert.deepEqual(await runHelper(helper, "/tmp/name $(literal).pdf"), { status: "cancelled" });
	} finally { await rm(folder, { recursive: true, force: true }); }
});

test("aborting a native editor waits for termination and rejects rather than reporting success", async () => {
	const folder = await mkdtemp(path.join(os.tmpdir(), "pi-sign-abort-"));
	try {
		const helper = path.join(folder, "fake helper");
		await writeFile(helper, '#!/usr/bin/env node\nsetInterval(() => {}, 1000);\n', { mode: 0o700 });
		const controller = new AbortController();
		const running = runHelper(helper, "/tmp/a.pdf", controller.signal);
		controller.abort();
		await assert.rejects(running, /cancelled/);
		await assert.rejects(runHelper(helper, "/tmp/a.pdf", AbortSignal.abort()), /cancelled/);
	} finally { await rm(folder, { recursive: true, force: true }); }
});

test("activates the existing app exactly once, only after the native window reports ready", async () => {
	const folder = await mkdtemp(path.join(os.tmpdir(), "pi-sign-ready-"));
	try {
		const app = path.join(folder, "Pi PDF Signer.app");
		const helper = path.join(app, "Contents", "MacOS", "PDFSigner");
		await mkdir(path.dirname(helper), { recursive: true });
		await writeFile(helper, '#!/usr/bin/env node\nconst fs = require("node:fs");\nif (process.argv[4] !== "--notify-ready") process.exit(1);\nfs.writeSync(3, "rea");\nsetTimeout(() => { fs.writeSync(3, "dy\\nready\\n"); console.log(JSON.stringify({status:"cancelled"})); }, 40);\n', { mode: 0o700 });
		const calls: string[] = [];
		assert.deepEqual(await runHelper(helper, "/tmp/a.pdf", undefined, { activate: async (application) => { calls.push(application); } }), { status: "cancelled" });
		assert.deepEqual(calls, [app]);
	} finally { await rm(folder, { recursive: true, force: true }); }
});

test("failed foreground activation terminates the helper and reports a visible-window error", async () => {
	const folder = await mkdtemp(path.join(os.tmpdir(), "pi-sign-activation-"));
	try {
		const helper = path.join(folder, "helper");
		await writeFile(helper, '#!/usr/bin/env node\nrequire("node:fs").writeSync(3, "ready\\n"); setInterval(() => {}, 1000);\n', { mode: 0o700 });
		await assert.rejects(runHelper(helper, "/tmp/a.pdf", undefined, { activate: async () => { throw new Error("PRIVATE"); } }), /could not bring.*forward/);
	} finally { await rm(folder, { recursive: true, force: true }); }
});

test("returns focus after helper exit without turning a successful export into a failure", async () => {
	const folder = await mkdtemp(path.join(os.tmpdir(), "pi-sign-return-"));
	try {
		const helper = path.join(folder, "helper");
		await writeFile(helper, '#!/usr/bin/env node\nconsole.log(JSON.stringify({status:"exported",path:"/tmp/a-signed.pdf"}));\n', { mode: 0o700 });
		let restored = 0;
		assert.deepEqual(await runHelper(helper, "/tmp/a.pdf", undefined, { restore: async () => { restored++; } }), { status: "exported", path: "/tmp/a-signed.pdf" });
		assert.equal(restored, 1);
		const result = await runHelper(helper, "/tmp/a.pdf", undefined, { restore: async () => { throw new Error("PRIVATE"); } });
		assert.equal(result.status, "exported");
		assert.equal(result.returnWarning, "Could not switch back to the originating Pi session.");
		assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
	} finally { await rm(folder, { recursive: true, force: true }); }
});

test("completed exports survive a cancellation while focus restoration is pending", async () => {
	const folder = await mkdtemp(path.join(os.tmpdir(), "pi-sign-late-abort-"));
	try {
		const helper = path.join(folder, "helper");
		await writeFile(helper, '#!/usr/bin/env node\nconsole.log(JSON.stringify({status:"exported",path:"/tmp/a-signed.pdf"}));\n', { mode: 0o700 });
		let restoring!: () => void;
		let finishRestore!: () => void;
		const started = new Promise<void>((resolve) => { restoring = resolve; });
		const pending = new Promise<void>((resolve) => { finishRestore = resolve; });
		const controller = new AbortController();
		const task = runHelper(helper, "/tmp/a.pdf", controller.signal, { restore: async () => { restoring(); await pending; } });
		await started;
		controller.abort();
		finishRestore();
		assert.deepEqual(await task, { status: "exported", path: "/tmp/a-signed.pdf" });
	} finally { await rm(folder, { recursive: true, force: true }); }
});

test("native failures and malformed output never expose helper output", async () => {
	const folder = await mkdtemp(path.join(os.tmpdir(), "pi-sign-private-"));
	try {
		for (const body of ['console.log("PRIVATE"); process.exit(1);', 'console.log("PRIVATE");', 'console.log("x".repeat(20000)); setInterval(() => {}, 1000);']) {
			const helper = path.join(folder, "helper");
			await writeFile(helper, `#!/usr/bin/env node\n${body}\n`, { mode: 0o700 });
			await assert.rejects(runHelper(helper, "/tmp/a.pdf"), (error: Error) => !error.message.includes("PRIVATE"));
		}
	} finally { await rm(folder, { recursive: true, force: true }); }
});
