import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import sandbox from "./index.ts";
import { getPiInvocation } from "../subagent/pi-invocation.ts";

test("sandbox subagents retain their guest model provider", () => {
	const previous = process.env.PI_SANDBOX;
	try {
		process.env.PI_SANDBOX = "1";
		const invocation = getPiInvocation(["--no-extensions", "-p", "task"]);
		assert.ok(invocation.args.some((arg) => arg.endsWith("extensions/sandbox-guest")));
		assert.ok(invocation.args.includes("--no-extensions"));
		delete process.env.PI_SANDBOX;
		assert.ok(!getPiInvocation(["-p", "task"]).args.some((arg) => arg.endsWith("extensions/sandbox-guest")));
	} finally {
		if (previous === undefined) delete process.env.PI_SANDBOX;
		else process.env.PI_SANDBOX = previous;
	}
});

test("/sandbox opens a fresh session without on/off arguments", async () => {
	let handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
	let requests = 0, stopped = 0;
	const notices: string[] = [];
	const pi = { registerCommand: (_name: string, command: { handler: typeof handler }) => { handler = command.handler; }, on() {}, getThinkingLevel: () => "high" } as unknown as ExtensionAPI;
	const ctx = { cwd: "/project", mode: "interactive", model: { provider: "test", id: "model" }, waitForIdle: async () => {}, shutdown: () => { stopped++; }, ui: { notify: (text: string) => notices.push(text) } } as unknown as ExtensionCommandContext;
	sandbox(pi, async (state) => { requests++; assert.equal(state.cwd, "/project"); assert.equal(state.model?.id, "model"); return { status: "restart" }; });
	await handler!("on", ctx);
	assert.equal(requests, 0); assert.match(notices[0], /without arguments/);
	await handler!("", ctx);
	assert.equal(requests, 1); assert.equal(stopped, 1);
});

test("configured /new-style session starts hand off automatically and fail closed", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sandbox-extension-"));
	try {
		fs.mkdirSync(path.join(root, ".git")); fs.mkdirSync(path.join(root, ".pi"));
		fs.writeFileSync(path.join(root, ".pi/sandbox.json"), '{"enabled":true}');
		let start: (event: unknown, ctx: ExtensionContext) => Promise<void>;
		let stopped = 0;
		const pi = { registerCommand() {}, on: (_event: string, callback: typeof start) => { start = callback; }, getThinkingLevel: () => "high" } as unknown as ExtensionAPI;
		const ctx = { cwd: root, mode: "interactive", shutdown: () => { stopped++; }, ui: { notify() {} } } as unknown as ExtensionContext;
		sandbox(pi, async () => ({ status: "rejected", error: "Runtime unavailable" }));
		await start!({}, ctx);
		assert.equal(stopped, 1);
		fs.writeFileSync(path.join(root, ".pi/sandbox.json"), '{"enabled":false}');
		await start!({}, ctx); assert.equal(stopped, 1);
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
});
