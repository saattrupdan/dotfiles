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
const { setLoopActive } = await jiti.import(path.join(root, "..", "_loop_state", "state.ts"), { default: false });

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

test("loop keeps non-interactive mode through turns and clears it when stopped", async () => {
	const previous = process.env.PI_NON_INTERACTIVE;
	const listeners = new Map();
	const pi = {
		registerCommand() {},
		on(event, listener) { listeners.set(event, listener); },
	};
	try {
		nonInteractive(pi);
		setLoopActive(true, {});
		assert.equal(process.env.PI_NON_INTERACTIVE, "1");
		await listeners.get("input")({ source: "extension" });
		await listeners.get("agent_start")();
		await listeners.get("agent_end")();
		assert.equal(process.env.PI_NON_INTERACTIVE, "1");
		setLoopActive(false, {});
		assert.equal(process.env.PI_NON_INTERACTIVE, undefined);
	} finally {
		setLoopActive(false, {});
		if (previous === undefined) delete process.env.PI_NON_INTERACTIVE;
		else process.env.PI_NON_INTERACTIVE = previous;
	}
});

test("subagents keep the inherited question guard", () => {
	const priorChild = process.env.PI_SUBAGENT_CHILD;
	const priorFlag = process.env.PI_NON_INTERACTIVE;
	try {
		process.env.PI_SUBAGENT_CHILD = "1";
		process.env.PI_NON_INTERACTIVE = "1";
		nonInteractive({
			registerCommand() { throw new Error("child must not register command"); },
			on() { throw new Error("child must not clear inherited mode"); },
		});
		assert.equal(process.env.PI_NON_INTERACTIVE, "1");
	} finally {
		if (priorChild === undefined) delete process.env.PI_SUBAGENT_CHILD;
		else process.env.PI_SUBAGENT_CHILD = priorChild;
		if (priorFlag === undefined) delete process.env.PI_NON_INTERACTIVE;
		else process.env.PI_NON_INTERACTIVE = priorFlag;
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
