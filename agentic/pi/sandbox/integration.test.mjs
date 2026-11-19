import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { resolvePiPackage } from "../profile/launcher.mjs";
import { createHostModel, startBroker } from "./broker.mjs";
import { containerArguments, CONTAINER, sandboxImage, stageSandboxResources } from "./runtime.mjs";

const enabled = process.env.PI_SANDBOX_INTEGRATION === "1";
const model = { id: "sandbox-test", name: "Sandbox test", provider: "sandbox-test", api: "sandbox-inference", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 4096 };
function response(content, stopReason = "stop") {
	return { role: "assistant", content, api: model.api, provider: model.provider, model: model.id, stopReason, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: Date.now() };
}
async function fixture(run) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sandbox-live-"));
	const pkg = resolvePiPackage();
	const agentDir = process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi/agent");
	for (const name of ["project", "resources", "mailbox", "sessions", "cache"]) fs.mkdirSync(path.join(root, name));
	const project = path.join(root, "project"), resources = path.join(root, "resources");
	execFileSync("git", ["init", "-q", project]);
	await stageSandboxResources(agentDir, pkg, resources);
	const name = `pi-test-${randomUUID()}`;
	try { await run({ root, pkg, agentDir, project, resources, name,
		args: (extra = []) => containerArguments({ name, image: sandboxImage(pkg).tag, root: project, cwd: project, resources, mailbox: path.join(root, "mailbox"), sessions: path.join(root, "sessions"), cache: path.join(root, "cache"), uid: process.getuid(), gid: process.getgid(), tty: false, args: ["--no-session", "-p", ...extra] }) });
	} finally {
		try { execFileSync(CONTAINER, ["stop", name], { stdio: "pipe", timeout: 10000 }); } catch {}
		fs.rmSync(root, { recursive: true, force: true });
	}
}
async function execute(args, input) {
	const started = Date.now();
	return new Promise((resolve, reject) => {
		const child = spawn(CONTAINER, args, { stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
		if (input !== undefined) child.stdin.end(input);
		let stdout = "", stderr = "";
		child.stdout.on("data", (data) => { stdout += data; });
		child.stderr.on("data", (data) => { stderr += data; });
		const timeout = setTimeout(() => child.kill("SIGTERM"), 90000);
		child.on("error", reject);
		child.on("close", (code) => { clearTimeout(timeout); resolve({ code, stdout, stderr, milliseconds: Date.now() - started }); });
	});
}

test("real Apple guest drops privilege, blocks host/internet networking, and permits guest loopback", { skip: !enabled, timeout: 120000 }, async (t) => {
	await fixture(async ({ root, pkg, project, resources, args }) => {
		fs.writeFileSync(path.join(root, "outside-secret"), "not-mounted");
		fs.symlinkSync(path.join(root, "outside-secret"), path.join(project, "outside-link"));
		fs.writeFileSync(path.join(resources, "probe.mjs"), `
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
const status = fs.readFileSync('/proc/self/status', 'utf8');
assert.notEqual(process.getuid(), 0);
for (const key of ['CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb']) assert.match(status, new RegExp(key + ':\\\\s+0+'));
assert.match(status, /NoNewPrivs:\\s+1/);
assert.deepEqual(Object.keys(os.networkInterfaces()), ['lo']);
assert.throws(() => execFileSync('unshare', ['--net', 'true'], {stdio:'pipe'}));
assert.throws(() => execFileSync('nsenter', ['-t', '1', '-n', 'true'], {stdio:'pipe'}));
assert.throws(() => execFileSync('setpriv', ['--reuid=0', 'true'], {stdio:'pipe'}));
assert.throws(() => fs.writeFileSync('/opt/pi-config/settings.json', '{}'));
assert.throws(() => fs.readFileSync('/workspace/outside-link'));
assert.equal(fs.existsSync('/opt/pi-config/auth.json'), false);
assert.equal(fs.existsSync('/var/run/docker.sock'), false);
for (const host of ['1.1.1.1', '192.168.64.1', '2606:4700:4700::1111']) {
  await new Promise((resolve, reject) => {
    const socket = net.connect({host, port:80});
    socket.setTimeout(1000, () => {socket.destroy(); reject(new Error('Network attempt timed out instead of failing closed'));});
    socket.on('connect', () => {socket.destroy(); reject(new Error('Unexpected external connection'));});
    socket.on('error', resolve);
  });
}
const server = http.createServer((_req, res) => res.end('local'));
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
assert.equal(await (await fetch('http://127.0.0.1:' + server.address().port)).text(), 'local');
await new Promise(resolve => server.close(resolve));
fs.writeFileSync('/workspace/proof', 'guest-write');
console.log('ISOLATION_OK');
`);
		const command = args(); const index = command.indexOf(sandboxImage(pkg).tag);
		command.splice(index + 1, command.length, "node", "/opt/pi-config/probe.mjs");
		const result = await execute(command);
		assert.equal(result.code, 0, result.stderr + result.stdout);
		assert.match(result.stdout, /ISOLATION_OK/);
		assert.equal(fs.readFileSync(path.join(project, "proof"), "utf8"), "guest-write");
		t.diagnostic(`Cached-image isolated process start and probe: ${result.milliseconds}ms`);
	});
});

test("real sandbox profile loads Linux extensions, executes tools, and completes brokered turns", { skip: !enabled, timeout: 120000 }, async (t) => {
	await fixture(async ({ root, project, args }) => {
		let turns = 0;
		const broker = startBroker(path.join(root, "mailbox"), { model, async *stream() {
			const message = turns++ === 0
				? response([{ type: "toolCall", id: "sandbox-proof", name: "bash", arguments: { command: "printf tool-ran > /workspace/tool-proof; uname -s" } }], "toolUse")
				: response([{ type: "text", text: "SANDBOX_READY" }]);				yield { type: "start", partial: { ...message, content: [] } };
				yield { type: "done", reason: message.stopReason, message };
		} });
		try {
			const result = await execute(args(["Run the requested check."]));
			assert.equal(result.code, 0, result.stderr + result.stdout);
			assert.doesNotMatch(result.stderr + result.stdout, /Failed to load extension|Sandbox inference failed/);
			assert.match(result.stdout, /SANDBOX_READY/);
			assert.equal(fs.readFileSync(path.join(project, "tool-proof"), "utf8"), "tool-ran");
			assert.equal(turns, 2);
			t.diagnostic(`Cached-image Pi profile + two brokered turns: ${result.milliseconds}ms`);
		} finally { await broker.stop(); }
	});
});

test("sandbox subagents run inside the guest and keep brokered inference", { skip: !enabled, timeout: 120000 }, async () => {
	await fixture(async ({ root, args }) => {
		let turns = 0;
		const broker = startBroker(path.join(root, "mailbox"), { model, async *stream() {
			const turn = turns++;
			const message = turn === 0
				? response([{ type: "toolCall", id: "sandbox-child", name: "subagent", arguments: { agent: "explorer", taskName: "Inspect sandbox", task: "Reply CHILD_OK. Do not call tools." } }], "toolUse")
				: response([{ type: "text", text: turn === 1 ? "CHILD_OK" : "SUBAGENT_READY" }]);
			yield { type: "start", partial: { ...message, content: [] } };
			yield { type: "done", reason: message.stopReason, message };
		} });
		try {
			const result = await execute(args(["Delegate the requested check."]));
			assert.equal(result.code, 0, result.stderr + result.stdout);
			assert.match(result.stdout, /SUBAGENT_READY/);
			assert.equal(turns, 3, result.stdout + result.stderr);
		} finally { await broker.stop(); }
	});
});

test("non-terminal sessions keep stdin attached independently of TTY allocation", { skip: !enabled, timeout: 120000 }, async () => {
	await fixture(async ({ pkg, resources, args }) => {
		fs.writeFileSync(path.join(resources, "stdin.mjs"), "let input=''; for await (const chunk of process.stdin) input += chunk; console.log('STDIN:' + input.trim());\n");
		const command = args(); const index = command.indexOf(sandboxImage(pkg).tag);
		command.splice(index + 1, command.length, "node", "/opt/pi-config/stdin.mjs");
		const result = await execute(command, "sandbox-rpc-input\n");
		assert.equal(result.code, 0, result.stderr);
		assert.match(result.stdout, /STDIN:sandbox-rpc-input/);
	});
});

test("real host-authenticated inference succeeds from an otherwise offline guest", { skip: !enabled || process.env.PI_SANDBOX_LIVE_MODEL !== "1", timeout: 120000 }, async () => {
	await fixture(async ({ root, pkg, agentDir, args }) => {
		const host = await createHostModel(pkg, agentDir);
		const broker = startBroker(path.join(root, "mailbox"), host);
		try {
			const result = await execute(args(["Reply with exactly SANDBOX_LIVE_OK. Do not call tools."]));
			assert.equal(result.code, 0, result.stderr + result.stdout);
			assert.match(result.stdout, /SANDBOX_LIVE_OK/);
			assert.doesNotMatch(result.stderr + result.stdout, /Failed to load extension|Sandbox inference failed/);
		} finally { await broker.stop(); }
	});
});
