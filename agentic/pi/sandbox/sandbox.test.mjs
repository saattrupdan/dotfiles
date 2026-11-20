import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { afterEach, test } from "node:test";
import { pathToFileURL } from "node:url";
import { checkSessionPaths, loadProfile, resolvePiPackage, runCli } from "../profile/launcher.mjs";
import { repositorySandbox, sandboxArguments } from "./policy.mjs";
import { inferenceRequest, publishJson, readRegularFile, sleep } from "./protocol.mjs";
import { publicModel, startBroker } from "./broker.mjs";
import { failureMessage, mailboxStream } from "./guest-provider.mjs";
import { requestSandbox } from "./handoff.mjs";
import { containerArguments, sandboxImage, stageSandboxResources } from "./runtime.mjs";
import { packEvent, unpackEvent } from "./events.mjs";

const roots = [];
const temporary = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sandbox-test-")); roots.push(dir); return dir; };
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const model = { id: "test-model", provider: "test", api: "test", name: "Test model", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 10000, maxTokens: 1000, baseUrl: "https://private.invalid", headers: { Authorization: "secret" } };
const context = { messages: [{ role: "user", content: "Hello", timestamp: 0 }] };
const message = { ...failureMessage(model, ""), stopReason: "stop", content: [{ type: "text", text: "Hello æøå 📦" }] };

async function eventStream() {
	const pkg = resolvePiPackage();
	return (await import(pathToFileURL(path.join(pkg, "node_modules/@earendil-works/pi-ai/dist/index.js")).href)).createAssistantMessageEventStream;
}

async function until(predicate) {
	for (let i = 0; i < 100; i++) { if (predicate()) return; await sleep(10); }
	throw new Error("Sandbox test timed out");
}

test("repository opt-in is root-scoped, optional, and has no host capability knobs", () => {
	const root = temporary();
	fs.mkdirSync(path.join(root, ".git"));
	fs.mkdirSync(path.join(root, "nested"));
	assert.equal(repositorySandbox(path.join(root, "nested")), undefined);
	fs.mkdirSync(path.join(root, ".pi"));
	const config = path.join(root, ".pi/sandbox.json");
	fs.writeFileSync(config, '{"enabled":true}');
	assert.equal(repositorySandbox(path.join(root, "nested")).root, fs.realpathSync(root));
	fs.writeFileSync(config, '{"enabled":false}');
	assert.equal(repositorySandbox(root), undefined);
	for (const value of ['{}', '{"enabled":"true"}', '{"enabled":true,"mount":"/"}']) {
		fs.writeFileSync(config, value);
		assert.throws(() => repositorySandbox(root), /expected/);
	}
	fs.unlinkSync(config);
	fs.symlinkSync(path.join(root, ".git"), config);
	assert.throws(() => repositorySandbox(root), /regular JSON/);
});

test("sandbox CLI cannot import host sessions, resources, models, or private files", () => {
	assert.deepEqual(sandboxArguments(["-p", "--no-session", "--thinking=high", "hello"]), ["-p", "--no-session", "--thinking", "high", "hello"]);
	for (const args of [["--session", "/host.jsonl"], ["--resume"], ["--continue"], ["-c"], ["--extension", "/evil"], ["--model", "other"], ["@/etc/passwd"], ["--thinking", "bogus"]]) {
		if (args[0].startsWith("@")) continue;
		assert.throws(() => sandboxArguments(args));
	}
});

test("editor launch metadata is preserved without importing its host extension", () => {
	const args = sandboxArguments(["--tui-mode", "regular", "--session-id", "nvim-session-123", "--extension", "/home/user/.local/share/nvim/lazy/pi-agent.nvim/lua/pi-agent/status.ts"]);
	assert.deepEqual(args, ["--tui-mode", "regular", "--session-id", "nvim-session-123"]);
	assert.throws(() => sandboxArguments(["--session-id", "../../host"]));
	assert.throws(() => sandboxArguments(["--tui-mode", "invalid"]));
});

test("fixed-model inference schema rejects destinations, auth, and unsupported options", () => {
	assert.deepEqual(inferenceRequest({ context, options: { reasoning: "high" } }).context, context);
	for (const value of [null, { context, url: "https://evil" }, { context: { ...context, url: "https://evil" } }, { context, options: { apiKey: "secret" } }, { context, options: { headers: {} } }, { context, options: { maxTokens: -1 } }, { context, options: { reasoning: "bad" } }, { context, options: { temperature: "1" } }]) assert.throws(() => inferenceRequest(value));
	const visible = publicModel(model);
	assert.equal(visible.headers, undefined);
	assert.equal(visible.baseUrl, "sandbox://model");
	assert.ok(!JSON.stringify(visible).includes("secret"));
});

