import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import splash from "./index.ts";

test("sandbox splash keeps the normal layout and displays isolation before the first message", async () => {
	const previous = process.env.PI_SANDBOX;
	process.env.PI_SANDBOX = "1";
	const hooks = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void>>();
	const widgets = new Map<string, (tui: TUI, theme: { fg: (_name: string, text: string) => string }) => Component>();
	const pi = { on: (name: string, callback: typeof hooks extends Map<string, infer H> ? H : never) => hooks.set(name, callback) } as unknown as ExtensionAPI;
	const ctx = {
		hasUI: true, model: { name: "Test model" },
		sessionManager: { getEntries: () => [], getSessionId: () => "sandbox-splash", getSessionFile: () => undefined },
		ui: { setHeader() {}, setFooter() {}, setEditorComponent() {}, setWidget: (name: string, factory: typeof widgets extends Map<string, infer F> ? F : never) => { if (factory) widgets.set(name, factory); else widgets.delete(name); } },
	} as unknown as ExtensionContext;
	try {
		splash(pi);
		await hooks.get("session_start")!({}, ctx);
		const tui = { terminal: { rows: 36 }, requestRender() {} } as unknown as TUI;
		const theme = { fg: (_name: string, text: string) => text };
		const lines = [...widgets.values()].flatMap(factory => factory(tui, theme).render(100));
		assert.match(lines.join("\n"), /Test model — 📦\s*$/m);
		assert.doesNotMatch(lines.join("\n"), /sandbox|offline/);
		assert.ok(widgets.size >= 3, "logo, editor footer, and spacing stay installed");
	} finally {
		await hooks.get("session_shutdown")?.({}, ctx);
		if (previous === undefined) delete process.env.PI_SANDBOX;
		else process.env.PI_SANDBOX = previous;
	}
});
