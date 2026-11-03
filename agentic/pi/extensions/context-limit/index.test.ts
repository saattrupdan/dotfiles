import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import contextLimit from "./index.ts";

type Model = NonNullable<ExtensionContext["model"]>;
type Entry = { type: "custom"; customType: string; data: { enabled: boolean } };

function model(id: string, contextWindow: number): Model {
	return { provider: id.split("/")[0], id, contextWindow, maxTokens: 16_384 } as Model;
}

function setup(models = [model("openai-codex/sol", 500_000)], entries: Entry[] = [], flag = false) {
	const listeners = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	const notices: { text: string; level: string }[] = [];
	const statuses: (string | undefined)[] = [];
	let command: ((args: string, ctx: ExtensionContext) => unknown) | undefined;
	let activeModel: Model | undefined = models[0];
	const createProviders = (models: Model[]) => new Map([...new Set(models.map(m => m.provider))].map(id => [id, {
		getModels: () => models.filter(m => m.provider === id),
		getAllModels: () => models.filter(m => m.provider === id),
	}]));
	let providers = createProviders(models);
	let branch = entries;
	const registry = {
		getAll: () => [...providers.values()].flatMap(p => p.getModels()),
		getProvider: (id: string) => providers.get(id),
	};
	const ctx = {
		get model() { return activeModel; },
		modelRegistry: registry,
		sessionManager: { getBranch: () => branch },
		ui: {
			notify: (text: string, level: string) => { notices.push({ text, level }); },
			setStatus: (key: string, value: string | undefined) => { assert.equal(key, "long-context"); statuses.push(value); },
		},
	} as ExtensionContext;
	contextLimit({
		registerFlag: (name: string, options: { type: string; default: boolean }) => {
			assert.equal(name, "allow-long-context");
			assert.equal(options.type, "boolean");
			assert.equal(options.default, false);
		},
		getFlag: (name: string) => { assert.equal(name, "allow-long-context"); return flag; },
		registerCommand: (name: string, options: { handler: typeof command }) => {
			assert.equal(name, "allow-long-context");
			command = options.handler;
		},
		on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => { listeners.set(name, handler); },
		appendEntry: (customType: string, data: { enabled: boolean }) => { branch.push({ type: "custom", customType, data }); },
	} as unknown as ExtensionAPI);
	const event = (name: string, payload: unknown = {}) => {
		const listener = listeners.get(name);
		assert.ok(listener, name);
		return listener(payload, ctx);
	};
	return {
		models, entries, notices, statuses, event, ctx, registryModels: registry.getAll,
		command: (args = "") => { assert.ok(command); return command(args, ctx); },
		select: (next: Model) => { activeModel = next; event("model_select", { model: next }); },
		refresh: (next: Model[]) => { providers = createProviders(next); },
		switchBranch: (next: Entry[]) => { branch = next; },
		clearModel: () => { activeModel = undefined; },
	};
}

test("caps every provider at 256k without enlarging small windows or changing output limits", () => {
	const app = setup([model("openai-codex/sol", 500_000), model("anthropic/claude", 1_000_000), model("local/small", 128_000)]);
	app.event("session_start");
	assert.deepEqual(app.registryModels().map(m => m.contextWindow), [256_000, 256_000, 128_000]);
	assert.equal(app.statuses.at(-1), undefined);
	assert.deepEqual(app.models.map(m => m.maxTokens), [16_384, 16_384, 16_384]);
	app.event("input");
	app.event("before_agent_start");
	app.command();
	assert.deepEqual(app.registryModels().map(m => m.contextWindow), [500_000, 1_000_000, 128_000]);
	assert.equal(app.statuses.at(-1), "🧠");
	app.command(); // Enabling is idempotent, not a toggle.
	assert.equal(app.models[0].contextWindow, 500_000);
	app.command("off");
	assert.equal(app.models[0].contextWindow, 256_000);
	assert.equal(app.statuses.at(-1), undefined);
	app.command();
	assert.equal(app.models[0].contextWindow, 500_000);
});

test("new model selections and refreshed registries follow the current mode", () => {
	const app = setup();
	app.event("session_start");
	const selected = model("new/large", 2_000_000);
	app.select(selected);
	assert.equal(selected.contextWindow, 256_000);
	for (const hook of ["input", "before_agent_start", "turn_start"]) {
		const refreshed = model(`fresh/${hook}`, 800_000);
		app.refresh([refreshed]);
		app.event(hook);
		assert.equal(app.registryModels()[0].contextWindow, 256_000);
	}
	app.command();
	assert.equal(selected.contextWindow, 2_000_000);
	const another = model("other/large", 900_000);
	app.select(another);
	assert.equal(another.contextWindow, 900_000);
	app.command("off");
	assert.equal(another.contextWindow, 256_000);
});

