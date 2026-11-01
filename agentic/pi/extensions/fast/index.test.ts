import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import fast from "./index.ts";

type Model = ExtensionContext["model"];
const codex = { provider: "openai-codex", api: "openai-codex-responses", id: "gpt-6-sol" } as Model;
const other = { provider: "anthropic", api: "anthropic-messages", id: "claude" } as Model;

function setup(model: Model = codex) {
	const statuses: (string | undefined)[] = [];
	const notices: { text: string; level: string }[] = [];
	const listeners = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	let command: ((args: string, ctx: ExtensionContext) => unknown) | undefined;
	let activeModel = model;
	const ctx = {
		get model() { return activeModel; },
		ui: {
			setStatus: (key: string, value: string | undefined) => { assert.equal(key, "fast"); statuses.push(value); },
			notify: (text: string, level: string) => { notices.push({ text, level }); },
		},
	} as ExtensionContext;
	fast({
		registerCommand: (name: string, options: { handler: (args: string, ctx: ExtensionContext) => unknown }) => {
			assert.equal(name, "fast");
			command = options.handler;
		},
		on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => { listeners.set(name, handler); },
	} as unknown as ExtensionAPI);
	return {
		statuses, notices,
		command: (args = "") => { assert.ok(command); return command(args, ctx); },
		event: (name: string, payload: unknown = {}) => { const listener = listeners.get(name); assert.ok(listener); return listener(payload, ctx); },
		select: (next: Model) => { activeModel = next; const listener = listeners.get("model_select"); assert.ok(listener); listener({}, ctx); },
	};
}

test("/fast toggles request tier and footer on Codex", () => {
	const app = setup();
	const payload = { model: "gpt-6-sol", input: [] };
	app.command();
	assert.equal(app.statuses.at(-1), "⚡️");
	assert.deepEqual(app.event("before_provider_request", { payload }), { ...payload, service_tier: "priority" });
	assert.deepEqual(payload, { model: "gpt-6-sol", input: [] });
	app.command();
	assert.equal(app.statuses.at(-1), undefined);
	assert.equal(app.event("before_provider_request", { payload }), undefined);
	app.command();
	app.command("off");
	assert.equal(app.statuses.at(-1), undefined);
	assert.equal(app.event("before_provider_request", { payload }), undefined);
});

test("Fast mode requires Codex and turns off when switching away", () => {
	const app = setup(other);
	app.command();
	assert.match(app.notices.at(-1)?.text ?? "", /only available with a Codex model/);
	assert.equal(app.event("before_provider_request", { payload: {} }), undefined);
	app.select(codex);
	assert.equal(app.statuses.at(-1), undefined);
	app.command();
	app.select({ ...codex, id: "gpt-6-luna" });
	assert.equal(app.statuses.at(-1), "⚡️");
	app.select(other);
	assert.equal(app.statuses.at(-1), undefined);
	app.select(codex);
	assert.equal(app.statuses.at(-1), undefined);
	assert.equal(app.event("before_provider_request", { payload: {} }), undefined);
});

test("session restores status without applying Fast mode to non-Codex requests", () => {
	const app = setup();
	app.command();
	app.event("session_start");
	assert.equal(app.statuses.at(-1), "⚡️");
	app.select(other);
	app.event("session_start");
	assert.equal(app.statuses.at(-1), undefined);
	app.command("off");
	assert.equal(app.notices.at(-1)?.level, "info");
	app.command("invalid");
	assert.equal(app.notices.at(-1)?.text, "Usage: /fast [off]");
});