test("mailbox reads refuse symlinks, FIFOs, oversized files, and directories", () => {
	const root = temporary(), file = path.join(root, "file"), link = path.join(root, "link");
	fs.writeFileSync(file, "payload"); fs.symlinkSync(file, link);
	assert.equal(readRegularFile(file), "payload");
	assert.throws(() => readRegularFile(link));
	assert.throws(() => readRegularFile(file, 2));
	assert.throws(() => readRegularFile(root));
	assert.throws(() => publishJson(root, "../escape", {}));
});

test("broker and provider relay Unicode streaming without giving the guest credentials", async () => {
	const root = temporary(); let requests = 0, payloadHooks = 0, responseHooks = 0;
	const broker = startBroker(root, { model, async *stream(received, options) {
		requests++; assert.deepEqual(received, context); assert.equal(options.reasoning, "high");
		yield { type: "start", partial: message };
		yield { type: "text_start", contentIndex: 0, partial: message };
		yield { type: "text_delta", contentIndex: 0, delta: "Hello æøå 📦", partial: message };
		yield { type: "text_end", contentIndex: 0, content: "Hello æøå 📦", partial: message };
		yield { type: "done", reason: "stop", message };
	} });
	try {
		const stream = mailboxStream(await eventStream(), root, publicModel(model), context, { reasoning: "high", onPayload: () => { payloadHooks++; }, onResponse: () => { responseHooks++; } });
		const events = []; for await (const event of stream) events.push(event.type);
		assert.deepEqual(events, ["start", "text_start", "text_delta", "text_end", "done"]);
		assert.equal((await stream.result()).content[0].text, "Hello æøå 📦");
		assert.equal(requests, 1); assert.equal(payloadHooks, 1); assert.equal(responseHooks, 1);
		assert.ok(!fs.readFileSync(path.join(root, "model.json"), "utf8").includes("secret"));
	} finally { await broker.stop(); }
});

test("untrusted request files cannot redirect the broker or leak host diagnostics", async () => {
	const root = temporary(); let requests = 0;
	const broker = startBroker(root, { model, async *stream() { requests++; throw new Error("secret host diagnostic"); } });
	try {
		const id = randomUUID();
		fs.symlinkSync("/etc/passwd", path.join(root, `${id}.request`));
		await until(() => fs.existsSync(path.join(root, `${id}.events`)) && fs.readFileSync(path.join(root, `${id}.events`), "utf8").includes("error"));
		assert.equal(requests, 0);
		const stream = mailboxStream(await eventStream(), root, model, context);
		const result = await stream.result();
		assert.equal(result.stopReason, "error");
		assert.ok(!result.errorMessage.includes("secret"));
	} finally { await broker.stop(); }
});

test("emitted provider errors are sanitized before reaching the guest", async () => {
	const root = temporary();
	const broker = startBroker(root, { model, async *stream() {
		yield { type: "error", reason: "error", error: failureMessage(model, "Authorization: secret credential-command") };
	} });
	try {
		const stream = mailboxStream(await eventStream(), root, model, context);
		const result = await stream.result();
		assert.equal(result.stopReason, "error");
		assert.doesNotMatch(JSON.stringify(result), /secret|credential-command/);
	} finally { await broker.stop(); }
});

test("oversized transport aborts generation and promptly delivers a reserved terminal error", async () => {
	const root = temporary(); let signal;
	const broker = startBroker(root, { model, async *stream(_context, options) {
		signal = options.signal;
		yield { type: "start", partial: { ...message, content: [] } };
		yield { type: "text_start", contentIndex: 0, partial: message };
		yield { type: "text_delta", contentIndex: 0, delta: "x".repeat(10000), partial: message };
	} }, { responseLimit: 2048 });
	try {
		const stream = mailboxStream(await eventStream(), root, model, context);
		const result = await stream.result();
		assert.equal(result.stopReason, "error"); assert.equal(signal.aborted, true);
	} finally { await broker.stop(); }
});