test("opt-out survives resume, resets for new sessions, and follows branch navigation", () => {
	const app = setup();
	app.event("session_start");
	app.command();
	const resumed = setup(undefined, [...app.entries]);
	resumed.event("session_start");
	assert.equal(resumed.models[0].contextWindow, 500_000);
	assert.equal(resumed.statuses.at(-1), "🧠");
	resumed.command("off");
	resumed.event("session_start");
	assert.equal(resumed.models[0].contextWindow, 256_000);
	resumed.switchBranch(app.entries);
	resumed.event("session_tree");
	assert.equal(resumed.models[0].contextWindow, 500_000);
	resumed.switchBranch([]);
	resumed.event("session_start", { reason: "new" });
	assert.equal(resumed.models[0].contextWindow, 256_000);
});

test("CLI opt-out supplies the default and saved session choices take precedence", () => {
	const app = setup(undefined, [], true);
	app.event("session_start");
	assert.equal(app.models[0].contextWindow, 500_000);
	app.command("off");
	app.event("session_start");
	assert.equal(app.models[0].contextWindow, 256_000);
	app.command("invalid");
	assert.equal(app.notices.at(-1)?.level, "error");
	assert.equal(app.entries.length, 2);
	assert.equal(app.models[0].contextWindow, 256_000);
});

test("shutdown restores original metadata so reload can cap and opt out again", () => {
	const native = model("provider/large", 1_000_000);
	const first = setup([native]);
	first.event("session_start");
	assert.equal(native.contextWindow, 256_000);
	first.event("session_shutdown", { reason: "reload" });
	assert.equal(native.contextWindow, 1_000_000);
	const reloaded = setup([native]);
	reloaded.event("session_start", { reason: "reload" });
	reloaded.command();
	assert.equal(native.contextWindow, 1_000_000);
});

test("CLI opt-out persists when resumed without the startup flag", () => {
	const original = setup(undefined, [], true);
	original.event("session_start");
	const resumed = setup(undefined, [...original.entries]);
	resumed.event("session_start");
	assert.equal(resumed.models[0].contextWindow, 500_000);
	assert.equal(resumed.statuses.at(-1), "🧠");
});

test("installed SDK physical lookups stay capped even when providers return fresh models", async () => {
	const { ModelRuntime } = await import("../node_modules/@earendil-works/pi-coding-agent/dist/core/model-runtime.js");
	const { ModelRegistry } = await import("../node_modules/@earendil-works/pi-coding-agent/dist/core/model-registry.js");
	const { shouldCompact } = await import("../node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js");
	const compaction = { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 };
	const dir = mkdtempSync(path.join(tmpdir(), "pi-context-limit-test-"));
	const app = setup();
	try {
		const runtime = await ModelRuntime.create({ modelsPath: null, authPath: path.join(dir, "auth.json"), refreshOnCreate: false });
		runtime.registerProvider("context-limit-test", {
			api: "openai-completions", apiKey: "test", baseUrl: "http://localhost.invalid/v1",
			models: [{ id: "physical", contextWindow: 1_000_000 }],
		});
		const registry = new ModelRegistry(runtime);
		Object.assign(app.ctx, { modelRegistry: registry });
		const before = runtime.getPhysicalModel("context-limit-test", "physical");
		assert.ok(before);
		assert.notEqual(before, runtime.getPhysicalModel("context-limit-test", "physical"));
		app.event("session_start");
		const capped = runtime.getPhysicalModel("context-limit-test", "physical")!;
		assert.equal(capped.contextWindow, 256_000);
		assert.equal(shouldCompact(250_000, capped.contextWindow, compaction), true);
		assert.equal(registry.getModelsOfType("chat", "context-limit-test")[0].contextWindow, 256_000);
		app.command();
		const unlimited = runtime.getPhysicalModel("context-limit-test", "physical")!;
		assert.equal(unlimited.contextWindow, 1_000_000);
		assert.equal(shouldCompact(250_000, unlimited.contextWindow, compaction), false);
		app.command("off");
		assert.equal(runtime.getPhysicalModel("context-limit-test", "physical")?.contextWindow, 256_000);
		app.event("session_shutdown");
		assert.equal(runtime.getPhysicalModel("context-limit-test", "physical")?.contextWindow, 1_000_000);
	} finally {
		app.event("session_shutdown");
		rmSync(dir, { recursive: true, force: true });
	}
});

test("works before a model is selected", () => {
	const app = setup([]);
	app.clearModel();
	app.event("session_start");
	app.command();
	const selected = model("local/small", 32_000);
	app.select(selected);
	assert.equal(selected.contextWindow, 32_000);
});
