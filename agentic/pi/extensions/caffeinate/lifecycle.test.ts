import assert from "node:assert/strict";
import { test } from "node:test";
import { PowerLifecycle } from "./lifecycle.ts";

function harness(closed = true) {
	let engaged = false;
	let timer: (() => void) | undefined;
	const changes: string[] = [];
	const lifecycle = new PowerLifecycle<string>(
		() => { if (!engaged) changes.push("engage"); engaged = true; },
		() => { if (engaged) changes.push("release"); engaged = false; },
		() => engaged,
		() => closed,
		((callback: () => void) => { timer = callback; return 1; }) as typeof setInterval,
		(() => { timer = undefined; }) as typeof clearInterval,
	);
	return { lifecycle, changes, setClosed: (value: boolean) => { closed = value; }, tick: () => timer?.(), hasTimer: () => timer !== undefined };
}

test("a loop holds power through waits, checks, and closed-lid completion", () => {
	const h = harness();
	h.lifecycle.loopChanged(true, "session");
	h.lifecycle.agentStarted("session");
	h.lifecycle.agentEnded("session");
	assert.deepEqual(h.changes, ["engage"]);
	h.lifecycle.loopChanged(false, "session");
	assert.deepEqual(h.changes, ["engage"]);
	assert.equal(h.hasTimer(), true);
	h.tick();
	assert.deepEqual(h.changes, ["engage"]);
	h.setClosed(false);
	h.tick();
	assert.deepEqual(h.changes, ["engage", "release"]);
	assert.equal(h.hasTimer(), false);
});

test("stop during a run waits for its end; open lid and shutdown release promptly", () => {
	const h = harness();
	h.lifecycle.loopChanged(true, "session");
	h.lifecycle.agentStarted("session");
	h.lifecycle.loopChanged(false, "session");
	assert.deepEqual(h.changes, ["engage"]);
	h.lifecycle.agentEnded("session");
	assert.equal(h.hasTimer(), true);
	h.lifecycle.stop("session"); // /caffeinate off or shutdown
	assert.deepEqual(h.changes, ["engage", "release"]);
	assert.equal(h.hasTimer(), false);

	const open = harness(false);
	open.lifecycle.loopChanged(true, "session");
	open.lifecycle.loopChanged(false, "session");
	assert.deepEqual(open.changes, ["engage", "release"]);
	assert.equal(open.hasTimer(), false);
});

test("ordinary runs release at agent_end without a loop", () => {
	const h = harness();
	h.lifecycle.agentStarted("session");
	h.lifecycle.agentEnded("session");
	assert.deepEqual(h.changes, ["engage", "release"]);
});