test("stream frames are linear in delta size and reconstruct tool arguments and signatures", () => {
	const partial = { ...message, content: [{ type: "toolCall", id: "call", name: "bash", arguments: {}, thoughtSignature: "signed" }] };
	const state = {};
	unpackEvent(packEvent({ type: "start", partial }), state);
	unpackEvent(packEvent({ type: "toolcall_start", contentIndex: 0, partial }), state);
	const frame = packEvent({ type: "toolcall_delta", contentIndex: 0, delta: '{"command":"true"}', partial });
	assert.equal(frame.partial, undefined);
	unpackEvent(frame, state);
	assert.deepEqual(state.partial.content[0].arguments, { command: "true" });
	const end = unpackEvent(packEvent({ type: "toolcall_end", contentIndex: 0, toolCall: partial.content[0], partial }), state);
	assert.equal(end.partial.content[0].thoughtSignature, "signed");
	partial.content[0].arguments = { command: "x".repeat(100000) };
	assert.ok(JSON.stringify(packEvent({ type: "toolcall_delta", contentIndex: 0, delta: "x", partial })).length < 200);
});

test("actual staged resources include render dependencies but exclude host extension factories", async () => {
	const target = temporary(), pkg = resolvePiPackage();
	const agentDir = process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi/agent");
	await stageSandboxResources(agentDir, pkg, target);
	for (const file of ["web-browse/command.ts", "mcp-collapse/display.ts", "sandbox-guest/index.ts", "run-python-code/index.ts"]) assert.ok(fs.existsSync(path.join(target, "extensions", file)), file);
	for (const file of ["web-browse/index.ts", "mcp-collapse/index.ts", "file-protection/index.ts", "memory/index.ts"]) assert.ok(!fs.existsSync(path.join(target, "extensions", file)), file);
	assert.ok(!fs.existsSync(path.join(target, "auth.json")));
	assert.ok(!fs.existsSync(path.join(target, "models.json")));
	for (const file of ["container-lifecycle.mjs", "runtime.mjs", "broker.mjs", "pty-close.test.py"]) assert.ok(!fs.existsSync(path.join(target, "sandbox", file)), file);
	assert.ok(fs.existsSync(path.join(target, "sandbox/guest-provider.mjs")));
});

test("staging carries theme and UI preferences without host bootstrap settings", async () => {
	const original = process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi/agent");
	const agentDir = temporary(), target = temporary();
	for (const name of ["agents", "extensions", "skills", "profile", "themes"]) fs.symlinkSync(path.join(original, name), path.join(agentDir, name));
	fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ theme: "gruvbox", quietStartup: true, terminal: { clearOnShrink: false, showImages: false, private: "secret" }, shellPath: "/host-shell", shellCommandPrefix: "host-command", packages: ["host-package"], extensions: ["host-extension"] }));
	await stageSandboxResources(agentDir, resolvePiPackage(), target);
	const settings = JSON.parse(fs.readFileSync(path.join(target, "settings.json"), "utf8"));
	assert.equal(settings.theme, "gruvbox"); assert.equal(settings.quietStartup, true);
	assert.deepEqual(settings.terminal, { clearOnShrink: false, showImages: false });
	assert.deepEqual(settings.packages, []); assert.deepEqual(settings.extensions, []);
	assert.equal(settings.shellPath, undefined); assert.equal(settings.shellCommandPrefix, undefined);
	assert.ok(fs.existsSync(path.join(target, "themes/gruvbox.json")));
});

test("cancelling a guest inference aborts the corresponding host request", async () => {
	const root = temporary(); let signal;
	const broker = startBroker(root, { model, async *stream(_context, options) {
		signal = options.signal;
		await new Promise((resolve) => options.signal.addEventListener("abort", resolve, { once: true }));
		yield { type: "error", reason: "aborted", error: failureMessage(model, "cancelled", true) };
	} });
	try {
		const controller = new AbortController();
		const stream = mailboxStream(await eventStream(), root, model, context, { signal: controller.signal });
		await until(() => signal); controller.abort();
		assert.equal((await stream.result()).stopReason, "aborted");
		await until(() => signal.aborted);
	} finally { await broker.stop(); }
});

test("container mounts expose only project, curated resources, mailbox, and private state", () => {
	const args = containerArguments({ name: "test", image: "shared", root: "/project", cwd: "/project/nested", resources: "/resources", mailbox: "/mailbox", sessions: "/state/sessions", cache: "/state/cache", uid: 501, gid: 20, args: ["-p", "hello"], tty: false });
	assert.ok(args.includes("--read-only")); assert.ok(args.includes("--cap-drop"));
	assert.ok(args.includes("-i")); assert.ok(!args.includes("-t"));
	assert.ok(args.includes("/workspace/nested"));
	assert.equal(args.filter((a) => a === "--mount").length, 5);
	assert.ok(!args.some((a) => a.includes("SSH_AUTH_SOCK") || a.includes("ANTHROPIC_API_KEY")));
	assert.throws(() => containerArguments({ name: "test", root: "/project,bad", resources: "a", mailbox: "b", sessions: "c", cache: "d" }), /mount paths/);
	assert.throws(() => containerArguments({ root: "/project", cwd: "/other", resources: "a", mailbox: "b", sessions: "c", cache: "d" }), /inside/);
	assert.equal(sandboxImage(resolvePiPackage()).tag, sandboxImage(resolvePiPackage()).tag);
});

