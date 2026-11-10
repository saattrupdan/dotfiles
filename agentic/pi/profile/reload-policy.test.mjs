import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
	prepareProfileReload,
	profileResumeArgs,
	profileReloadEnabled,
	profileReloadEnvironment,
} from "./reload.mjs";
import { requestProfileReload } from "./reload-extension.mjs";
import { resolvePiPackage } from "./pi-runtime.mjs";
import { pathToFileURL } from "node:url";

const state = {
	mode: "tui",
	cwd: process.cwd(),
	sessionFile: "/tmp/saved.jsonl",
	sessionId: "fixture-id",
	saved: true,
	leafId: "leaf",
	tipId: "leaf",
	model: { provider: "fixture", id: "selected" },
	thinking: "high",
};
const profile = { name: "main", tools: ["a"], skills: [], extensions: [], systemPrompt: "old" };
const changed = { ...profile, tools: ["b"], systemPrompt: "new" };
const identity = { profile, userArgs: [], cwd: process.cwd(), agentDir: "/tmp/agent", env: {} };
const build = (_p, _dir, args) => ["generated", ...args];

test("resume strips old selectors and input, preserves aliases, overrides and string flags", () => {
	const args = profileResumeArgs(
		[
			"--continue",
			"--session=old",
			"--fork",
			"forked",
			"--session-id",
			"old-id",
			"-t",
			"bash,read",
			"--skill",
			"./skills",
			"--system-prompt",
			"Literal prompt",
			"--custom",
			"value",
			"--boolean",
			"startup input",
			"@secret.png",
			"--",
			"--literal prompt",
		],
		{ ...state, stringFlags: ["--custom"], name: "Renamed" },
		"/tmp/original",
	);
	assert.deepEqual(args, [
		"-t",
		"bash,read",
		"--skill",
		"/tmp/original/skills",
		"--system-prompt",
		"Literal prompt",
		"--custom",
		"value",
		"--boolean",
		"--session",
		"/tmp/saved.jsonl",
		"--name",
		"Renamed",
	]);
	assert.equal(profileReloadEnabled(["-ne"]), false);
	assert.equal(profileReloadEnabled(["--no-extensions"]), false);
});

test("resume options retain native name alias and TUI-mode arity", async () => {
	const { parseArgs } = await import(
		pathToFileURL(path.join(resolvePiPackage(), "dist/cli/args.js")).href
	);
	const resumed = parseArgs(
		profileResumeArgs(
			["-n", "Original name", "--tui-mode", "regular"],
			{ ...state, name: "Live name" },
			process.cwd(),
		),
	);
	assert.equal(resumed.session, state.sessionFile);
	assert.equal(resumed.name, "Live name");
	assert.equal(resumed.tuiMode, "regular");
	assert.deepEqual(resumed.messages, []);
	assert.deepEqual(resumed.diagnostics, []);
});

test("reload environment discards startup actions and preserves persistent metadata", () => {
	const original = {
		PI_LOOP_HANDOFF: "once",
		PI_WORKTREE_BRANCH_CONTINUATION: "1",
		PI_WORKTREE_CLEANUP_CONTINUATION: "1",
		PI_WORKTREE_LOOP_RETURN_CONTINUATION: "1",
		PI_PROFILE_RELOAD_REPLACING: "1",
		PI_WORKTREE_SESSION_MANIFEST: "/owned/manifest",
		PI_WORKTREE_ISOLATION_DISABLE: "1",
		HOME: "/home/test",
	};
	assert.deepEqual(profileReloadEnvironment(original), {
		PI_WORKTREE_SESSION_MANIFEST: "/owned/manifest",
		PI_WORKTREE_ISOLATION_DISABLE: "1",
		HOME: "/home/test",
	});
	assert.equal(original.PI_LOOP_HANDOFF, "once");
	assert.equal(profileReloadEnabled(["--", "--no-extensions"]), true);
});

test("unchanged profiles do not require a persistent session or new flags", () => {
	assert.equal(prepareProfileReload(identity, profile, undefined, build), undefined);
});

