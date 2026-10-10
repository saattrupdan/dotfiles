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
const { dispatchAsk } = await jiti.import(path.join(root, "..", "question", "index.ts"), { default: false });
const statuses = new Map();
const context = {
	ui: { setStatus(key, value) { statuses.set(key, value); } },
	isIdle: () => true,
};

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
			void listeners.get("input")({ source: "extension" }, context);
		},
	};

	try {
		nonInteractive(pi);
		await command("  finish the job  ", context);
		assert.equal(statuses.get("non-interactive"), "🙊");
		assert.match(queued.content, /NON-INTERACTIVE MODE:.*\n\nfinish the job$/s);
		assert.deepEqual(queued.options, { deliverAs: "steer" });
		assert.equal(process.env.PI_NON_INTERACTIVE, "1");
		await listeners.get("agent_end")({}, context);
		assert.equal(process.env.PI_NON_INTERACTIVE, undefined);
		assert.equal(statuses.get("non-interactive"), undefined);
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
		setLoopActive(true, context);
		assert.equal(process.env.PI_NON_INTERACTIVE, "1");
		assert.equal(statuses.get("non-interactive"), "🙊");
		await listeners.get("input")({ source: "extension" }, context);
		await listeners.get("agent_start")({}, context);
		await listeners.get("agent_end")({}, context);
		assert.equal(process.env.PI_NON_INTERACTIVE, "1");
		setLoopActive(false, context);
		assert.equal(process.env.PI_NON_INTERACTIVE, undefined);
		assert.equal(statuses.get("non-interactive"), undefined);
	} finally {
		setLoopActive(false, context);
		if (previous === undefined) delete process.env.PI_NON_INTERACTIVE;
		else process.env.PI_NON_INTERACTIVE = previous;
	}
});

test("/non-interactive off restores questions during a running turn", async () => {
	const previous = process.env.PI_NON_INTERACTIVE;
	const messages = [];
	const sent = [];
	let command;
	let asked = false;
	const pi = {
		registerCommand(_name, definition) { command = definition.handler; },
		on() {},
		sendMessage(message) { messages.push(message); },
		sendUserMessage(content, options) { sent.push({ content, options }); },
	};
	const ui = {
		async input() { asked = true; return "yes"; },
	};
	try {
		nonInteractive(pi);
		process.env.PI_NON_INTERACTIVE = "1";
		assert.match((await dispatchAsk({ hasUI: true, ui }, [{ question: "Continue?" }])).error, /questions disabled/);
		assert.equal(asked, false);
		await command(" off ", { ...context, isIdle: () => false });
		assert.equal(process.env.PI_NON_INTERACTIVE, undefined);
		assert.equal(statuses.get("non-interactive"), undefined);
		assert.match(messages.at(-1).content, /Interactive mode enabled/);
		assert.match(sent.at(-1).content, /question tool/);
		assert.deepEqual(sent.at(-1).options, { deliverAs: "steer" });
		assert.deepEqual((await dispatchAsk({ hasUI: true, ui }, [{ question: "Continue?" }])).answers, ["yes"]);
		assert.equal(asked, true);
	} finally {
		if (previous === undefined) delete process.env.PI_NON_INTERACTIVE;
		else process.env.PI_NON_INTERACTIVE = previous;
	}
});

test("/non-interactive off at idle does not start a turn", async () => {
	const previous = process.env.PI_NON_INTERACTIVE;
	let command;
	const pi = {
		registerCommand(_name, definition) { command = definition.handler; },
		on() {},
		sendMessage() {},
		sendUserMessage() { throw new Error("off at idle must not start a turn"); },
	};
	try {
		nonInteractive(pi);
		process.env.PI_NON_INTERACTIVE = "1";
		await command("off", context);
		assert.equal(process.env.PI_NON_INTERACTIVE, undefined);
	} finally {
		if (previous === undefined) delete process.env.PI_NON_INTERACTIVE;
		else process.env.PI_NON_INTERACTIVE = previous;
	}
});

test("/non-interactive off cannot override an active loop", async () => {
	const previous = process.env.PI_NON_INTERACTIVE;
	let command;
	let message;
	const pi = {
		registerCommand(_name, definition) { command = definition.handler; },
		on() {},
		sendMessage(value) { message = value; },
		sendUserMessage() { throw new Error("must not steer while loop is active"); },
	};
	try {
		nonInteractive(pi);
		setLoopActive(true, context);
		await command("off", { ...context, isIdle: () => false });
		assert.equal(process.env.PI_NON_INTERACTIVE, "1");
		assert.equal(statuses.get("non-interactive"), "🙊");
		assert.match(message.content, /loop stop/);
	} finally {
		setLoopActive(false, context);
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
		await command("run", context);
		assert.deepEqual(options, { deliverAs: "steer" });
	} finally {
		if (previous === undefined) delete process.env.PI_NON_INTERACTIVE;
		else process.env.PI_NON_INTERACTIVE = previous;
	}
});
