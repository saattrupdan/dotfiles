import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isIncognito, setIncognito, syncIncognito } from "../_incognito_state/state.js";
import incognito from "./index.ts";

test("/incognito <prompt> uses a fresh unsaved session and /incognito off starts a fresh saved one", async () => {
	setIncognito(false);
	const sessionDir = mkdtempSync(path.join(tmpdir(), "pi-incognito-test-"));
	let manager = SessionManager.create("/tmp", sessionDir);
	const originalFile = manager.getSessionFile();
	let command: (args: string, ctx: unknown) => Promise<void> = async () => {};
	const hooks = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const statuses: Array<string | undefined> = [];
	const prompts: string[] = [];
	const notifications: string[] = [];
	let activeTools = ["read", "memory_add", "memory_update"];
	const ui = {
		setStatus: (_key: string, value: string | undefined) => { statuses.push(value); },
		notify: (text: string) => { notifications.push(text); },
	};
	const pi = {
		registerCommand: (_name: string, definition: { handler: typeof command }) => { command = definition.handler; },
		on: (name: string, callback: (event: unknown, ctx: unknown) => unknown) => { hooks.set(name, callback); },
		getActiveTools: () => activeTools,
		setActiveTools: (tools: string[]) => { activeTools = tools; },
	} as unknown as ExtensionAPI;
	incognito(pi);
	const context = () => ({
		sessionManager: manager,
		ui,
		waitForIdle: async () => {},
		newSession: async (options: {
			setup: (session: SessionManager) => Promise<void>;
			withSession: (ctx: unknown) => Promise<void>;
		}) => {
			manager = manager.isPersisted() ? SessionManager.create("/tmp") : SessionManager.inMemory("/tmp");
			await hooks.get("session_start")?.({ reason: "new" }, { sessionManager: manager, ui });
			await options.setup(manager);
			await options.withSession({ sessionManager: manager, ui, sendUserMessage: async (text: string) => { prompts.push(text); } });
			return { cancelled: false };
		},
	});
	try {
		await command("private prompt", context());
		assert.equal(manager.isPersisted(), false);
		assert.equal(manager.getSessionFile(), undefined);
		assert.notEqual(manager.getSessionFile(), originalFile);
		assert.deepEqual(prompts, ["private prompt"]);
		assert.equal(isIncognito(manager), true);
		assert.equal(statuses.at(-1), "👻");
		await hooks.get("agent_start")?.({}, context());
		assert.deepEqual(activeTools, ["read"]);
		assert.deepEqual(hooks.get("tool_call")?.({ toolName: "memory_add" }, context()), {
			block: true, reason: "memory_add is disabled in incognito mode.",
		});

		await command("off", context());
		assert.equal(manager.getHeader()?.id, manager.getSessionId());
		assert.ok(manager.getSessionFile()?.endsWith(`${manager.getSessionId()}.jsonl`));
		assert.equal(manager.isPersisted(), true);
		assert.equal(manager.getSessionDir(), sessionDir);
		assert.ok(manager.getSessionFile());
		assert.equal(isIncognito(manager), false);
		assert.equal(statuses.at(-1), undefined);
		assert.equal(hooks.get("tool_call")?.({ toolName: "memory_update" }, context()), undefined);
		assert.deepEqual(prompts, ["private prompt"]);
		assert.match(notifications.at(-1) ?? "", /saved session/);

		await command("", context());
		assert.equal(isIncognito(manager), true);
		assert.equal(statuses.at(-1), "👻");
		assert.deepEqual(prompts, ["private prompt"]);
		const fork = SessionManager.inMemory("/tmp");
		syncIncognito("fork", fork);
		assert.equal(isIncognito(fork), true);
		syncIncognito("reload", fork);
		assert.equal(isIncognito(fork), true);
		syncIncognito("resume", SessionManager.create("/tmp"));
		assert.equal(isIncognito(fork), false);
	} finally {
		setIncognito(false);
		rmSync(sessionDir, { recursive: true, force: true });
	}
});
