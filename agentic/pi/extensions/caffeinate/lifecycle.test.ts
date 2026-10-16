import assert from "node:assert/strict";
import { test } from "node:test";
import { PowerLifecycle } from "./lifecycle.ts";

function harness() {
	let engaged = false;
	const changes: string[] = [];
	const lifecycle = new PowerLifecycle<string>(
		() => { if (!engaged) changes.push("engage"); engaged = true; },
		() => { if (engaged) changes.push("release"); engaged = false; },
	);
	return { lifecycle, changes };
}

test("a loop holds power through waits and checks, then releases on completion", () => {
	const h = harness();
	h.lifecycle.loopChanged(true, "session");
	h.lifecycle.agentStarted("session");
	h.lifecycle.agentEnded("session");
	assert.deepEqual(h.changes, ["engage"]);
	h.lifecycle.loopChanged(false, "session");
	assert.deepEqual(h.changes, ["engage", "release"]);
});

test("a stopped loop keeps the hold until its current run finishes", () => {
	const h = harness();
	h.lifecycle.loopChanged(true, "session");
	h.lifecycle.agentStarted("session");
	h.lifecycle.loopChanged(false, "session");
	assert.deepEqual(h.changes, ["engage"]);
	h.lifecycle.agentEnded("session");
	assert.deepEqual(h.changes, ["engage", "release"]);
});

test("ordinary runs release at agent_end and stopping releases immediately", () => {
	const h = harness();
	h.lifecycle.agentStarted("session");
	h.lifecycle.agentEnded("session");
	assert.deepEqual(h.changes, ["engage", "release"]);
	h.lifecycle.agentStarted("session");
	h.lifecycle.stop("session");
	assert.deepEqual(h.changes, ["engage", "release", "engage", "release"]);
});
