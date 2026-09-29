import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(root, "..", "_outliner", "package.json"));
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { moduleCache: false });
const { default: nonInteractive } = await jiti.import(path.join(root, "index.ts"), { default: false });

test("/non-interactive queues during streaming and enables mode for the message", async () => {
	const previous = process.env.PI_NON_INTERACTIVE;
	const listeners = new Map();
	let command;
	let queued;
	const pi = {
		registerCommand(_name, definition) {
			command = definition.handler;
		},
		on(event, listener) {
			listeners.set(event, listener);
		},
		sendUserMessage(content, options) {
			queued = { content, options };
			void listeners.get("input")();
		},
	};

	try {
		nonInteractive(pi);
		await command("  finish the job  ", {});
		assert.match(queued.content, /NON-INTERACTIVE MODE:.*\n\nfinish the job$/s);
		assert.deepEqual(queued.options, { deliverAs: "steer" });
		assert.equal(process.env.PI_NON_INTERACTIVE, "1");
		await listeners.get("agent_end")();
		assert.equal(process.env.PI_NON_INTERACTIVE, undefined);
	} finally {
		if (previous === undefined) delete process.env.PI_NON_INTERACTIVE;
		else process.env.PI_NON_INTERACTIVE = previous;
	}
});

test("/non-interactive also sends normally when idle", async () => {
	let options;
	let command;
	const pi = {
		registerCommand(_name, definition) {
			command = definition.handler;
		},
		on() {},
		sendUserMessage(_content, delivery) {
			options = delivery;
		},
	};
	const previous = process.env.PI_NON_INTERACTIVE;
	try {
		nonInteractive(pi);
		await command("run", {});
		assert.deepEqual(options, { deliverAs: "steer" });
	} finally {
		if (previous === undefined) delete process.env.PI_NON_INTERACTIVE;
		else process.env.PI_NON_INTERACTIVE = previous;
	}
});
