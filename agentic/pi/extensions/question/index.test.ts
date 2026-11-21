import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { askLocally } from "./index.ts";

const question = {
	question: "Which actions should still need your approval? Select all that apply.\nThe agent may otherwise deploy fixes and UX improvements automatically.",
	options: [
		"Change pricing, payments, or subscription terms",
		"Change login, permissions, or personal-data collection",
		"Delete user data or make destructive database changes",
		"Send emails or other messages to real users",
		"Add paid services or increase recurring spending",
	],
	multiSelect: true,
};

test("checkbox questions render all options in a focused dialog, never the status line", async () => {
	const controller = new AbortController();
	let dialogs = 0;
	const ui = {
		onTerminalInput: () => () => {},
		setWorkingMessage: () => { assert.fail("Questions must not render in the status line"); },
		custom: async (factory: Parameters<ExtensionUIContext["custom"]>[0]) => {
			dialogs++;
			let answer: unknown;
			const view = await factory({ requestRender() {} } as never, {} as never, {} as never, (result) => { answer = result; });
			const rendered = view.render(60).join(" ").replace(/\s+/g, " ");
			for (const option of question.options) {
				assert.ok(rendered.includes(option), `Missing option: ${option}`);
			}
			view.handleInput?.(" ");
			view.handleInput?.("\x1b[B");
			view.handleInput?.(" ");
			view.handleInput?.("\r");
			view.dispose?.();
			return answer;
		},
	} as unknown as ExtensionUIContext;
	const pending = askLocally(ui, [question], controller.signal);
	try {
		assert.equal(dialogs, 1, "Checkbox prompt must use ui.custom, not the one-line working indicator");
		assert.deepEqual(await pending, { answers: [question.options.slice(0, 2).join(", ")] });
	} finally {
		controller.abort();
		await pending;
	}
});

for (const [label, keys, expected] of [
	["empty submit", ["\r"], { error: "User submitted empty answer.", answers: [] }],
	["escape", ["\x1b"], { error: "User dismissed question.", answers: [] }],
	["toggle off", [" ", " ", "\r"], { error: "User submitted empty answer.", answers: [] }],
	["other", ["\x1b[A", " ", "\r"], { answers: ["Custom restriction"] }],
] as const) {
	test(`checkbox dialog handles ${label}`, async () => {
		const ui = {
			input: async () => "Custom restriction",
			custom: async (factory: Parameters<ExtensionUIContext["custom"]>[0]) => {
				let answer: unknown;
				const view = await factory({ requestRender() {} } as never, {} as never, {} as never, (result) => { answer = result; });
				for (const key of keys) view.handleInput?.(key);
				view.dispose?.();
				return answer;
			},
		} as unknown as ExtensionUIContext;
		assert.deepEqual(await askLocally(ui, [question], undefined), expected);
	});
}

test("aborting an active checkbox dialog dismisses it and removes the listener", async () => {
	const controller = new AbortController();
	let dismissals = 0;
	const ui = {
		custom: async (factory: Parameters<ExtensionUIContext["custom"]>[0]) => {
			const view = await factory({} as never, {} as never, {} as never, () => { dismissals++; });
			controller.abort();
			assert.equal(dismissals, 1);
			view.dispose?.();
			return undefined;
		},
	} as unknown as ExtensionUIContext;
	assert.deepEqual(await askLocally(ui, [question], controller.signal), { error: "aborted", answers: [] });
	assert.equal(dismissals, 1);
});

test("pre-aborted questions never open a checkbox dialog", async () => {
	const ui = { custom() { assert.fail("Opened an aborted dialog"); } } as unknown as ExtensionUIContext;
	assert.deepEqual(await askLocally(ui, [question], AbortSignal.abort()), { error: "aborted", answers: [] });
});

test("repeated single-choice questions still use the native selector", async () => {
	let calls = 0;
	const ui = {
		select: async () => { calls++; return question.options[0]; },
	} as unknown as ExtensionUIContext;
	const item = { ...question, multiSelect: false };
	assert.deepEqual(await askLocally(ui, [item, item], undefined), { answers: [item.options[0], item.options[0]] });
	assert.equal(calls, 2);
});