test("resource-only reload preserves live model and thinking without replaying input", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "reload-policy-"));
	try {
		const file = path.join(root, "saved.jsonl");
		fs.writeFileSync(file, "saved");
		const plan = prepareProfileReload(
			{ ...identity, userArgs: ["startup input"] },
			changed,
			{ ...state, sessionFile: file },
			build,
		);
		assert.deepEqual(plan.built, [
			"generated",
			"--session",
			file,
			"--provider",
			"fixture",
			"--model",
			"selected",
			"--thinking",
			"high",
		]);
		const modelPlan = prepareProfileReload(
			identity,
			{ ...changed, model: ["new-default"] },
			{ ...state, sessionFile: file },
			build,
		);
		assert.ok(!modelPlan.built.includes("selected"));
		const explicit = prepareProfileReload(
			{ ...identity, userArgs: ["--model", "original"] },
			{ ...changed, model: ["new-default"] },
			{ ...state, sessionFile: file },
			build,
		);
		assert.equal(explicit.built.at(-3), "selected");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("in-memory, unpersisted messages, old branches fail before building", () => {
	const fail = () => assert.fail("must reject before constructing launch flags");
	assert.throws(
		() => prepareProfileReload(identity, changed, { ...state, mode: "rpc" }, fail),
		/outside the TUI/,
	);
	assert.throws(
		() => prepareProfileReload(identity, changed, { ...state, sessionFile: undefined }, fail),
		/in memory/,
	);
	assert.throws(
		() =>
			prepareProfileReload(
				identity,
				changed,
				{ ...state, sessionFile: "/missing-conversation", empty: false },
				fail,
			),
		/no saved file/,
	);
	assert.throws(
		() => prepareProfileReload(identity, changed, { ...state, leafId: "earlier" }, fail),
		/earlier branch/,
	);
});

test("empty persistent sessions retain their native ID without creating a transcript", () => {
	const plan = prepareProfileReload(
		identity,
		changed,
		{ ...state, sessionFile: "/missing-empty-conversation", empty: true },
		build,
	);
	assert.deepEqual(plan.args, ["--session-id", "fixture-id"]);
	assert.ok(!fs.existsSync("/missing-empty-conversation"));
});

function transport(send) {
	const t = new EventEmitter();
	t.env = { PI_PROFILE_RELOAD_TOKEN: "nonce" };
	t.send = send.bind(t);
	return t;
}

test("reload IPC authenticates replies and removes its listeners", async () => {
	const t = transport(function (message, done) {
		done?.();
		if (message.type === "pi-profile-reload-request") {
			queueMicrotask(() => {
				this.emit("message", {
					type: "pi-profile-reload-result",
					id: message.id,
					token: "wrong",
					status: "restart",
				});
				this.emit("message", {
					type: "pi-profile-reload-result",
					id: message.id,
					token: "nonce",
					status: "unchanged",
				});
			});
		}
	});
	assert.equal((await requestProfileReload(state, t, 100)).status, "unchanged");
	assert.equal(t.listenerCount("message"), 0);
	assert.equal(t.listenerCount("disconnect"), 0);
});

test("IPC timeout cancels the plan and disconnect/send failures leave no handlers", async () => {
	const sent = [];
	const t = transport(function (message, done) {
		sent.push(message);
		done?.();
	});
	await assert.rejects(requestProfileReload(state, t, 10), /timed out/);
	assert.equal(sent.at(-1).type, "pi-profile-reload-cancel");
	assert.equal(t.listenerCount("message"), 0);
	const disconnected = transport(function (_m, done) {
		done?.();
		queueMicrotask(() => this.emit("disconnect"));
	});
	await assert.rejects(requestProfileReload(state, disconnected, 100), /disconnected/);
	const failed = transport(function () {
		throw new Error("send failure");
	});
	await assert.rejects(requestProfileReload(state, failed, 100), /send failure/);
	assert.equal(failed.listenerCount("disconnect"), 0);
});