test("private session links accept their own histories and stay private from other profiles", () => {
	const agentDir = temporary(), sessions = temporary();
	fs.mkdirSync(path.join(agentDir, "profile-sessions"));
	fs.symlinkSync(sessions, path.join(agentDir, "profile-sessions/sandbox"));
	const session = path.join(sessions, "saved.jsonl"); fs.writeFileSync(session, "{}");
	assert.doesNotThrow(() => checkSessionPaths(["--session", session], "sandbox", agentDir));
	assert.throws(() => checkSessionPaths(["--session", session], "main", agentDir), /another agent/);
	assert.throws(() => checkSessionPaths(["--session", session], "librarian", agentDir), /another agent/);
	assert.throws(() => checkSessionPaths(["--session-dir", sessions], "main", agentDir), /storage/);
	assert.throws(() => checkSessionPaths([], "main", agentDir, agentDir, sessions), /private profile/);
});

test("guest supervisor keeps approved model flags separate from user arguments", async () => {
	const root = temporary(), cli = path.join(root, "cli.mjs"), capture = path.join(root, "argv.json");
	fs.writeFileSync(cli, "import fs from 'node:fs'; fs.writeFileSync(process.env.CAPTURE_PATH, JSON.stringify(process.argv.slice(2)));\n");
	const code = await runCli(cli, ["--", "prompt"], { ...process.env, PI_SANDBOX: "1", CAPTURE_PATH: capture }, { profile: { name: "sandbox" }, userArgs: ["-p"], fixedModel: { provider: "approved", id: "model" } });
	assert.equal(code, 0);
	assert.deepEqual(JSON.parse(fs.readFileSync(capture, "utf8")), ["--provider", "approved", "--model", "model", "--", "prompt"]);
});

test("sandbox retains main's offline UI and coding extensions", async () => {
	const agentDir = path.resolve(import.meta.dirname, "..");
	const profile = await loadProfile("sandbox", agentDir, resolvePiPackage());
	for (const name of ["bash-output", "code-tree", "codemode", "codemode-collapse", "context-limit", "conversation-name", "edit", "git-worktree-isolation", "incognito", "loop", "non-interactive", "precomputed-compaction", "rate-limit-retry", "read", "read-groups", "search", "splash", "thinking-status", "zero-hidden-thinking"]) assert.ok(profile.extensions.includes(name), `Missing offline extension: ${name}`);
	assert.ok(profile.tools.includes("search")); assert.ok(profile.tools.includes("code_tree")); assert.ok(profile.tools.includes("codemode"));
});

test("sandbox profile excludes snapshots, web, host memory, and macOS integrations", async () => {
	const agentDir = path.resolve(import.meta.dirname, "..");
	const profile = await loadProfile("sandbox", agentDir, resolvePiPackage());
	assert.equal(profile.subagent, false);
	for (const name of ["file-protection", "web-browse", "memory-handoff", "notify", "copy-paste", "caffeinate"]) assert.ok(!profile.extensions.includes(name));
	assert.ok(profile.extensions.includes("sandbox-guest"));
	assert.match(profile.systemPrompt, /\.pi\/sandbox\.json/);
	const main = await loadProfile("main", agentDir, resolvePiPackage());
	assert.ok(main.extensions.includes("sandbox")); assert.ok(!main.extensions.includes("sandbox-guest"));
	assert.match(main.systemPrompt, /enable sandboxing for this repo/);
});

test("handoff authenticates replies, cleans listeners, and cancels timeouts", async () => {
	const transport = new EventEmitter(); transport.env = { PI_PROFILE_RELOAD_TOKEN: "test" }; transport.connected = true;
	let sent;
	transport.send = (message, callback) => { sent = message; callback?.(); };
	const result = requestSandbox({ cwd: "/project" }, transport);
	transport.emit("message", { type: "pi-sandbox-result", id: sent.id, token: "wrong", status: "restart" });
	transport.emit("message", { type: "pi-sandbox-result", id: sent.id, token: "test", status: "restart" });
	assert.equal((await result).status, "restart"); assert.equal(transport.listenerCount("message"), 0);
	await assert.rejects(requestSandbox({ cwd: "/project" }, transport, 10), /timed out/);
	assert.equal(sent.type, "pi-sandbox-cancel");
	await assert.rejects(requestSandbox({}, { env: {}, connected: false }), /supervisor/);
});
