import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import conversationName from "./index.ts";

type Handler = (event: { message: { role: string; content: string } }, ctx: unknown) => Promise<void>;

function harness(initialName = "") {
	let handler: Handler | undefined;
	let shutdown: (() => void) | undefined;
	let name = initialName;
	let sessionId = "session-1";
	const prompts: string[] = [];
	const names: string[] = [];
	const responses: Array<(value: { code: number; stdout: string }) => void> = [];
	const pi = {
		on: (event: string, callback: Handler | (() => void)) => {
			if (event === "message_end") handler = callback as Handler;
			if (event === "session_shutdown") shutdown = callback as () => void;
		},
		exec: (_command: string, args: string[]) => {
			prompts.push(args.at(-1) ?? "");
			return new Promise<{ code: number; stdout: string }>((resolve) => { responses.push(resolve); });
		},
		setSessionName: (value: string) => { name = value; names.push(value); },
	} as unknown as ExtensionAPI;
	conversationName(pi);
	const ctx = {
		cwd: "/tmp",
		sessionManager: {
			getSessionId: () => sessionId,
			getSessionName: () => name,
		},
	};
	return {
		prompts, names, responses,
		shutdown: () => shutdown?.(),
		get name() { return name; },
		set sessionId(value: string) { sessionId = value; },
		message: async (content: string) => {
			assert.ok(handler);
			await handler({ message: { role: "user", content } }, ctx);
		},
	};
}

async function flush() {
	await new Promise((resolve) => setImmediate(resolve));
}

test("updates the title after every user message with bounded context", async () => {
	const app = harness();
	await app.message("Fix the conversation title");
	assert.equal(app.responses.length, 1);
	app.responses.shift()?.({ code: 0, stdout: "Fixing Conversation Title" });
	await flush();
	assert.equal(app.name, "Fixing Conversation Title");

	await app.message(`Now update it for the latest topic ${"x".repeat(2_000)}`);
	assert.equal(app.responses.length, 1);
	assert.match(app.prompts[1], /Current session title: Fixing Conversation Title/);
	assert.match(app.prompts[1], /Latest user message: Now update it/);
	assert.ok(app.prompts[1].split("Latest user message: ")[1].length <= 1_000);
	app.responses.shift()?.({ code: 0, stdout: "Updating Latest Topic" });
	await flush();
	assert.deepEqual(app.names, ["Fixing Conversation Title", "Updating Latest Topic"]);
});

test("frames a follow-up bug fix within the existing feature task", async () => {
	const app = harness("Implementing Search Feature");
	await app.message("Fix the filter bug from the search implementation");
	assert.equal(app.responses.length, 1);
	assert.match(app.prompts[0], /using both the current title and latest user message/);
	assert.match(app.prompts[0], /overarching task, not only the latest step/);
	assert.match(app.prompts[0], /small bug fixes, tests, or refinements/);
	assert.match(app.prompts[0], /Only change the topic when the user starts a genuinely different task/);
	assert.match(app.prompts[0], /Current session title: Implementing Search Feature/);
	assert.match(app.prompts[0], /Latest user message: Fix the filter bug from the search implementation/);
	app.responses.shift()?.({ code: 0, stdout: "Implementing Search Feature" });
	await flush();
	assert.equal(app.name, "Implementing Search Feature");
});

test("only applies the newest message when naming calls overlap", async () => {
	const app = harness("Old Topic");
	await app.message("First change");
	await app.message("Second change");
	await app.message("Final change");
	assert.equal(app.responses.length, 1);
	app.responses.shift()?.({ code: 0, stdout: "First Change" });
	await flush();
	assert.deepEqual(app.names, []);
	assert.equal(app.responses.length, 1);
	assert.match(app.prompts[1], /Latest user message: Final change/);
	app.responses.shift()?.({ code: 0, stdout: "Final Change" });
	await flush();
	assert.deepEqual(app.names, ["Final Change"]);
});

test("keeps an existing title if refresh generation fails", async () => {
	const app = harness("Useful Existing Topic");
	await app.message("What about that?");
	for (let attempt = 0; attempt < 3; attempt++) {
		app.responses.shift()?.({ code: 1, stdout: "" });
		await flush();
	}
	assert.deepEqual(app.names, []);
	assert.equal(app.name, "Useful Existing Topic");
});

test("discards a result after the session shuts down", async () => {
	const app = harness();
	await app.message("Naming session before shutdown");
	app.shutdown();
	app.responses.shift()?.({ code: 0, stdout: "Old Session" });
	await flush();
	assert.deepEqual(app.names, []);
});

test("never applies a result to a different session", async () => {
	const app = harness();
	await app.message("Naming original session");
	app.sessionId = "session-2";
	app.responses.shift()?.({ code: 0, stdout: "Original Session" });
	await flush();
	assert.deepEqual(app.names, []);
});

test("subagents keep their inherited label without calling the model", async () => {
	const previous = process.env.PI_SUBAGENT_SESSION_NAME;
	process.env.PI_SUBAGENT_SESSION_NAME = "builder1: Fix parser";
	try {
		const app = harness();
		await app.message("Long task specification");
		await app.message("Follow-up");
		assert.deepEqual(app.names, ["builder1: Fix parser"]);
		assert.deepEqual(app.prompts, []);
	} finally {
		if (previous === undefined) delete process.env.PI_SUBAGENT_SESSION_NAME;
		else process.env.PI_SUBAGENT_SESSION_NAME = previous;
	}
});
